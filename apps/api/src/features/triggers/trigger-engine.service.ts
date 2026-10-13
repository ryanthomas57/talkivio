import { Injectable, OnModuleInit } from '@nestjs/common';
import { ChatCommandsService } from '../chats/chat-commands.service';
import type { Prisma } from '@prisma/client';
import { dslTimerThresholds, evaluateDslPipeline, type DslEvaluation, type DslTriggerTrace } from '@talkivio/contracts';
import { TenantDb } from '../../db/tenant-db';
import { RedisService } from '../../common/redis.service';
import { fromWire } from '../../common/wire';
import { PresenceService } from '../../core/presence.service';
import { QueueService, QUEUES } from '../../core/queue.service';
import { EventConsumers } from '../../outbox/event-consumers';
import type { InternalEvent } from '../../outbox/outbox.publisher';
import { WorkerService } from '../../worker/worker.service';
import { isUniqueViolation, stableUuid } from './http-utils';
import { loadPublishedTriggers, type PublishedTrigger } from './trigger-repo';
import { TriggerEffectsService } from './trigger-effects.service';
import { redactSnapshot, TriggerSnapshotService, type DslEventContext } from './trigger-snapshot.service';

interface TimerData {
  tenantId: string;
  sessionId: string;
  visitorId: string;
  kind: 'page' | 'session';
  seconds: number;
  anchorId?: string;
  attempt?: number;
}

const TIMER_JOB = 'trigger.timer';
const SESSION_STARTED_JOB = 'trigger.session-started';
const TIMER_OPTS = { attempts: 5, backoff: { type: 'exponential' as const, delay: 2000 }, removeOnComplete: { age: 6 * 3600, count: 10_000 }, removeOnFail: { age: 7 * 86_400 } };
const MAX_TIMER_RESCHEDULES = 20;

/** Stable ids for engine-synthesised events so every retry/duplicate maps to the same trigger runs. */
export const sessionStartedEventId = (sessionId: string) => stableUuid(`visitor.session.started:${sessionId}`);
export const timerEventId = (d: Pick<TimerData, 'kind' | 'sessionId' | 'anchorId' | 'seconds'>) =>
  stableUuid(`visitor.timer.elapsed:${d.kind}:${d.kind === 'page' ? d.anchorId : d.sessionId}:${d.seconds}`);

/**
 * Production trigger engine (worker): consumes committed outbox events and
 * durable timers, builds one authoritative snapshot per event, runs the shared
 * DSL interpreter and records trigger_runs / trigger_effects idempotently.
 */
