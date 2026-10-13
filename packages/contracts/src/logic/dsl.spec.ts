import { describe, expect, it } from 'vitest';
import {
  dslTimerThresholds,
  evaluateDslCondition,
  evaluateDslPipeline,
  sortDslTriggers,
  validateDslDefinition,
  validateDslSnapshot,
  type DslDefinition,
  type DslTriggerSpec,
} from './dsl';

const SALES = '11111111-1111-4111-8111-111111111111';
const SUPPORT = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';

function def(partial: Partial<DslDefinition> & Pick<DslDefinition, 'actions'>): DslDefinition {
  const r = validateDslDefinition({ dsl_version: 1, event: 'chat.requested', priority: 100, all: [], any: [], stop_processing: false, cooldown_seconds: 0, ...partial });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.definition;
}

function spec(id: string, d: DslDefinition, createdAt = 0, revision = 1): DslTriggerSpec {
  return { id, revision, createdAt, definition: d };
}

describe('validateDslDefinition', () => {
  it('accepts the ch. 32 contract example and makes defaults explicit', () => {
    const r = validateDslDefinition(
      {
        dsl_version: 1,
        event: 'chat.requested',
        priority: 100,
        all: [
          { field: 'page.path', op: 'starts_with', value: '/pricing' },
          { field: 'schedule.is_open', op: 'eq', value: true },
        ],
        any: [],
        actions: [
          { type: 'set_department', department_id: SALES },
          { type: 'add_tag', tag: 'pricing' },
        ],
        stop_processing: true,
        cooldown_seconds: 0,
      },
      { departmentIds: [SALES, SUPPORT] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition.actions[1]).toEqual({ type: 'add_tag', tag: 'pricing', target: 'chat' });
    expect(r.definition.stop_processing).toBe(true);
  });

  it('rejects unknown keys at every level', () => {
    const r = validateDslDefinition({
      dsl_version: 1,
      event: 'chat.requested',
      priority: 1,
      all: [{ field: 'page.path', op: 'eq', value: '/x', extra: 1 }],
      actions: [{ type: 'add_tag', tag: 'x', color: 'red' }],
      surprise: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = r.issues.map((i) => `${i.path}:${i.code}`);
    expect(codes).toContain('surprise:unknown_key');
    expect(codes).toContain('all.0.extra:unknown_key');
    expect(codes).toContain('actions.0.color:unknown_key');
  });

  it('rejects unknown operators, illegal operator/type pairs and non-finite numbers (TRIG02)', () => {
    const bad = (cond: unknown) => validateDslDefinition({ dsl_version: 1, event: 'chat.requested', priority: 1, all: [cond], actions: [{ type: 'add_tag', tag: 'x' }] });
    expect(bad({ field: 'page.path', op: 'matches', value: '.*' }).ok).toBe(false);
    expect(bad({ field: 'page.path', op: 'gt', value: 3 }).ok).toBe(false);
    expect(bad({ field: 'eligible_agent_count', op: 'contains', value: '1' }).ok).toBe(false);
    expect(bad({ field: 'eligible_agent_count', op: 'gt', value: '1' }).ok).toBe(false);
    expect(bad({ field: 'eligible_agent_count', op: 'gt', value: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(bad({ field: 'visitor.verified', op: 'starts_with', value: 't' }).ok).toBe(false);
    expect(bad({ field: 'chat.status', op: 'eq', value: 'sleeping' }).ok).toBe(false);
    expect(bad({ field: 'visitor.email', op: 'eq', value: 'a@b.c' }).ok).toBe(false);
    expect(bad({ field: 'page.path', op: 'exists', value: 'x' }).ok).toBe(false);
    expect(bad({ field: 'page.path', op: 'eq', value: 'x'.repeat(2001) }).ok).toBe(false);
    expect(bad({ all: [{ field: 'page.path', op: 'eq', value: '/' }] }).ok).toBe(false);
  });

  it('rejects fields and actions that the event cannot provide', () => {
    const r = validateDslDefinition({
      dsl_version: 1,
      event: 'visitor.page.changed',
      priority: 1,
      all: [{ field: 'chat.wait_seconds', op: 'gt', value: 10 }],
      actions: [{ type: 'set_department', department_id: SALES }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['field_unavailable', 'action_unavailable']));
  });

  it('rejects cross-tenant references when tenant context is supplied', () => {
    const r = validateDslDefinition(
      { dsl_version: 1, event: 'chat.requested', priority: 1, all: [{ field: 'department.id', op: 'in', value: [SALES, FOREIGN] }], actions: [{ type: 'set_department', department_id: FOREIGN }] },
      { departmentIds: [SALES, SUPPORT] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.filter((i) => i.code === 'unknown_reference').map((i) => i.path).sort()).toEqual(['actions.0.department_id', 'all.0.value']);
  });

  it('enforces action and condition limits', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ type: 'create_webhook_job', event_name: `e${i}` }));
    expect(validateDslDefinition({ dsl_version: 1, event: 'chat.requested', priority: 1, all: [], actions: many }).ok).toBe(false);
    const conds = Array.from({ length: 51 }, () => ({ field: 'page.path', op: 'exists' }));
    expect(validateDslDefinition({ dsl_version: 1, event: 'chat.requested', priority: 1, all: conds, actions: [{ type: 'add_tag', tag: 'x' }] }).ok).toBe(false);
    expect(validateDslDefinition({ dsl_version: 1, event: 'chat.requested', priority: 1001, all: [], actions: [{ type: 'add_tag', tag: 'x' }] }).ok).toBe(false);
    expect(validateDslDefinition({ dsl_version: 2, event: 'chat.requested', priority: 1, all: [], actions: [{ type: 'add_tag', tag: 'x' }] }).ok).toBe(false);
    expect(validateDslDefinition({ dsl_version: 1, event: 'chat.requested', priority: 1, all: [], actions: [] }).ok).toBe(false);
  });

  it('rejects conflicting writes inside one trigger', () => {
    const r = validateDslDefinition({
      dsl_version: 1,
      event: 'chat.requested',
      priority: 1,
      all: [],
      actions: [
        { type: 'set_department', department_id: SALES },
        { type: 'set_department', department_id: SUPPORT },
        { type: 'add_tag', tag: 'vip' },
        { type: 'remove_tag', tag: 'vip' },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.filter((i) => i.code === 'conflicting_write').map((i) => i.path)).toEqual(['actions.1', 'actions.3']);
    const blockAndGreet = validateDslDefinition({ dsl_version: 1, event: 'chat.requested', priority: 1, all: [], actions: [{ type: 'block_admission' }, { type: 'send_public_message', text: 'hi' }] });
    expect(blockAndGreet.ok).toBe(false);
  });

  it('only allows trusted custom fields', () => {
    const ctx = { customFields: { plan: { type: 'string' as const, trusted: true }, nickname: { type: 'string' as const, trusted: false } } };
    const ok = validateDslDefinition({ dsl_version: 1, event: 'chat.requested', priority: 1, all: [{ field: 'custom.plan', op: 'eq', value: 'gold' }], actions: [{ type: 'add_tag', tag: 'gold' }] }, ctx);
    expect(ok.ok).toBe(true);
    const untrusted = validateDslDefinition({ dsl_version: 1, event: 'chat.requested', priority: 1, all: [{ field: 'custom.nickname', op: 'eq', value: 'x' }], actions: [{ type: 'add_tag', tag: 'x' }] }, ctx);
    expect(untrusted.ok).toBe(false);
  });
});

describe('evaluateDslCondition — missing-field semantics (TRIG02)', () => {
  it('missing field fails every operator except missing; neq on missing is false', () => {
    const snap = {};
    for (const [op, value] of [
      ['eq', 'US'],
      ['neq', 'US'],
      ['contains', 'U'],
      ['starts_with', 'U'],
      ['ends_with', 'S'],
      ['in', ['US']],
      ['not_in', ['US']],
      ['exists', undefined],
    ] as const) {
      expect(evaluateDslCondition({ field: 'visitor.country', op, ...(value !== undefined ? { value: value as never } : {}) }, snap).result).toBe(false);
    }
    expect(evaluateDslCondition({ field: 'visitor.country', op: 'missing' }, snap).result).toBe(true);
    expect(evaluateDslCondition({ field: 'visitor.country', op: 'neq', value: 'US' }, { 'visitor.country': null }).result).toBe(false);
  });

  it('type mismatches never match', () => {
    const t = evaluateDslCondition({ field: 'eligible_agent_count', op: 'gt', value: 0 }, { eligible_agent_count: '3' });
    expect(t.result).toBe(false);
    expect(t.error).toBe('type_mismatch');
  });

  it('compares strings, lists, numbers and ids', () => {
    expect(evaluateDslCondition({ field: 'page.path', op: 'starts_with', value: '/pricing' }, { 'page.path': '/pricing/team' }).result).toBe(true);
    expect(evaluateDslCondition({ field: 'message.text', op: 'contains', value: 'refund', ignore_case: true }, { 'message.text': 'I want a REFUND' }).result).toBe(true);
    expect(evaluateDslCondition({ field: 'message.text', op: 'contains', value: 'refund' }, { 'message.text': 'I want a REFUND' }).result).toBe(false);
    expect(evaluateDslCondition({ field: 'visitor.tags', op: 'contains', value: 'vip' }, { 'visitor.tags': ['vip', 'beta'] }).result).toBe(true);
    expect(evaluateDslCondition({ field: 'visitor.tags', op: 'not_in', value: ['spam'] }, { 'visitor.tags': [] }).result).toBe(true);
    expect(evaluateDslCondition({ field: 'page.visible_dwell_seconds', op: 'gte', value: 30 }, { 'page.visible_dwell_seconds': 30 }).result).toBe(true);
    expect(evaluateDslCondition({ field: 'department.id', op: 'eq', value: SALES }, { 'department.id': SALES.toUpperCase() }).result).toBe(true);
  });
});

describe('evaluateDslPipeline — precedence and execution (TRIG01/TRIG03)', () => {
  const snapshot = { 'page.path': '/pricing', 'schedule.is_open': true, eligible_agent_count: 2 };

  it('orders by priority desc, created_at asc, id asc (priority ties)', () => {
    const d = def({ actions: [{ type: 'add_tag', tag: 'a' } as never] });
    const sorted = sortDslTriggers([spec('b', d, 10), spec('a', d, 10), spec('c', { ...d, priority: 500 }, 99), spec('z', d, 5)]);
    expect(sorted.map((t) => t.id)).toEqual(['c', 'z', 'a', 'b']);
  });

  it('stop_processing on a matched trigger stops collection; first set_department wins', () => {
    const high = def({ priority: 500, all: [{ field: 'page.path', op: 'starts_with', value: '/pricing' }], actions: [{ type: 'set_department', department_id: SALES } as never, { type: 'add_tag', tag: 'pricing' } as never] });
    const mid = def({ priority: 300, actions: [{ type: 'set_department', department_id: SUPPORT } as never, { type: 'add_tag', tag: 'mid' } as never], stop_processing: true });
    const low = def({ priority: 100, actions: [{ type: 'add_tag', tag: 'low' } as never] });
    const r = evaluateDslPipeline({ event: 'chat.requested', snapshot, now: 0, triggers: [spec('low', low), spec('mid', mid), spec('high', high)] });
    expect(r.triggers.map((t) => [t.triggerId, t.reason])).toEqual([
      ['high', 'fired'],
      ['mid', 'fired'],
      ['low', 'after_stop'],
    ]);
    expect(r.stoppedBy).toBe('mid');
    expect(r.effects.map((e) => `${e.triggerId}:${e.action.type}`)).toEqual(['high:set_department', 'high:add_tag', 'mid:add_tag']);
    expect(r.suppressed).toEqual([{ triggerId: 'mid', revision: 1, actionIndex: 0, type: 'set_department', reason: 'department_already_set' }]);
  });

  it('stop_processing on a non-matching trigger does not stop evaluation; any-group semantics', () => {
    const gate = def({ priority: 900, all: [{ field: 'page.path', op: 'eq', value: '/nope' }], actions: [{ type: 'add_tag', tag: 'gate' } as never], stop_processing: true });
    const anyOf = def({
      priority: 100,
      any: [
        { field: 'eligible_agent_count', op: 'eq', value: 0 },
        { field: 'page.path', op: 'contains', value: 'pric' },
      ],
      actions: [{ type: 'add_tag', tag: 'any' } as never],
    });
    const r = evaluateDslPipeline({ event: 'chat.requested', snapshot, now: 0, triggers: [spec('gate', gate), spec('any', anyOf)] });
    expect(r.triggers.find((t) => t.triggerId === 'any')?.fired).toBe(true);
    expect(r.triggers.find((t) => t.triggerId === 'any')?.any.map((c) => c.result)).toEqual([false, true]);
  });

  it('uses one immutable snapshot: earlier actions do not change later matching', () => {
    const tagger = def({ priority: 500, actions: [{ type: 'add_tag', tag: 'vip', target: 'visitor' } as never] });
    const needsVip = def({ priority: 100, all: [{ field: 'visitor.tags', op: 'contains', value: 'vip' }], actions: [{ type: 'add_tag', tag: 'second', target: 'visitor' } as never] });
    const input = { event: 'chat.requested' as const, snapshot: { 'visitor.tags': [] as string[] }, now: 0, triggers: [spec('tagger', tagger), spec('needs', needsVip)] };
    const r = evaluateDslPipeline(input);
    expect(r.triggers.find((t) => t.triggerId === 'needs')?.reason).toBe('conditions_false');
    expect(input.snapshot['visitor.tags']).toEqual([]);
  });

  it('a single invitation is selected when two campaigns match the same event', () => {
    const invite = (priority: number, message: string) =>
      def({ event: 'visitor.timer.elapsed', priority, actions: [{ type: 'display_invitation', message } as never] });
    const r = evaluateDslPipeline({ event: 'visitor.timer.elapsed', snapshot, now: 0, triggers: [spec('generic', invite(100, 'Hi')), spec('pricing', invite(200, 'Questions about pricing?'))] });
    expect(r.effects.map((e) => e.triggerId)).toEqual(['pricing']);
    expect(r.suppressed[0]).toMatchObject({ triggerId: 'generic', reason: 'invitation_already_selected' });
  });

  it('cooldown suppresses a matching trigger until it expires', () => {
    const d = def({ cooldown_seconds: 60, actions: [{ type: 'add_tag', tag: 'x' } as never] });
    const base = { event: 'chat.requested' as const, snapshot, triggers: [spec('t', d)] };
    expect(evaluateDslPipeline({ ...base, now: 30_000, lastFiredAt: { t: 0 } }).triggers[0].reason).toBe('cooldown');
    expect(evaluateDslPipeline({ ...base, now: 60_000, lastFiredAt: { t: 0 } }).triggers[0].reason).toBe('fired');
    expect(evaluateDslPipeline({ ...base, now: 30_000 }).triggers[0].reason).toBe('fired');
  });

  it('block_admission is terminal and suppresses routing and visitor-facing actions', () => {
    const greet = def({ priority: 900, actions: [{ type: 'send_public_message', text: 'Hello' } as never, { type: 'add_tag', tag: 'greeted' } as never] });
    const block = def({ priority: 500, all: [{ field: 'visitor.tags', op: 'contains', value: 'spam' }], actions: [{ type: 'block_admission' } as never] });
    const later = def({ priority: 100, actions: [{ type: 'add_tag', tag: 'later' } as never] });
    const r = evaluateDslPipeline({ event: 'chat.requested', snapshot: { 'visitor.tags': ['spam'] }, now: 0, triggers: [spec('greet', greet), spec('block', block), spec('later', later)] });
    expect(r.blocked).toBe(true);
    expect(r.effects.map((e) => e.action.type)).toEqual(['add_tag', 'block_admission']);
    expect(r.suppressed.map((s) => `${s.triggerId}:${s.reason}`)).toEqual(['greet:admission_blocked']);
    expect(r.triggers.find((t) => t.triggerId === 'later')?.reason).toBe('after_stop');
  });

  it('prevents recursion and enforces the causation depth limit', () => {
    const d = def({ actions: [{ type: 'add_tag', tag: 'x' } as never] });
    expect(evaluateDslPipeline({ event: 'chat.requested', snapshot, now: 0, triggers: [spec('t', d)], ancestors: ['t'] }).triggers[0].reason).toBe('recursion');
    expect(evaluateDslPipeline({ event: 'chat.requested', snapshot, now: 0, triggers: [spec('t', d)], depth: 4 }).triggers[0].reason).toBe('depth_limit');
    expect(evaluateDslPipeline({ event: 'chat.requested', snapshot, now: 0, triggers: [spec('t', d)], depth: 3 }).triggers[0].reason).toBe('fired');
  });

  it('is deterministic for repeated runs (simulator parity)', () => {
    const triggers = [spec('a', def({ priority: 5, actions: [{ type: 'add_tag', tag: 'a' } as never] }), 2), spec('b', def({ priority: 5, actions: [{ type: 'add_tag', tag: 'b' } as never] }), 1)];
    const a = evaluateDslPipeline({ event: 'chat.requested', snapshot, now: 1, triggers });
    const b = evaluateDslPipeline({ event: 'chat.requested', snapshot, now: 1, triggers: [...triggers].reverse() });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe('snapshots and timers', () => {
  it('validates simulator snapshots against the allowlist', () => {
    expect(validateDslSnapshot({ 'page.path': '/x', eligible_agent_count: 2, 'visitor.tags': ['a'] }).ok).toBe(true);
    expect(validateDslSnapshot({ 'visitor.email': 'x@y.z' }).ok).toBe(false);
    expect(validateDslSnapshot({ eligible_agent_count: 'two' }).ok).toBe(false);
    expect(validateDslSnapshot({ 'page.path': 'x'.repeat(2001) }).ok).toBe(false);
  });

  it('derives durable timer thresholds from dwell conditions', () => {
    const d = def({
      event: 'visitor.timer.elapsed',
      all: [
        { field: 'page.visible_dwell_seconds', op: 'gte', value: 30 },
        { field: 'session.time_on_site_seconds', op: 'gt', value: 59 },
      ],
      actions: [{ type: 'display_invitation', message: 'Hi' } as never],
    });
    expect(dslTimerThresholds(d)).toEqual({ page: [30], session: [60] });
  });
});
