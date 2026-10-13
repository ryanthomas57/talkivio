import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, Trigger, TriggerRevision } from '@prisma/client';
import {
  evaluateDslPipeline,
  validateDslDefinition,
  validateDslSnapshot,
  type DslDefinition,
  type DslEvent,
  type DslIssue,
  type DslTriggerSpec,
} from '@talkivio/contracts';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AuditService } from '../../common/audit.service';
import { sha256 } from '../../common/crypto';
import { AppError, badRequest, conflict, notFound, type AuthContext } from '../../common/http';
import { decodeCursor, encodeCursor, page } from '../../common/wire';
import { OutboxService } from '../../outbox/outbox.service';
import { assertVersion } from './http-utils';
import { InvitationsService } from './invitations.service';
import { loadPublishedTriggers, validationContext } from './trigger-repo';
import { TRIGGER_TEMPLATES } from './trigger-templates';

export interface TriggerSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  event: string;
  priority: number;
  currentRevision: number;
  publishedRevision: number | null;
  draftPending: boolean;
  lastMatchedAt: Date | null;
  matchCount: number;
  errorCount: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface RevisionResource {
  revision: number;
  dslVersion: number;
  definition: unknown;
  publishedAt: Date | null;
  publishedBy: string | null;
  createdAt: Date;
}

function summary(t: Trigger): TriggerSummary {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    enabled: t.enabled,
    event: t.eventType,
    priority: t.priority,
    currentRevision: t.currentRevision,
    publishedRevision: t.publishedRevision,
    draftPending: t.publishedRevision !== t.currentRevision,
    lastMatchedAt: t.lastMatchedAt,
    matchCount: t.matchCount,
    errorCount: t.errorCount,
    archivedAt: t.archivedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    version: t.version,
  };
}

function revisionResource(r: TriggerRevision): RevisionResource {
  return { revision: r.revision, dslVersion: r.dslVersion, definition: r.definition, publishedAt: r.publishedAt, publishedBy: r.publishedBy, createdAt: r.createdAt };
}

/** Grammar issues → 422 field errors keyed under `definition.` / `snapshot.`. */
function invalid(prefix: string, issues: DslIssue[]): AppError {
  const fieldErrors: Record<string, string[]> = {};
  for (const i of issues) (fieldErrors[i.path ? `${prefix}.${i.path}` : prefix] ??= []).push(i.message);
  return new AppError(422, 'VALIDATION_FAILED', 'The trigger definition is not valid.', { fieldErrors, details: { issues } });
}