@Injectable()
export class TriggerEngine implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly consumers: EventConsumers,
    private readonly worker: WorkerService,
    private readonly queues: QueueService,
    private readonly presence: PresenceService,
    private readonly redis: RedisService,
    private readonly snapshots: TriggerSnapshotService,
    private readonly effects: TriggerEffectsService,
    private readonly chats: ChatCommandsService,
  ) {}

  onModuleInit(): void {
    this.chats.registerAdmissionGuard(async (v, input) => {
      const r = await this.admissionCheck({ tenantId: v.tenantId, siteId: v.siteId, visitorId: v.visitorId, sessionId: v.sessionId }, input);
      return { blocked: r.blocked, source: r.triggerId ? `trigger ${r.triggerId}` : 'trigger' };
    });
    for (const type of ['chat.requested', 'message.created', 'chat.queued', 'chat.closed', 'visitor.page.changed', 'visitor.session.started', 'offline.submitted']) {
      this.consumers.on(type, 'triggers.engine', (e) => this.onEvent(e));
    }
    this.worker.onTimer(async (name, data) => {
      if (name === TIMER_JOB) {
        await this.onTimerJob(data as unknown as TimerData);
        return true;
      }
      if (name === SESSION_STARTED_JOB) {
        const d = data as unknown as { tenantId: string; sessionId: string; visitorId: string };
        await this.sessionStarted(d.tenantId, d.sessionId, d.visitorId);
        return true;
      }
      return false;
    });
    // The first socket connection of a browsing session is the session start signal
    // (one durable, de-duplicated job per session; runs in the worker).
    this.presence.onVisitorConnection(async (tenantId, visitorId, sessionId, event) => {
      if (event !== 'connected' || !sessionId) return;
      const fresh = await this.redis.client.set(`rd:trg:ss:${sessionId}`, '1', 'EX', 86_400, 'NX');
      if (!fresh) return;
      await this.queues.add(QUEUES.timers, SESSION_STARTED_JOB, { tenantId, sessionId, visitorId }, { ...TIMER_OPTS, jobId: `trg-ss-${sessionId}` });
    });
  }

  // ───────── Event intake ─────────

  async onEvent(e: InternalEvent): Promise<void> {
    const p = fromWire(e.payload ?? {}) as Record<string, any>;
    const base = { tenantId: e.tenantId, eventId: e.eventId, causationId: e.causationId };
    switch (e.eventType) {
      case 'chat.requested':
        return this.process({ ...base, event: 'chat.requested', chatId: e.aggregateId, messageText: p.initialMessage?.body ?? null });
      case 'message.created': {
        // Only real visitor messages: system/automated messages never emit the visitor message event.
        if (p.senderType !== 'visitor' || p.automated === true || p.visibility !== 'public') return;
        const messageId = p.message?.id as string | undefined;
        if (!messageId) return;
        const m = await this.db.read(e.tenantId, (tx) => tx.message.findFirst({ where: { tenantId: e.tenantId, id: messageId }, select: { chatId: true, body: true, senderType: true, automated: true, redactedAt: true } }));
        if (!m || m.senderType !== 'visitor' || m.automated) return;
        return this.process({ ...base, event: 'message.created', chatId: m.chatId, messageText: m.redactedAt ? null : m.body });
      }
      case 'chat.queued':
      case 'chat.closed': {
        const chatId = e.aggregateType === 'chat' ? e.aggregateId : ((p.chatId ?? p.chat?.id) as string | undefined);
        if (!chatId) return;
        return this.process({ ...base, event: e.eventType, chatId });
      }
      case 'visitor.page.changed': {
        const sessionId = (p.sessionId as string | undefined) ?? e.aggregateId;
        const visitorId = p.visitorId as string | undefined;
        if (visitorId) await this.scheduleTimers(e.tenantId, sessionId, visitorId);
        return this.process({ ...base, event: 'visitor.page.changed', sessionId, visitorId: visitorId ?? null, siteId: (p.siteId as string) ?? null, pageUrl: typeof p.url === 'string' ? p.url : null });
      }
      case 'visitor.session.started': {
        const sessionId = (p.sessionId as string | undefined) ?? e.aggregateId;
        return this.sessionStarted(e.tenantId, sessionId, (p.visitorId as string) ?? null, e.causationId);
      }
      case 'offline.submitted': {
        const id = e.aggregateId;
        const sub = await this.db.read(e.tenantId, (tx) => tx.offlineSubmission.findFirst({ where: { tenantId: e.tenantId, id }, select: { siteId: true, visitorId: true, sessionId: true, departmentId: true } }));
        if (!sub) return;
        return this.process({ ...base, event: 'offline.submitted', siteId: sub.siteId, visitorId: sub.visitorId, sessionId: sub.sessionId, departmentId: sub.departmentId });
      }
    }
  }

  /** visitor.session.started has one stable event id per session (socket hook and outbox source dedupe). */
  async sessionStarted(tenantId: string, sessionId: string, visitorId: string | null, causationId: string | null = null): Promise<void> {
    const session = await this.db.read(tenantId, (tx) => tx.visitorSession.findFirst({ where: { tenantId, id: sessionId }, select: { visitorId: true, siteId: true, endedAt: true } }));
    if (!session || session.endedAt) return;
    await this.scheduleTimers(tenantId, sessionId, session.visitorId, { pageTimers: false });
    await this.process({ tenantId, event: 'visitor.session.started', eventId: sessionStartedEventId(sessionId), sessionId, visitorId: visitorId ?? session.visitorId, siteId: session.siteId, causationId });
  }

  // ───────── Durable timers (never browser setTimeout authority) ─────────

  async scheduleTimers(tenantId: string, sessionId: string, visitorId: string, opts: { pageTimers?: boolean } = {}): Promise<void> {
    const triggers = await this.db.read(tenantId, (tx) => loadPublishedTriggers(tx, tenantId, 'visitor.timer.elapsed'));
    if (!triggers.length) return;
    const page = new Set<number>();
    const session = new Set<number>();
    for (const t of triggers) {
      const th = dslTimerThresholds(t.definition);
      th.page.forEach((s) => page.add(s));
      th.session.forEach((s) => session.add(s));
    }
    const now = Date.now();
    const state = await this.db.read(tenantId, async (tx) => {
      const s = await tx.visitorSession.findFirst({ where: { tenantId, id: sessionId } });
      const dwell = s && opts.pageTimers !== false && page.size && s.analyticsConsent === 'granted' ? await this.snapshots.pageDwell(tx, tenantId, sessionId, now) : null;
      return { s, dwell };
    });
    if (!state.s || state.s.endedAt) return;
    if (state.dwell && !state.dwell.left) {
      for (const seconds of page) {
        const delay = Math.max(0, state.dwell.enteredAt.getTime() + seconds * 1000 - now);
        const data: TimerData = { tenantId, sessionId, visitorId, kind: 'page', seconds, anchorId: state.dwell.anchorId, attempt: 0 };
        await this.queues.add(QUEUES.timers, TIMER_JOB, data, { ...TIMER_OPTS, delay, jobId: `trg-p-${state.dwell.anchorId}-${seconds}` });
      }
    }
    for (const seconds of session) {
      const due = state.s.startedAt.getTime() + seconds * 1000;
      if (due < now - 5000) continue; // already elapsed earlier in this session
      const data: TimerData = { tenantId, sessionId, visitorId, kind: 'session', seconds, attempt: 0 };
      await this.queues.add(QUEUES.timers, TIMER_JOB, data, { ...TIMER_OPTS, delay: Math.max(0, due - now), jobId: `trg-s-${sessionId}-${seconds}` });
    }
  }

  private async onTimerJob(d: TimerData): Promise<void> {
    if (!(await this.presence.isVisitorOnline(d.tenantId, d.visitorId))) return; // visitor left: nothing to time
    const now = Date.now();
    const state = await this.db.read(d.tenantId, async (tx) => {
      const s = await tx.visitorSession.findFirst({ where: { tenantId: d.tenantId, id: d.sessionId } });
      const dwell = s && d.kind === 'page' ? await this.snapshots.pageDwell(tx, d.tenantId, d.sessionId, now) : null;
      return { s, dwell };
    });
    if (!state.s || state.s.endedAt) return;
    let elapsedMs: number;
    if (d.kind === 'page') {
      // Stale timer: the visitor navigated away (new anchor) or left the page.
      if (!state.dwell || state.dwell.anchorId !== d.anchorId || state.dwell.left) return;
      elapsedMs = state.dwell.visibleMs;
    } else {
      elapsedMs = now - state.s.startedAt.getTime();
    }
    if (elapsedMs < d.seconds * 1000) {
      const attempt = (d.attempt ?? 0) + 1;
      if (attempt > MAX_TIMER_RESCHEDULES) return;
      const hidden = d.kind === 'page' && state.dwell?.hidden;
      const delay = Math.max(d.seconds * 1000 - elapsedMs + 250, hidden ? Math.min(60_000, 5000 * 2 ** Math.min(attempt, 4)) : 250);
      const jobId = d.kind === 'page' ? `trg-p-${d.anchorId}-${d.seconds}-r${attempt}` : `trg-s-${d.sessionId}-${d.seconds}-r${attempt}`;
      await this.queues.add(QUEUES.timers, TIMER_JOB, { ...d, attempt }, { ...TIMER_OPTS, delay, jobId });
      return;
    }
    await this.process({
      tenantId: d.tenantId,
      event: 'visitor.timer.elapsed',
      eventId: timerEventId(d),
      sessionId: d.sessionId,
      visitorId: state.s.visitorId,
      siteId: state.s.siteId,
    });
  }

  // ───────── Evaluation ─────────

  private async causation(tenantId: string, causationId: string | null | undefined): Promise<{ depth: number; ancestors: string[] }> {
    if (!causationId || !/^[0-9a-f-]{36}$/i.test(causationId)) return { depth: 0, ancestors: [] };
    return this.db.read(tenantId, async (tx) => {
      const effect = await tx.triggerEffect.findFirst({ where: { tenantId, id: causationId }, select: { runId: true } });
      if (!effect) return { depth: 0, ancestors: [] };
      const run = await tx.triggerRun.findFirst({ where: { tenantId, id: effect.runId }, select: { depth: true, result: true, triggerId: true } });
      if (!run) return { depth: 0, ancestors: [] };
      const anc = ((run.result as { ancestors?: string[] } | null)?.ancestors ?? [run.triggerId]).filter((x) => typeof x === 'string');
      return { depth: run.depth + 1, ancestors: anc };
    });
  }

  /**
   * Evaluate one event. Runs (and their pending effects) for an event are inserted
   * atomically; a redelivered event finds them and only resumes pending effects,
   * so retries never re-evaluate against changed state or duplicate an effect.
   */
  async process(c: DslEventContext): Promise<void> {
    const tenantId = c.tenantId;
    const triggers = await this.db.read(tenantId, (tx) => loadPublishedTriggers(tx, tenantId, c.event));
    if (!triggers.length) return;
    const existing = await this.existingRuns(tenantId, c.eventId, triggers);
    if (existing.length) return this.effects.executeRuns(tenantId, existing);

    const causal = await this.causation(tenantId, c.causationId);
    const now = Date.now();
    const built = await this.snapshots.build(c, now);
    const lastFiredAt = await this.lastFired(tenantId, built.context.sessionId, triggers);
    const evaluation = evaluateDslPipeline({ event: c.event, snapshot: built.snapshot, now, triggers, lastFiredAt, depth: causal.depth, ancestors: causal.ancestors });
    const recorded = evaluation.triggers.filter((t) => t.matched);
    if (!recorded.length) return;

    let runIds: string[];
    try {
      runIds = await this.db.tx(tenantId, async (tx) => {
        const ids: string[] = [];
        for (const t of recorded) {
          const run = await tx.triggerRun.create({
            data: {
              tenantId,
              triggerId: t.triggerId,
              triggerRevision: t.revision,
              eventId: c.eventId,
              eventType: c.event,
              visitorSessionId: built.context.sessionId,
              visitorId: built.context.visitorId,
              chatId: built.context.chatId,
              matched: t.fired,
              causationId: c.causationId && /^[0-9a-f-]{36}$/i.test(c.causationId) ? c.causationId : null,
              depth: causal.depth,
              result: runResult(t, evaluation, built, causal, now) as unknown as Prisma.InputJsonValue,
              executedAt: new Date(now),
            },
          });
          ids.push(run.id);
          const effects = evaluation.effects.filter((e) => e.triggerId === t.triggerId);
          const suppressed = evaluation.suppressed.filter((s) => s.triggerId === t.triggerId);
          if (effects.length || suppressed.length) {
            await tx.triggerEffect.createMany({
              data: [
                ...effects.map((e) => ({ tenantId, runId: run.id, actionIndex: e.actionIndex, actionType: e.action.type, status: 'pending' })),
                ...suppressed.map((s) => ({ tenantId, runId: run.id, actionIndex: s.actionIndex, actionType: s.type, status: 'suppressed', reason: s.reason, executedAt: new Date(now) })),
              ],
            });
          }
          if (t.fired) await tx.trigger.updateMany({ where: { tenantId, id: t.triggerId }, data: { matchCount: { increment: 1 }, lastMatchedAt: new Date(now) } });
        }
        return ids;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A concurrent delivery recorded this event first: resume its effects.
      runIds = await this.existingRuns(tenantId, c.eventId, triggers);
    }
    await this.effects.executeRuns(tenantId, runIds);
  }

  /**
   * Synchronous pre-admission decision for `block_admission` (no writes). Intended
   * to be called by ChatCommandsService.admit() before the chat row is created so
   * a terminal block is atomic with admission; the asynchronous chat.requested run
   * still records the trace. Chat fields are missing at this point (no chat yet).
   */
  async admissionCheck(v: { tenantId: string; siteId: string; visitorId: string; sessionId: string }, input: { departmentId?: string | null; message?: string | null }): Promise<{ blocked: boolean; triggerId: string | null; reason: string | null }> {
    const triggers = await this.db.read(v.tenantId, (tx) => loadPublishedTriggers(tx, v.tenantId, 'chat.requested'));
    if (!triggers.some((t) => t.definition.actions.some((a) => a.type === 'block_admission'))) return { blocked: false, triggerId: null, reason: null };
    const now = Date.now();
    const built = await this.snapshots.build(
      { tenantId: v.tenantId, event: 'chat.requested', eventId: 'admission-check', siteId: v.siteId, visitorId: v.visitorId, sessionId: v.sessionId, departmentId: input.departmentId ?? null, messageText: input.message ?? null },
      now,
    );
    const lastFiredAt = await this.lastFired(v.tenantId, v.sessionId, triggers);
    const evaluation = evaluateDslPipeline({ event: 'chat.requested', snapshot: built.snapshot, now, triggers, lastFiredAt });
    const block = evaluation.effects.find((e) => e.action.type === 'block_admission');
    return block && block.action.type === 'block_admission' ? { blocked: true, triggerId: block.triggerId, reason: block.action.reason } : { blocked: false, triggerId: null, reason: null };
  }

  private async existingRuns(tenantId: string, eventId: string, triggers: PublishedTrigger[]): Promise<string[]> {
    const rows = await this.db.read(tenantId, (tx) =>
      tx.triggerRun.findMany({ where: { tenantId, eventId, OR: triggers.map((t) => ({ triggerId: t.id, triggerRevision: t.revision })) }, select: { id: true } }),
    );
    return rows.map((r) => r.id);
  }

  /** Cooldowns are scoped to trigger + visitor session (ch. 33). */
  private async lastFired(tenantId: string, sessionId: string | null, triggers: PublishedTrigger[]): Promise<Record<string, number>> {
    const withCooldown = triggers.filter((t) => t.definition.cooldown_seconds > 0);
    if (!sessionId || !withCooldown.length) return {};
    return this.db.read(tenantId, async (tx) => {
      const out: Record<string, number> = {};
      for (const t of withCooldown) {
        const last = await tx.triggerRun.findFirst({ where: { tenantId, visitorSessionId: sessionId, triggerId: t.id, matched: true }, orderBy: { executedAt: 'desc' }, select: { executedAt: true } });
        if (last) out[t.id] = last.executedAt.getTime();
      }
      return out;
    });
  }
}

function runResult(
  t: DslTriggerTrace,
  evaluation: DslEvaluation,
  built: Awaited<ReturnType<TriggerSnapshotService['build']>>,
  causal: { depth: number; ancestors: string[] },
  now: number,
) {
  return {
    position: t.position,
    reason: t.reason,
    fired: t.fired,
    stopProcessing: t.stopProcessing,
    allResult: t.allResult,
    anyResult: t.anyResult,
    all: t.all,
    any: t.any,
    effects: evaluation.effects.filter((e) => e.triggerId === t.triggerId).map((e) => ({ actionIndex: e.actionIndex, type: e.action.type })),
    suppressed: evaluation.suppressed.filter((s) => s.triggerId === t.triggerId).map((s) => ({ actionIndex: s.actionIndex, type: s.type, reason: s.reason })),
    stoppedBy: evaluation.stoppedBy,
    blocked: evaluation.blocked,
    snapshot: redactSnapshot(built.snapshot),
    context: built.context,
    ancestors: [...causal.ancestors, t.triggerId],
    evaluatedAt: new Date(now).toISOString(),
  };
}
