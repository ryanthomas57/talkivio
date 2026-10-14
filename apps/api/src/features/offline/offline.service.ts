import { lockForUpdate } from '../../db/row-lock';
import { Injectable } from '@nestjs/common';
import type { OfflineSubmission, Prisma } from '@prisma/client';
import { codePointLength } from '@talkivio/contracts';
import { randomUUID } from 'node:crypto';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AuditService } from '../../common/audit.service';
import { decrypt, encrypt, sha256, emailLookupHash } from '../../common/crypto';
import {
  AppError,
  badRequest,
  conflict,
  denied,
  notFound,
  rateLimited,
  type AuthContext,
  type VisitorContext,
} from '../../common/http';
import { IdempotencyService } from '../../common/idempotency';
import { camel, decodeCursor, encodeCursor, page, type Page } from '../../common/wire';
import { MailService } from '../../core/mail.service';
import { RateLimitService } from '../../core/rate-limit.service';
import { OutboxService, type OutboxScope } from '../../outbox/outbox.service';
import { ChatCommandsService } from '../chats/chat-commands.service';
import { ChatStore, queueScopeId } from '../chats/chat.store';
import { RoutingService } from '../chats/routing.service';
import {
  EMAIL_RE,
  maskEmail,
  newReference,
  offlinePolicy,
  PHONE_FIELD_KEY,
  PHONE_RE,
  visitorHourlyLimit,
  type OfflinePolicy,
} from './offline.policy';

export interface OfflineSubmitInput {
  clientRequestId: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  message: string;
  departmentId?: string | null;
  fields?: Record<string, unknown> | null;
  sourceChatId?: string | null;
}

/** Visitor-facing receipt (never contains the email address or phone). */
export interface OfflineReceipt {
  id: string;
  reference: string;
  status: 'received';
  createdAt: Date;
  departmentId: string | null;
  sourceChatId: string | null;
  conversionReason: string | null;
  notifications: { confirmation: 'pending' | 'disabled'; team: 'pending' | 'disabled' };
}

export interface OfflineSummary {
  id: string;
  reference: string;
  siteId: string;
  departmentId: string | null;
  visitorId: string | null;
  name: string | null;
  emailMasked: string;
  messagePreview: string;
  status: string;
  sourceChatId: string | null;
  conversionReason: string | null;
  handledAt: Date | null;
  handledById: string | null;
  createdAt: Date;
  version: number;
}

export interface OfflineDetail extends Omit<OfflineSummary, 'messagePreview'> {
  email: string | null;
  phone: string | null;
  message: string;
  customFields: Record<string, unknown>;
  handledBy: { id: string; displayName: string } | null;
  replies: Array<{ id: string; status: string; createdAt: Date; acceptedAt: Date | null }>;
}

const VISITOR_NETWORK_LIMIT_PER_HOUR = 30;
const MAX_CUSTOM_FIELDS = 20;
const VISITOR_ROUTE = 'widget.offline_submissions.create';
const DUPLICATE_RETRIES = 25;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function fieldError(path: string, message: string, details?: unknown): AppError {
  return new AppError(422, 'VALIDATION_FAILED', 'Check the highlighted fields.', {
    fieldErrors: { [path]: [message] },
    details,
  });
}

/**
 * Offline forms and queue conversion (ch. 23). A submission is durable before the
 * visitor sees a reference; notifications run afterwards in an idempotent event
 * consumer, so an SMTP outage never loses the message.
 */
@Injectable()
export class OfflineService {
  constructor(
    private readonly db: TenantDb,
    private readonly idempotency: IdempotencyService,
    private readonly rateLimit: RateLimitService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly chats: ChatCommandsService,
    private readonly store: ChatStore,
    private readonly routing: RoutingService,
  ) {}

  // ═════════════════════════════ Visitor submission ═════════════════════════════

  async policyFor(tx: Tx, siteId: string): Promise<OfflinePolicy> {
    const rev = await tx.widgetConfigRevision.findFirst({
      where: { siteId, publishedAt: { not: null } },
      orderBy: { revision: 'desc' },
    });
    return offlinePolicy(rev?.config ?? null);
  }