/** Trigger configuration, revisions, simulation and run history (ch. 33/45). */
@Injectable()
export class TriggersService {
  private readonly logger = new Logger('Triggers');

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly invitations: InvitationsService,
  ) {}

  private async validated(tx: Tx, tenantId: string, definition: unknown): Promise<DslDefinition> {
    const r = validateDslDefinition(definition, await validationContext(tx, tenantId));
    if (!r.ok) throw invalid('definition', r.issues);
    return r.definition;
  }

  private async lock(tx: Tx, tenantId: string, id: string): Promise<Trigger> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM triggers WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound('Trigger');
    const t = await tx.trigger.findUniqueOrThrow({ where: { id } });
    if (t.archivedAt) throw notFound('Trigger');
    return t;
  }

  private async detail(tx: Tx, t: Trigger) {
    const revisions = await tx.triggerRevision.findMany({ where: { tenantId: t.tenantId, triggerId: t.id }, orderBy: { revision: 'desc' }, take: 100 });
    const draft = revisions.find((r) => r.revision === t.currentRevision) ?? null;
    const published = t.publishedRevision ? (revisions.find((r) => r.revision === t.publishedRevision) ?? null) : null;
    return {
      ...summary(t),
      draft: draft ? revisionResource(draft) : null,
      published: published ? revisionResource(published) : null,
      revisions: revisions.map((r) => ({ revision: r.revision, publishedAt: r.publishedAt, publishedBy: r.publishedBy, createdAt: r.createdAt })),
    };
  }

  // ───────── Starter templates ─────────

  /** Seed disabled starter templates once, when the tenant has never had a trigger. */
  async seedTemplates(tenantId: string): Promise<void> {
    const count = await this.db.read(tenantId, (tx) => tx.trigger.count({ where: { tenantId } }));
    if (count) return;
    await this.db.tx(tenantId, async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`rd-trigger-seed:${tenantId}`}, 0))`;
      if (await tx.trigger.count({ where: { tenantId } })) return;
      const base = Date.now();
      for (const [i, tpl] of TRIGGER_TEMPLATES.entries()) {
        const v = validateDslDefinition(tpl.definition);
        if (!v.ok) {
          this.logger.error(`Starter template ${tpl.key} is invalid: ${JSON.stringify(v.issues)}`);
          continue;
        }
        const createdAt = new Date(base + i);
        const t = await tx.trigger.create({
          data: { tenantId, name: tpl.name, description: tpl.description, enabled: false, priority: v.definition.priority, eventType: v.definition.event, currentRevision: 1, publishedRevision: 1, createdAt },
        });
        await tx.triggerRevision.create({
          data: { tenantId, triggerId: t.id, revision: 1, dslVersion: 1, definition: v.definition as unknown as Prisma.InputJsonValue, publishedAt: createdAt, publishedBy: null },
        });
      }
    });
  }

  // ───────── Queries ─────────

  async list(auth: AuthContext, q: { event?: DslEvent; cursor?: string; limit: number; includeArchived?: boolean }) {
    await this.seedTemplates(auth.tenantId);
    const filterHash = sha256(`triggers:${q.event ?? ''}:${q.includeArchived ? 1 : 0}`).slice(0, 16);
    const after = decodeCursor<{ p: number; c: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !after) throw new AppError(422, 'CURSOR_EXPIRED', 'This list changed; reload from the first page');
    return this.db.read(auth.tenantId, async (tx) => {
      const rows = await tx.trigger.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(q.includeArchived ? {} : { archivedAt: null }),
          ...(q.event ? { eventType: q.event } : {}),
          ...(after
            ? {
                OR: [
                  { priority: { lt: after.p } },
                  { priority: after.p, createdAt: { gt: new Date(after.c) } },
                  { priority: after.p, createdAt: new Date(after.c), id: { gt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: q.limit + 1,
      });
      const more = rows.length > q.limit;
      const items = rows.slice(0, q.limit);
      const revs = items.length
        ? await tx.triggerRevision.findMany({ where: { tenantId: auth.tenantId, OR: items.map((t) => ({ triggerId: t.id, revision: t.currentRevision })) } })
        : [];
      const defs = new Map(revs.map((r) => [r.triggerId, r.definition]));
      const last = items[items.length - 1];
      return page(
        items.map((t) => ({ ...summary(t), definition: defs.get(t.id) ?? null })),
        more && last ? encodeCursor({ p: last.priority, c: last.createdAt.toISOString(), id: last.id }, filterHash) : null,
      );
    });
  }

  async get(auth: AuthContext, id: string) {
    return this.db.read(auth.tenantId, async (tx) => {
      const t = await tx.trigger.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!t) throw notFound('Trigger');
      return this.detail(tx, t);
    });
  }

  // ───────── Commands ─────────

  async create(auth: AuthContext, input: { name: string; description?: string | null; definition?: unknown }) {
    return this.db.tx(auth.tenantId, async (tx) => {
      const def = await this.validated(tx, auth.tenantId, input.definition);
      const t = await tx.trigger.create({
        data: { tenantId: auth.tenantId, name: input.name.trim(), description: input.description?.trim() || null, enabled: false, priority: def.priority, eventType: def.event, currentRevision: 1, publishedRevision: null },
      });
      await tx.triggerRevision.create({ data: { tenantId: auth.tenantId, triggerId: t.id, revision: 1, dslVersion: def.dsl_version, definition: def as unknown as Prisma.InputJsonValue } });
      await this.audit.inTx(tx, auth, { action: 'trigger.created', objectType: 'trigger', objectId: t.id, safeDiff: { event: def.event, priority: def.priority, revision: 1 } });
      await this.changed(tx, t, 'created');
      return this.detail(tx, t);
    });
  }

  async update(auth: AuthContext, id: string, input: { name?: string; description?: string | null; enabled?: boolean }, expectedVersion: number) {
    return this.db.tx(auth.tenantId, async (tx) => {
      const t = await this.lock(tx, auth.tenantId, id);
      assertVersion(expectedVersion, t.version, 'This trigger', summary(t));
      if (input.enabled === true && !t.publishedRevision) throw badRequest('Publish the trigger before enabling it', { enabled: ['Publish a revision first'] });
      const next = await tx.trigger.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          version: { increment: 1 },
        },
      });
      if (input.enabled !== undefined && input.enabled !== t.enabled) {
        await this.audit.inTx(tx, auth, { action: input.enabled ? 'trigger.enabled' : 'trigger.disabled', objectType: 'trigger', objectId: id, safeDiff: { revision: t.publishedRevision } });
        await this.activation(tx, next);
      }
      if (input.name !== undefined || input.description !== undefined) {
        await this.audit.inTx(tx, auth, { action: 'trigger.updated', objectType: 'trigger', objectId: id, safeDiff: { name: input.name !== undefined, description: input.description !== undefined } });
        await this.changed(tx, next, 'details');
      }
      return this.detail(tx, next);
    });
  }

  /** Save the editable head: overwrite an unpublished draft or start a new revision after a publish. */
  async saveDraft(auth: AuthContext, id: string, definition: unknown, expectedVersion: number | null) {
    return this.db.tx(auth.tenantId, async (tx) => {
      const t = await this.lock(tx, auth.tenantId, id);
      assertVersion(expectedVersion, t.version, 'This trigger', summary(t));
      const def = await this.validated(tx, auth.tenantId, definition);
      const head = await tx.triggerRevision.findFirst({ where: { tenantId: auth.tenantId, triggerId: id, revision: t.currentRevision } });
      let revision = t.currentRevision;
      if (head && !head.publishedAt) {
        await tx.triggerRevision.update({ where: { id: head.id }, data: { definition: def as unknown as Prisma.InputJsonValue, dslVersion: def.dsl_version } });
      } else {
        revision = await this.nextRevision(tx, auth.tenantId, id);
        await tx.triggerRevision.create({ data: { tenantId: auth.tenantId, triggerId: id, revision, dslVersion: def.dsl_version, definition: def as unknown as Prisma.InputJsonValue } });
      }
      const next = await tx.trigger.update({
        where: { id },
        data: { currentRevision: revision, version: { increment: 1 }, ...(t.publishedRevision ? {} : { eventType: def.event, priority: def.priority }) },
      });
      await this.changed(tx, next, 'draft_saved');
      return { trigger: summary(next), draft: { revision, definition: def, publishedAt: null } };
    });
  }

  private async nextRevision(tx: Tx, tenantId: string, triggerId: string): Promise<number> {
    const max = await tx.triggerRevision.aggregate({ where: { tenantId, triggerId }, _max: { revision: true } });
    return (max._max.revision ?? 0) + 1;
  }

  /**
   * Publish an immutable revision. `revision` must be the current head (version
   * check): a concurrent draft save makes a stale publish fail with 409.
   */
  async publish(auth: AuthContext, id: string, input: { revision: number; enabled: boolean }) {
    return this.db.tx(auth.tenantId, async (tx) => {
      const t = await this.lock(tx, auth.tenantId, id);
      if (input.revision !== t.currentRevision) {
        throw conflict('VERSION_CONFLICT', `Revision ${input.revision} is not the current draft (current is ${t.currentRevision}). Reload before publishing.`, false, { currentRevision: t.currentRevision });
      }
      const head = await tx.triggerRevision.findFirst({ where: { tenantId: auth.tenantId, triggerId: id, revision: input.revision } });
      if (!head) throw notFound('Revision');
      let def: DslDefinition;
      const firstPublish = !head.publishedAt;
      if (firstPublish) {
        def = await this.validated(tx, auth.tenantId, head.definition);
        await tx.triggerRevision.update({ where: { id: head.id }, data: { definition: def as unknown as Prisma.InputJsonValue, publishedAt: new Date(), publishedBy: auth.userId } });
      } else {
        const v = validateDslDefinition(head.definition);
        if (!v.ok) throw invalid('definition', v.issues);
        def = v.definition;
      }
      const next = await tx.trigger.update({
        where: { id },
        data: { publishedRevision: input.revision, enabled: input.enabled, eventType: def.event, priority: def.priority, version: { increment: 1 } },
      });
      if (firstPublish) {
        await this.audit.inTx(tx, auth, { action: 'trigger.published', objectType: 'trigger', objectId: id, safeDiff: { revision: input.revision, event: def.event, priority: def.priority, enabled: input.enabled } });
      }
      if (input.enabled !== t.enabled) {
        await this.audit.inTx(tx, auth, { action: input.enabled ? 'trigger.enabled' : 'trigger.disabled', objectType: 'trigger', objectId: id, safeDiff: { revision: input.revision } });
      }
      if (firstPublish || input.enabled !== t.enabled) await this.activation(tx, next);
      return this.detail(tx, next);
    });
  }

  private async activation(tx: Tx, t: Trigger): Promise<void> {
    await this.outbox.append(tx, t.tenantId, {
      aggregateType: 'trigger',
      aggregateId: t.id,
      aggregateVersion: t.version,
      eventType: 'trigger.published',
      payload: { triggerId: t.id, revision: t.publishedRevision, enabled: t.enabled, event: t.eventType, priority: t.priority },
      // Staff refresh signal for open trigger screens (no definition in the payload).
      scopes: [{ kind: 'team', id: 'all', audience: 'staff' }],
    });
  }

  /** Staff refresh signal for edits that do not change what runs: create, name/description, draft save, restore. */
  private async changed(tx: Tx, t: Trigger, change: 'created' | 'details' | 'draft_saved' | 'restored'): Promise<void> {
    await this.outbox.append(tx, t.tenantId, {
      aggregateType: 'trigger',
      aggregateId: t.id,
      aggregateVersion: t.version,
      eventType: 'trigger.updated',
      payload: { triggerId: t.id, change, currentRevision: t.currentRevision, version: t.version },
      scopes: [{ kind: 'team', id: 'all', audience: 'staff' }],
    });
  }

  /** Restore an earlier revision as a NEW draft revision (history is never rewritten). */
  async restore(auth: AuthContext, id: string, revision: number) {
    return this.db.tx(auth.tenantId, async (tx) => {
      await this.lock(tx, auth.tenantId, id);
      const source = await tx.triggerRevision.findFirst({ where: { tenantId: auth.tenantId, triggerId: id, revision } });
      if (!source) throw notFound('Revision');
      const def = await this.validated(tx, auth.tenantId, source.definition);
      const next = await this.nextRevision(tx, auth.tenantId, id);
      await tx.triggerRevision.create({ data: { tenantId: auth.tenantId, triggerId: id, revision: next, dslVersion: def.dsl_version, definition: def as unknown as Prisma.InputJsonValue } });
      const updated = await tx.trigger.update({ where: { id }, data: { currentRevision: next, version: { increment: 1 } } });
      await this.audit.inTx(tx, auth, { action: 'trigger.restored', objectType: 'trigger', objectId: id, safeDiff: { from_revision: revision, revision: next } });
      await this.changed(tx, updated, 'restored');
      return this.detail(tx, updated);
    });
  }

  async archive(auth: AuthContext, id: string, expectedVersion: number | null): Promise<void> {
    await this.db.tx(auth.tenantId, async (tx) => {
      const t = await this.lock(tx, auth.tenantId, id);
      assertVersion(expectedVersion, t.version, 'This trigger');
      const next = await tx.trigger.update({ where: { id }, data: { archivedAt: new Date(), enabled: false, version: { increment: 1 } } });
      await this.audit.inTx(tx, auth, { action: 'trigger.archived', objectType: 'trigger', objectId: id, safeDiff: { was_enabled: t.enabled } });
      if (t.enabled) await this.audit.inTx(tx, auth, { action: 'trigger.disabled', objectType: 'trigger', objectId: id, safeDiff: { reason: 'archived' } });
      await this.activation(tx, next);
    });
  }

  // ───────── Simulation (no writes; the exact production interpreter) ─────────

  async simulate(auth: AuthContext, id: string, input: { event: DslEvent; snapshot: unknown; revision?: number; definition?: unknown; includePublished: boolean }) {
    return this.db.read(auth.tenantId, async (tx) => {
      const t = await tx.trigger.findFirst({ where: { tenantId: auth.tenantId, id, archivedAt: null } });
      if (!t) throw notFound('Trigger');
      const ctx = await validationContext(tx, auth.tenantId);
      const snap = validateDslSnapshot(input.snapshot, ctx);
      if (!snap.ok) throw invalid('snapshot', snap.issues);
      // Unsaved editor state is validated exactly like a draft save (same context), but never stored.
      let revision: number | null;
      let definition: DslDefinition;
      if (input.definition !== undefined) {
        const parsed = validateDslDefinition(input.definition, ctx);
        if (!parsed.ok) throw invalid('definition', parsed.issues);
        revision = null;
        definition = parsed.definition;
      } else {
        const rev = await tx.triggerRevision.findFirst({ where: { tenantId: auth.tenantId, triggerId: id, revision: input.revision ?? t.currentRevision } });
        if (!rev) throw notFound('Revision');
        const parsed = validateDslDefinition(rev.definition);
        if (!parsed.ok) throw invalid('definition', parsed.issues);
        revision = rev.revision;
        definition = parsed.definition;
      }
      const candidate: DslTriggerSpec = { id: t.id, revision: revision ?? 0, createdAt: t.createdAt.getTime(), definition };
      const others = input.includePublished ? await loadPublishedTriggers(tx, auth.tenantId, input.event, t.id) : [];
      const names = new Map<string, string>([[t.id, t.name], ...others.map((o) => [o.id, o.name] as [string, string])]);
      const evaluation = evaluateDslPipeline({ event: input.event, snapshot: snap.snapshot, now: Date.now(), triggers: [candidate, ...others] });
      return {
        event: input.event,
        triggerId: t.id,
        /** null = the unsaved editor definition was simulated. */
        revision,
        snapshot: snap.snapshot,
        triggers: evaluation.triggers.map((tr) => ({ ...tr, name: names.get(tr.triggerId) ?? null, candidate: tr.triggerId === t.id })),
        effects: evaluation.effects,
        suppressed: evaluation.suppressed,
        stoppedBy: evaluation.stoppedBy,
        blocked: evaluation.blocked,
        writes: false,
      };
    });
  }

  /** One revision with its full definition (history view, diff against the draft). */
  async revision(auth: AuthContext, id: string, revision: number) {
    return this.db.read(auth.tenantId, async (tx) => {
      const t = await tx.trigger.findFirst({ where: { tenantId: auth.tenantId, id }, select: { id: true } });
      if (!t) throw notFound('Trigger');
      const rev = await tx.triggerRevision.findFirst({ where: { tenantId: auth.tenantId, triggerId: id, revision } });
      if (!rev) throw notFound('Revision');
      return revisionResource(rev);
    });
  }

  // ───────── Run history ─────────

  async runs(auth: AuthContext, id: string, q: { from?: Date; to?: Date; cursor?: string; limit: number }) {
    const filterHash = sha256(`runs:${id}:${q.from?.toISOString() ?? ''}:${q.to?.toISOString() ?? ''}`).slice(0, 16);
    const after = decodeCursor<{ at: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !after) throw new AppError(422, 'CURSOR_EXPIRED', 'This list changed; reload from the first page');
    return this.db.read(auth.tenantId, async (tx) => {
      const t = await tx.trigger.findFirst({ where: { tenantId: auth.tenantId, id }, select: { id: true } });
      if (!t) throw notFound('Trigger');
      const rows = await tx.triggerRun.findMany({
        where: {
          tenantId: auth.tenantId,
          triggerId: id,
          ...(q.from || q.to ? { executedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
          ...(after ? { OR: [{ executedAt: { lt: new Date(after.at) } }, { executedAt: new Date(after.at), id: { lt: after.id } }] } : {}),
        },
        orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const more = rows.length > q.limit;
      let items = rows.slice(0, q.limit);
      const last = items[items.length - 1];
      // Scoped supervisors only see chat runs of their departments.
      if (auth.departmentScope !== 'all') {
        const chatIds = items.map((r) => r.chatId).filter((x): x is string => !!x);
        const chats = chatIds.length ? await tx.chat.findMany({ where: { tenantId: auth.tenantId, id: { in: chatIds } }, select: { id: true, departmentId: true } }) : [];
        const scope = new Set(auth.departmentScope);
        const allowed = new Set(chats.filter((c) => !c.departmentId || scope.has(c.departmentId)).map((c) => c.id));
        items = items.filter((r) => !r.chatId || allowed.has(r.chatId));
      }
      const effects = items.length ? await tx.triggerEffect.findMany({ where: { tenantId: auth.tenantId, runId: { in: items.map((r) => r.id) } }, orderBy: { actionIndex: 'asc' } }) : [];
      return page(
        items.map((r) => ({
          id: r.id,
          triggerId: r.triggerId,
          triggerRevision: r.triggerRevision,
          eventId: r.eventId,
          eventType: r.eventType,
          visitorSessionId: r.visitorSessionId,
          chatId: r.chatId,
          matched: r.matched,
          causationId: r.causationId,
          depth: r.depth,
          executedAt: r.executedAt,
          result: r.result,
          effects: effects
            .filter((e) => e.runId === r.id)
            .map((e) => ({ id: e.id, actionIndex: e.actionIndex, actionType: e.actionType, status: e.status, reason: e.reason, executedAt: e.executedAt })),
        })),
        more && last ? encodeCursor({ at: last.executedAt.toISOString(), id: last.id }, filterHash) : null,
      );
    });
  }

  async funnel(auth: AuthContext, id: string, range: { from?: Date; to?: Date }) {
    const exists = await this.db.read(auth.tenantId, (tx) => tx.trigger.findFirst({ where: { tenantId: auth.tenantId, id }, select: { id: true } }));
    if (!exists) throw notFound('Trigger');
    return this.invitations.funnel(auth.tenantId, id, range);
  }
}