  async submit(
    v: VisitorContext,
    input: OfflineSubmitInput,
  ): Promise<{ status: number; body: OfflineReceipt; replayed: boolean }> {
    const key =
      input.clientRequestId.length >= 16
        ? input.clientRequestId
        : `req-${input.clientRequestId.padEnd(16, '0')}`;
    // A concurrent duplicate either races the idempotency row insert (P2002) or finds it
    // still processing; wait briefly and replay the committed receipt instead of failing.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.idempotency.run(
          v.tenantId,
          `visitor:${v.visitorId}`,
          VISITOR_ROUTE,
          key,
          input,
          async () => {
            await this.chats.assertNotBanned(v);
            const prepared = await this.validate(v, input);
            await this.enforceRateLimits(v, prepared.hourlyLimit);
            const receipt = await this.db.tx(v.tenantId, (tx) => this.persist(tx, v, input, prepared));
            if (receipt.sourceChatId) await this.routing.drainQueue(v.tenantId, 20).catch(() => undefined);
            return { status: 201, body: receipt };
          },
        );
      } catch (err) {
        const duplicateRace =
          (err as { code?: string }).code === 'P2002' ||
          (err instanceof AppError && err.code === 'IDEMPOTENCY_IN_PROGRESS');
        if (!duplicateRace || attempt >= DUPLICATE_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 100)));
      }
    }
  }

  private async validate(v: VisitorContext, input: OfflineSubmitInput) {
    const { policy, departments, customDefs, rawSettings, emailOfflineMessages } = await this.db.read(
      v.tenantId,
      async (tx) => {
        const [policy, departments, customDefs, tenant] = await Promise.all([
          this.policyFor(tx, v.siteId),
          tx.department.findMany({
            where: { tenantId: v.tenantId, enabled: true, archivedAt: null },
            select: { id: true, name: true, publicLabel: true },
            orderBy: { name: 'asc' },
          }),
          tx.customFieldDefinition.findMany({
            where: { tenantId: v.tenantId, archivedAt: null, publicWritable: true },
          }),
          tx.tenant.findUniqueOrThrow({ where: { id: v.tenantId }, select: { settings: true } }),
        ]);
        const notif =
          isObj(tenant.settings) && isObj(tenant.settings.notifications) ? tenant.settings.notifications : {};
        return {
          policy,
          departments,
          customDefs,
          rawSettings: tenant.settings,
          emailOfflineMessages: notif.emailOfflineMessages !== false,
        };
      },
    );
    if (!policy.enabled) throw conflict('CONFLICT', 'This site is not accepting offline messages right now');

    const errors: Record<string, string[]> = {};
    const add = (k: string, m: string) => (errors[k] ??= []).push(m);
    const message = (input.message ?? '').trim();
    const len = codePointLength(message);
    if (len < 1) add('message', 'Write a message');
    else if (len > 8000) add('message', 'Maximum 8000 characters');
    const name = input.name?.trim() || null;
    if (name && codePointLength(name) > 120) add('name', 'Maximum 120 characters');
    const email = input.email?.trim().toLowerCase() || null;
    if (email && (email.length > 254 || !EMAIL_RE.test(email))) add('email', 'Enter a valid email address');
    if (!email && policy.emailRequired) add('email', 'Enter your email address so we can reply');

    // Phone: top-level (widget) or fields.phone; stored encrypted inside custom_fields.
    const fields = { ...(input.fields ?? {}) };
    const rawPhone = input.phone ?? (typeof fields.phone === 'string' ? fields.phone : null);
    delete fields.phone;
    const phone = rawPhone?.trim() || null;
    // Optional phone is always accepted (widget contract); required only when the form config says so.
    if (phone && (phone.length > 40 || !PHONE_RE.test(phone) || !/\d/.test(phone)))
      add('phone', 'Use digits, spaces and + ( ) - . only');
    if (!phone && policy.phone === 'required') add('phone', 'Enter a phone number');

    const custom: Record<string, unknown> = {};
    // The wire pipe camelCases keys under `fields`, so match a definition by its key or its camelCase form.
    const defs = new Map(customDefs.flatMap((d) => [[d.key, d] as const, [camel(d.key), d] as const]));
    const keys = Object.keys(fields);
    if (keys.length > MAX_CUSTOM_FIELDS) add('fields', `At most ${MAX_CUSTOM_FIELDS} fields`);
    for (const k of keys.slice(0, MAX_CUSTOM_FIELDS)) {
      const def = defs.get(k);
      const val = fields[k];
      if (!def || k.startsWith('_')) {
        add(`fields.${k}`, 'This field is not accepted');
        continue;
      }
      const opts =
        isObj(def.validation) && Array.isArray(def.validation.options)
          ? (def.validation.options as unknown[]).map(String)
          : null;
      if (val === null || val === undefined || val === '') continue;
      if (def.dataType === 'number') {
        const n =
          typeof val === 'number' ? val : typeof val === 'string' && val.trim() !== '' ? Number(val) : NaN;
        if (!Number.isFinite(n)) add(`fields.${k}`, 'Enter a number');
        else custom[def.key] = n;
      } else if (def.dataType === 'boolean') {
        if (typeof val !== 'boolean') add(`fields.${k}`, 'Expected true or false');
        else custom[def.key] = val;
      } else if (typeof val !== 'string' || codePointLength(val) > 1000) {
        add(`fields.${k}`, 'Use text up to 1000 characters');
      } else if (opts && !opts.includes(val)) {
        add(`fields.${k}`, 'Choose one of the listed options');
      } else custom[def.key] = val.trim();
    }

    // Department: must be currently enabled; offer the current choices otherwise.
    const choices = departments.map((d) => ({ id: d.id, label: d.publicLabel || d.name }));
    let departmentId = input.departmentId ?? null;
    if (departmentId && policy.department === 'hidden' && !input.sourceChatId) departmentId = null;
    if (departmentId && !departments.some((d) => d.id === departmentId)) {
      throw new AppError(422, 'VALIDATION_FAILED', 'That department is not available. Choose another.', {
        fieldErrors: { ...errors, department_id: ['Choose one of the available departments'] },
        details: { departments: choices },
      });
    }
    if (!departmentId && !input.sourceChatId && policy.department === 'required' && choices.length)
      add('department_id', 'Choose a department');
    if (Object.keys(errors).length) {
      throw new AppError(422, 'VALIDATION_FAILED', 'Check the highlighted fields.', {
        fieldErrors: errors,
        ...(errors.department_id ? { details: { departments: choices } } : {}),
      });
    }
    return {
      message,
      name,
      email,
      phone,
      custom,
      departmentId,
      hourlyLimit: visitorHourlyLimit(rawSettings),
      notifications: {
        confirmation: policy.confirmationEnabled && email ? ('pending' as const) : ('disabled' as const),
        team: emailOfflineMessages ? ('pending' as const) : ('disabled' as const),
      },
    };
  }

  private async enforceRateLimits(v: VisitorContext, perHour: number): Promise<void> {
    const retryAfter = 3600 - (Math.floor(Date.now() / 1000) % 3600);
    if (!(await this.rateLimit.hit(`offline:v:${v.tenantId}:${v.visitorId}`, perHour, 3600)))
      throw rateLimited(retryAfter);
    if (
      v.ipNetHash &&
      !(await this.rateLimit.hit(`offline:ip:${v.ipNetHash}`, VISITOR_NETWORK_LIMIT_PER_HOUR, 3600))
    )
      throw rateLimited(retryAfter);
  }

  private async persist(
    tx: Tx,
    v: VisitorContext,
    input: OfflineSubmitInput,
    p: Awaited<ReturnType<OfflineService['validate']>>,
  ): Promise<OfflineReceipt> {
    let departmentId = p.departmentId;
    let conversionReason: string | null = null;
    if (input.sourceChatId) {
      // Queue conversion (ch. 23/75): withdraw the request and store the message in ONE transaction.
      const chat = await this.store.lockChat(tx, v.tenantId, input.sourceChatId).catch(() => null);
      if (!chat || chat.visitorId !== v.visitorId || chat.siteId !== v.siteId)
        throw fieldError('source_chat_id', 'Chat not found');
      if (chat.status === 'closed') throw conflict('CHAT_CLOSED', 'This chat has already ended');
      if (chat.status === 'active' || chat.ownerMembershipId)
        throw conflict('CHAT_ALREADY_ASSIGNED', 'An agent has already joined this chat');
      const exceeded = await tx.assignmentHistory.count({
        where: { tenantId: v.tenantId, chatId: chat.id, reason: 'max_wait_exceeded' },
      });
      conversionReason = exceeded ? 'max_wait_exceeded' : 'visitor_requested';
      departmentId ??= chat.departmentId;
      await this.chats.closeInTx(tx, chat, 'converted_offline', { kind: 'visitor', visitor: v });
    }
    let reference = newReference();
    for (
      let i = 0;
      i < 5 &&
      (await tx.offlineSubmission.findUnique({
        where: { tenantId_reference: { tenantId: v.tenantId, reference } },
        select: { id: true },
      }));
      i++
    )
      reference = newReference();
    const customFields: Record<string, unknown> = {
      ...p.custom,
      ...(p.phone ? { [PHONE_FIELD_KEY]: encrypt(p.phone) } : {}),
    };
    const sub = await tx.offlineSubmission.create({
      data: {
        tenantId: v.tenantId,
        siteId: v.siteId,
        visitorId: v.visitorId,
        sessionId: v.sessionId,
        departmentId,
        reference,
        name: p.name,
        emailCiphertext: p.email ? encrypt(p.email) : null,
        emailLookupHash: p.email ? emailLookupHash(p.email) : sha256(`email:none:${randomUUID()}`),
        message: p.message,
        customFields: customFields as Prisma.InputJsonValue,
        sourceChatId: input.sourceChatId ?? null,
        conversionReason,
        status: 'received',
      },
    });
    const summary = this.summary(sub);
    await this.outbox.append(tx, v.tenantId, {
      aggregateType: 'offline_submission',
      aggregateId: sub.id,
      aggregateVersion: sub.version,
      eventType: 'offline.submitted',
      payload: { submission: { ...summary, emailMasked: undefined, messagePreview: undefined } },
      scopes: [
        { kind: 'queue', id: queueScopeId(departmentId), audience: 'staff' },
        {
          kind: 'visitor',
          id: v.sessionId,
          audience: 'public',
          payload: {
            reference: sub.reference,
            status: sub.status,
            createdAt: sub.createdAt,
            sourceChatId: sub.sourceChatId,
          },
        },
      ],
    });
    return {
      id: sub.id,
      reference: sub.reference,
      status: 'received',
      createdAt: sub.createdAt,
      departmentId: sub.departmentId,
      sourceChatId: sub.sourceChatId,
      conversionReason,
      notifications: p.notifications,
    };
  }

  // ═════════════════════════════ Staff API ═════════════════════════════

  private scopeWhere(auth: AuthContext): Prisma.OfflineSubmissionWhereInput {
    if (auth.departmentScope === 'all') return {};
    return { OR: [{ departmentId: null }, { departmentId: { in: auth.departmentScope } }] };
  }

  private email(sub: OfflineSubmission): string {
    try {
      return sub.emailCiphertext ? decrypt(sub.emailCiphertext) : '';
    } catch {
      return '';
    }
  }

  private summary(sub: OfflineSubmission): OfflineSummary {
    return {
      id: sub.id,
      reference: sub.reference,
      siteId: sub.siteId,
      departmentId: sub.departmentId,
      visitorId: sub.visitorId,
      name: sub.name,
      emailMasked: maskEmail(this.email(sub)),
      messagePreview: [...sub.message].slice(0, 140).join(''),
      status: sub.status,
      sourceChatId: sub.sourceChatId,
      conversionReason: sub.conversionReason,
      handledAt: sub.handledAt,
      handledById: sub.handledById,
      createdAt: sub.createdAt,
      version: sub.version,
    };
  }

  private async detail(tx: Tx, sub: OfflineSubmission): Promise<OfflineDetail> {
    const custom = isObj(sub.customFields) ? { ...sub.customFields } : {};
    const phoneCipher =
      typeof custom[PHONE_FIELD_KEY] === 'string' ? (custom[PHONE_FIELD_KEY] as string) : null;
    delete custom[PHONE_FIELD_KEY];
    let phone: string | null = null;
    if (phoneCipher) {
      try {
        phone = decrypt(phoneCipher);
      } catch {
        phone = null;
      }
    }
    const handler = sub.handledById
      ? await tx.membership.findFirst({
          where: { tenantId: sub.tenantId, id: sub.handledById },
          include: { user: { select: { displayName: true } } },
        })
      : null;
    const replies = await this.db.root.outboundEmail.findMany({
      where: {
        tenantId: sub.tenantId,
        template: 'offline_reply',
        dedupeKey: { startsWith: `offline_reply:${sub.id}:` },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, createdAt: true, acceptedAt: true, textBody: true },
    });
    const { messagePreview: _p, ...base } = this.summary(sub);
    void _p;
    const email = this.email(sub);
    return {
      ...base,
      email: email || null,
      phone,
      message: sub.message,
      customFields: custom,
      handledBy: handler
        ? { id: handler.id, displayName: handler.displayName || handler.user.displayName }
        : null,
      // The exact text emailed to the submitter (scrubbed to "[erased]" by privacy erasure).
      replies: replies.map(({ textBody, ...r }) => ({ ...r, emailText: textBody })),
    };
  }

  private async visible(tx: Tx, auth: AuthContext, id: string, lock = false): Promise<OfflineSubmission> {
    if (lock)
      await tx.$queryRaw`SELECT id FROM offline_submissions WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    const sub = await tx.offlineSubmission.findFirst({
      where: { AND: [{ tenantId: auth.tenantId, id }, this.scopeWhere(auth)] },
    });
    if (!sub) throw notFound('Offline message');
    return sub;
  }

  async list(
    auth: AuthContext,
    q: { departmentId?: string; status?: string; cursor?: string; limit: number },
  ): Promise<Page<OfflineSummary>> {
    if (q.departmentId && auth.departmentScope !== 'all' && !auth.departmentScope.includes(q.departmentId))
      throw denied('You cannot view this department');
    const filterHash = sha256(JSON.stringify({ d: q.departmentId ?? null, s: q.status ?? null })).slice(
      0,
      16,
    );
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur)
      throw badRequest('This cursor does not match the current filters', { cursor: ['Invalid cursor'] });
    return this.db.read(auth.tenantId, async (tx) => {
      const and: Prisma.OfflineSubmissionWhereInput[] = [{ tenantId: auth.tenantId }, this.scopeWhere(auth)];
      if (q.departmentId) and.push({ departmentId: q.departmentId });
      if (q.status) and.push({ status: q.status });
      if (cur)
        and.push({
          OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }],
        });
      const rows = await tx.offlineSubmission.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const slice = rows.slice(0, q.limit);
      const last = slice[slice.length - 1];
      return page(
        slice.map((s) => this.summary(s)),
        rows.length > q.limit && last
          ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }, filterHash)
          : null,
      );
    });
  }

  async get(auth: AuthContext, id: string): Promise<OfflineDetail> {
    return this.db.read(auth.tenantId, async (tx) => this.detail(tx, await this.visible(tx, auth, id)));
  }

  private async emitUpdated(tx: Tx, sub: OfflineSubmission): Promise<void> {
    const scopes: OutboxScope[] = [{ kind: 'queue', id: queueScopeId(sub.departmentId), audience: 'staff' }];
    const s = this.summary(sub);
    await this.outbox.append(tx, sub.tenantId, {
      aggregateType: 'offline_submission',
      aggregateId: sub.id,
      aggregateVersion: sub.version,
      eventType: 'offline.updated',
      payload: { submission: { ...s, emailMasked: undefined, messagePreview: undefined } },
      scopes,
    });
  }

  async reply(
    auth: AuthContext,
    id: string,
    input: { body: string },
    idempotencyKey: string | null,
  ): Promise<OfflineDetail> {
    const body = input.body.trim();
    const len = codePointLength(body);
    if (len < 1 || len > 8000)
      throw badRequest('Write a reply (up to 8000 characters)', {
        body: [len < 1 ? 'Required' : 'Maximum 8000 characters'],
      });
    const run = await this.idempotency.run(
      auth.tenantId,
      `member:${auth.membershipId ?? auth.tokenId}`,
      `offline.reply:${id}`,
      idempotencyKey,
      input,
      async () => {
        const { sub, site } = await this.db.read(auth.tenantId, async (tx) => {
          const sub = await this.visible(tx, auth, id);
          const site = await tx.site.findFirst({
            where: { tenantId: auth.tenantId, id: sub.siteId },
            select: { name: true },
          });
          return { sub, site };
        });
        if (sub.status === 'erased') throw conflict('CONFLICT', 'This message was erased');
        const to = this.email(sub);
        if (!to) throw conflict('CONFLICT', 'This message has no email address to reply to');
        // The outbound row (deduplicated by reply key) is durable before the submission is marked handled.
        const replyKey = idempotencyKey ?? randomUUID();
        const sent = await this.mail.sendTemplate(
          'offline_reply',
          to,
          {
            site: site?.name ?? 'Support',
            reference: sub.reference,
            agent: auth.actorName.split(' ')[0] || 'Support',
            body,
          },
          `${sub.id}:${replyKey}`,
          auth.tenantId,
        );
        const detail = await this.db.tx(auth.tenantId, async (tx) => {
          const locked = await this.visible(tx, auth, id, true);
          const saved = await tx.offlineSubmission.update({
            where: { id: locked.id },
            data: {
              status: 'handled',
              handledAt: new Date(),
              handledById: auth.membershipId,
              version: { increment: 1 },
            },
          });
          await this.audit.inTx(tx, auth, {
            action: 'offline_submission.replied',
            objectType: 'offline_submission',
            objectId: id,
            safeDiff: { email_id: sent.id, status: saved.status, version: saved.version },
          });
          await this.emitUpdated(tx, saved);
          return this.detail(tx, saved);
        });
        return { status: 200, body: detail };
      },
    );
    return run.body;
  }

  async setStatus(
    auth: AuthContext,
    id: string,
    status: 'received' | 'handled',
    expectedVersion: number | null,
  ): Promise<OfflineDetail> {
    return this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'offline_submissions', auth.tenantId, id);
      const sub = await this.visible(tx, auth, id, true);
      if (sub.status === 'erased') throw conflict('CONFLICT', 'This message was erased');
      if (expectedVersion !== null && expectedVersion !== sub.version)
        throw conflict(
          'VERSION_CONFLICT',
          'This message was changed by someone else. Reload to continue.',
          false,
          { current_version: sub.version },
        );
      if (sub.status === status) return this.detail(tx, sub);
      const saved = await tx.offlineSubmission.update({
        where: { id: sub.id },
        data:
          status === 'handled'
            ? { status, handledAt: new Date(), handledById: auth.membershipId, version: { increment: 1 } }
            : { status, handledAt: null, handledById: null, version: { increment: 1 } },
      });
      await this.audit.inTx(tx, auth, {
        action: 'offline_submission.status_changed',
        objectType: 'offline_submission',
        objectId: id,
        safeDiff: { status: { from: sub.status, to: status }, version: saved.version },
      });
      await this.emitUpdated(tx, saved);
      return this.detail(tx, saved);
    });
  }
}
