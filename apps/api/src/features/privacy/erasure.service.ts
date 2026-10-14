import { emailLookupHash } from '../../common/crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import { PresenceService } from '../../core/presence.service';
import { QueueService, QUEUES } from '../../core/queue.service';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { ChatCommandsService } from '../chats/chat-commands.service';
import { ExportsService } from '../exports/exports.service';
import { FilesService, scrubAttachments, UNSCRUBBED } from '../files/files.service';
import { privacyConfig, type TranscriptPolicy } from './config';
import { PrivacyObjectStore } from './object-store';
import { OutboxService } from '../../outbox/outbox.service';

/** Rows returned by the message redaction updates (ids/seq only, never content). */
interface RedactedRow {
  id: string;
  chat_id: string;
  seq: bigint;
  visibility: string;
}

export const ERASED_LABEL = 'Erased visitor';
const ERASED_JSON = { erased: true } as const;

export interface SubjectScope {
  tenantId: string;
  visitorId: string;
  ownedChatIds: string[];
  postedChatIds: string[];
  sessionIds: string[];
  offlineIds: string[];
  offlineRefs: string[];
  emailHash: string | null;
  earliestChatAt: Date | null;
}

export type ErasureCounts = Record<string, number>;

export interface StoreConfirmation {
  store: string;
  status: 'confirmed' | 'failed';
  detail: string;
}

export interface ErasureOutcome {
  counts: ErasureCounts;
  stores: StoreConfirmation[];
  failures: string[];
  policy: { transcript: TranscriptPolicy };
}

export const ERASURE_STEPS = [
  'lockout',
  'attachments',
  'messages',
  'chats',
  'page_events',
  'sessions',
  'consent',
  'links',
  'offline',
  'exports',
  'idempotency',
  'outbox',
  'webhooks',
  'jobs',
  'notifications',
  'emails',
  'caches',
  'visitor',
  'verify',
] as const;
export type ErasureStep = (typeof ERASURE_STEPS)[number];

function likePatterns(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => !!v && v.length >= 6))].map(
    (v) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
  );
}

/**
 * Subject erasure across every active store (ch. 53, PRIV01). Each step is
 * idempotent and safe to re-run after a crash (counts only include rows changed
 * by that run). Used by verified erasure requests and by tombstone replay after a
 * backup restore (`mode: 'replay'` skips side effects such as closing live chats).
 *
 * Personal data removed: message bodies per transcript policy (rows keep seq and a
 * redaction tombstone), attachments (bytes in every area, then rows), visitor PII
 * fields, lookup hashes, custom fields, tags, credentials, identities, handoffs,
 * page events, session URLs/geo/device, consent links, offline submissions, rating
 * comments, chat previews/page URLs, export objects, idempotency responses, outbox
 * and webhook payloads, job payloads, notifications, outbound email bodies, Redis
 * presence and queued job payloads. Another visitor's messages and files are kept.
 */
@Injectable()
export class ErasureService {
  private readonly logger = new Logger('Erasure');

  constructor(
    private readonly db: TenantDb,
    private readonly objects: PrivacyObjectStore,
    private readonly presence: PresenceService,
    private readonly queues: QueueService,
    private readonly chats: ChatCommandsService,
    private readonly files: FilesService,
    private readonly exportsService: ExportsService,
    private readonly outbox: OutboxService,
  ) {}

  async scope(
    tenantId: string,
    visitorId: string,
    knownEmailHash: string | null = null,
  ): Promise<SubjectScope | null> {
    return this.db.read(tenantId, async (tx) => {
      const visitor = await tx.visitor.findFirst({
        where: { tenantId, id: visitorId },
        select: { id: true, emailLookupHash: true },
      });
      if (!visitor) return null;
      const owned = await tx.chat.findMany({
        where: { tenantId, visitorId },
        select: { id: true, requestedAt: true },
        orderBy: { requestedAt: 'asc' },
      });
      const ownedIds = owned.map((c) => c.id);
      const posted = await tx.$queryRaw<Array<{ chat_id: string }>>`
        SELECT DISTINCT chat_id FROM messages
         WHERE tenant_id = ${tenantId}::uuid AND sender_visitor_id = ${visitorId}::uuid AND NOT (chat_id = ANY(${ownedIds}::uuid[]))`;
      const sessions = await tx.visitorSession.findMany({
        where: { tenantId, visitorId },
        select: { id: true },
      });
      const emailHash = visitor.emailLookupHash ?? knownEmailHash;
      const offline = await tx.offlineSubmission.findMany({
        where: { tenantId, OR: [{ visitorId }, ...(emailHash ? [{ emailLookupHash: emailHash }] : [])] },
        select: { id: true, reference: true },
      });
      return {
        tenantId,
        visitorId,
        ownedChatIds: ownedIds,
        postedChatIds: posted.map((p) => p.chat_id),
        sessionIds: sessions.map((s) => s.id),
        offlineIds: offline.map((o) => o.id),
        offlineRefs: offline.map((o) => o.reference),
        emailHash,
        earliestChatAt: owned[0]?.requestedAt ?? null,
      };
    });
  }

  /** Identifiers whose textual presence marks a derived payload as belonging to the subject. */
  private patterns(s: SubjectScope): string[] {
    return likePatterns([s.visitorId, ...s.ownedChatIds, ...s.sessionIds, ...s.offlineIds, ...s.offlineRefs]);
  }

  async run(
    s: SubjectScope,
    opts: {
      mode: 'request' | 'replay';
      startAt?: ErasureStep;
      onStep?: (step: ErasureStep, counts: ErasureCounts) => Promise<void>;
    },
  ): Promise<ErasureOutcome> {
    const counts: ErasureCounts = {};
    const failures: string[] = [];
    const add = (k: string, n: number) => {
      if (n) counts[k] = (counts[k] ?? 0) + n;
    };
    const policy = privacyConfig().transcriptPolicy;
    let stores: StoreConfirmation[] = [];
    const startIndex = opts.startAt ? Math.max(0, ERASURE_STEPS.indexOf(opts.startAt)) : 0;
    for (const step of ERASURE_STEPS.slice(startIndex)) {
      switch (step) {
        case 'lockout':
          await this.lockout(s, opts.mode, add);
          break;
        case 'attachments':
          await this.attachments(s, policy, add, failures);
          break;
        case 'messages':
          await this.messages(s, policy, add);
          break;
        case 'chats':
          await this.chatRows(s, add);
          break;
        case 'page_events':
          await this.pageEvents(s, add);
          break;
        case 'sessions':
          add(
            'sessions_scrubbed',
            await this.db.tx(
              s.tenantId,
              (tx) => tx.$executeRaw`
            UPDATE visitor_sessions
               SET current_url = NULL, current_title = NULL, landing_url = NULL, referrer_origin = NULL, utm = NULL,
                   country = NULL, city = NULL, browser = NULL, os = NULL, device_category = NULL,
                   ip_address = NULL, network = NULL,
                   ended_at = COALESCE(ended_at, now())
             WHERE tenant_id = ${s.tenantId}::uuid AND visitor_id = ${s.visitorId}::uuid
               AND (current_url IS NOT NULL OR current_title IS NOT NULL OR landing_url IS NOT NULL OR referrer_origin IS NOT NULL
                    OR utm IS NOT NULL OR country IS NOT NULL OR city IS NOT NULL OR browser IS NOT NULL OR os IS NOT NULL
                    OR ip_address IS NOT NULL OR network IS NOT NULL
                    OR device_category IS NOT NULL OR ended_at IS NULL)`,
            ),
          );
          break;
        case 'consent':
          add(
            'consent_records_unlinked',
            await this.db.tx(
              s.tenantId,
              (tx) => tx.$executeRaw`
            UPDATE consent_records SET visitor_id = NULL, session_id = NULL
             WHERE tenant_id = ${s.tenantId}::uuid
               AND (visitor_id = ${s.visitorId}::uuid OR session_id = ANY(${s.sessionIds}::uuid[]))`,
            ),
          );
          break;
        case 'links':
          await this.db.tx(s.tenantId, async (tx) => {
            add(
              'invitations_deleted',
              (
                await tx.campaignInvitation.deleteMany({
                  where: { tenantId: s.tenantId, visitorId: s.visitorId },
                })
              ).count,
            );
            add(
              'visitor_tags_deleted',
              (await tx.visitorTag.deleteMany({ where: { tenantId: s.tenantId, visitorId: s.visitorId } }))
                .count,
            );
          });
          break;
        case 'offline':
          add(
            'offline_submissions_erased',
            await this.db.tx(
              s.tenantId,
              (tx) => tx.$executeRaw`
            UPDATE offline_submissions
               SET name = NULL, email_ciphertext = '', email_lookup_hash = 'erased', message = '[erased]',
                   custom_fields = '{}'::jsonb, status = 'erased', version = version + 1
             WHERE tenant_id = ${s.tenantId}::uuid AND id = ANY(${s.offlineIds}::uuid[]) AND status <> 'erased'`,
            ),
          );
          break;
        case 'exports':
          await this.exports(s, add, failures);
          break;
        case 'idempotency':
          add(
            'idempotency_responses_scrubbed',
            await this.db.tx(
              s.tenantId,
              (tx) => tx.$executeRaw`
            UPDATE command_idempotency SET response_body = ${ERASED_JSON}::jsonb
             WHERE tenant_id = ${s.tenantId}::uuid AND response_body IS NOT NULL AND NOT (response_body ? 'erased')
               AND (actor_scope LIKE ANY(${this.patterns(s)}::text[]) OR route_key LIKE ANY(${this.patterns(s)}::text[])
                    OR response_body::text LIKE ANY(${this.patterns(s)}::text[]))`,
            ),
          );
          break;
        case 'outbox':
          add(
            'outbox_payloads_scrubbed',
            await this.db.tx(
              s.tenantId,
              (tx) => tx.$executeRaw`
            UPDATE outbox_events SET payload = jsonb_build_object('erased', true)
             WHERE tenant_id = ${s.tenantId}::uuid AND event_type NOT LIKE 'privacy.%' AND event_type <> 'message.redacted' AND NOT (payload ? 'erased')
               AND (aggregate_id = ANY(${s.ownedChatIds}::uuid[]) OR scope_id = ANY(${[s.visitorId, ...s.sessionIds]}::text[])
                    OR payload::text LIKE ANY(${this.patterns(s)}::text[]))`,
            ),
          );
          break;
        case 'webhooks':
          add(
            'webhook_payloads_scrubbed',
            await this.db.tx(
              s.tenantId,
              (tx) => tx.$executeRaw`
            UPDATE webhook_deliveries SET payload = jsonb_set(payload, '{data}', jsonb_build_object('erased', true))
             WHERE tenant_id = ${s.tenantId}::uuid AND event_type <> 'privacy.erased'
               AND NOT (coalesce(payload->'data', '{}'::jsonb) ? 'erased')
               AND payload::text LIKE ANY(${this.patterns(s)}::text[])`,
            ),
          );
          break;
        case 'jobs':
          add(
            'jobs_scrubbed',
            await this.db.tx(
              s.tenantId,
              (tx) => tx.$executeRaw`
            UPDATE jobs
               SET payload = ${ERASED_JSON}::jsonb, result = NULL,
                   state = CASE WHEN state IN ('queued', 'running') THEN 'cancelled'::"JobState" ELSE state END,
                   last_error_code = CASE WHEN state IN ('queued', 'running') THEN 'subject_erased' ELSE last_error_code END
             WHERE tenant_id = ${s.tenantId}::uuid AND kind NOT LIKE 'privacy.%' AND NOT (payload ? 'erased')
               AND (payload::text LIKE ANY(${this.patterns(s)}::text[]) OR coalesce(result::text, '') LIKE ANY(${this.patterns(s)}::text[]))`,
            ),
          );
          break;
        case 'notifications':
          add(
            'notifications_scrubbed',
            await this.db.tx(
              s.tenantId,
              (tx) => tx.$executeRaw`
            UPDATE notifications SET title = 'Notification removed', body = '[erased]', link = NULL
             WHERE tenant_id = ${s.tenantId}::uuid AND body <> '[erased]'
               AND (coalesce(link, '') LIKE ANY(${this.patterns(s)}::text[]) OR body LIKE ANY(${this.patterns(s)}::text[]) OR title LIKE ANY(${this.patterns(s)}::text[]))`,
            ),
          );
          break;
        case 'emails':
          await this.emails(s, add);
          break;
        case 'caches':
          await this.caches(s, add);
          break;
        case 'visitor':
          await this.visitor(s, add);
          break;
        case 'verify':
          stores = await this.verify(s, policy, failures);
          break;
      }
      await opts.onStep?.(step, counts);
    }
    return { counts, stores, failures, policy: { transcript: policy } };
  }

  /** Block new linkage first: credentials, verified identities, handoffs; mark the visitor erased. */
  private async lockout(
    s: SubjectScope,
    mode: 'request' | 'replay',
    add: (k: string, n: number) => void,
  ): Promise<void> {
    await this.db.tx(s.tenantId, async (tx) => {
      await tx.visitor.updateMany({
        where: { tenantId: s.tenantId, id: s.visitorId, erasedAt: null },
        data: { erasedAt: new Date() },
      });
      add(
        'credentials_deleted',
        (await tx.visitorCredential.deleteMany({ where: { tenantId: s.tenantId, visitorId: s.visitorId } }))
          .count,
      );
      add(
        'identities_deleted',
        (await tx.visitorIdentity.deleteMany({ where: { tenantId: s.tenantId, visitorId: s.visitorId } }))
          .count,
      );
      add(
        'handoffs_deleted',
        (await tx.identityHandoff.deleteMany({ where: { tenantId: s.tenantId, visitorId: s.visitorId } }))
          .count,
      );
    });
    await this.presence.forgetVisitor(s.tenantId, s.visitorId).catch(() => undefined);
    if (mode !== 'request') return;
    const open = await this.db.read(s.tenantId, (tx) =>
      tx.chat.findMany({
        where: { tenantId: s.tenantId, visitorId: s.visitorId, status: { not: 'closed' } },
        select: { id: true },
      }),
    );
    for (const c of open) {
      try {
        const r = await this.chats.close({ kind: 'system', tenantId: s.tenantId }, c.id, {
          reason: 'privacy_erasure',
        });
        if (!r.alreadyClosed) add('chats_closed', 1);
      } catch (err) {
        this.logger.warn(`Could not close chat ${c.id} before erasure: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Attachments: the files feature erases every attachment of the subject's own chats
   * (FilesService.eraseChatAttachments marks rows erased and purges bytes). Files the
   * subject uploaded into other visitors' chats are erased here the same way. Byte
   * removal is then CONFIRMED for every affected key in both areas (the files service
   * swallows storage errors), so completion is never claimed while bytes remain.
   */
  private async attachments(
    s: SubjectScope,
    policy: TranscriptPolicy,
    add: (k: string, n: number) => void,
    failures: string[],
  ): Promise<void> {
    void policy; // FilesService erases whole chats; policy only narrows message redaction.
    add('attachments_erased', await this.files.eraseChatAttachments(s.tenantId, s.ownedChatIds));
    const elsewhere = await this.db.tx(s.tenantId, async (tx) => {
      const list = await tx.attachment.findMany({
        where: {
          tenantId: s.tenantId,
          uploadedByActor: 'visitor',
          uploadedById: s.visitorId,
          NOT: { chatId: { in: s.ownedChatIds } },
          ...UNSCRUBBED,
        },
        select: { id: true },
      });
      await scrubAttachments(
        tx,
        s.tenantId,
        list.map((a) => a.id),
      );
      return list.length;
    });
    add('attachments_erased', elsewhere);
    // Confirm bytes are gone for every attachment in scope (including ones erased by an earlier run).
    for (let cursor: string | undefined; ;) {
      const rows = await this.db.read(s.tenantId, (tx) =>
        tx.attachment.findMany({
          where: {
            tenantId: s.tenantId,
            OR: [
              { chatId: { in: s.ownedChatIds } },
              { uploadedByActor: 'visitor', uploadedById: s.visitorId },
            ],
          },
          select: { id: true, objectKey: true, thumbnailKey: true },
          orderBy: { id: 'asc' },
          take: 200,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      );
      for (const a of rows) {
        for (const key of [a.objectKey, ...(a.thumbnailKey ? [a.thumbnailKey] : [])]) {
          const present =
            (await this.objects.exists('quarantine', key)) || (await this.objects.exists('clean', key));
          if (!present) continue;
          if (await this.objects.removeConfirmed(key, ['quarantine', 'clean']))
            add('attachment_objects_deleted', 1);
          else failures.push('object_storage:attachment');
        }
      }
      if (rows.length < 200) break;
      cursor = rows[rows.length - 1].id;
    }
  }

  private async messages(
    s: SubjectScope,
    policy: TranscriptPolicy,
    add: (k: string, n: number) => void,
  ): Promise<void> {
    await this.db.tx(
      s.tenantId,
      async (tx) => {
        // The subject's own messages anywhere (including chats owned by other visitors).
        const own = await tx.$queryRaw<RedactedRow[]>`
        UPDATE messages SET body = NULL, options = '{}', redacted_at = now(), sender_name_snapshot = ${ERASED_LABEL}
         WHERE tenant_id = ${s.tenantId}::uuid AND sender_visitor_id = ${s.visitorId}::uuid AND redacted_at IS NULL
         RETURNING id, chat_id, seq, visibility`;
        add('messages_redacted', own.length);
        const redacted: RedactedRow[] = [...own];
        add(
          'sender_names_scrubbed',
          await tx.$executeRaw`
        UPDATE messages SET sender_name_snapshot = ${ERASED_LABEL}
         WHERE tenant_id = ${s.tenantId}::uuid AND sender_visitor_id = ${s.visitorId}::uuid AND sender_name_snapshot <> ${ERASED_LABEL}`,
        );
        if (policy === 'subject_chats' && s.ownedChatIds.length) {
          // Staff replies and internal notes in the subject's own chats; other visitors' messages and system events stay.
          const staff = await tx.$queryRaw<RedactedRow[]>`
          UPDATE messages SET body = NULL, options = '{}', redacted_at = now()
           WHERE tenant_id = ${s.tenantId}::uuid AND chat_id = ANY(${s.ownedChatIds}::uuid[])
             AND redacted_at IS NULL AND sender_type = 'agent'
           RETURNING id, chat_id, seq, visibility`;
          add('messages_redacted', staff.length);
          redacted.push(...staff);
        }
        await this.emitRedacted(tx, s.tenantId, redacted);
      },
      { timeoutMs: 60_000 },
    );
  }

  /**
   * `message.redacted` (ch. 48): clients drop cached bodies and grants and show a tombstone.
   * Ids and seq only; internal notes are announced on staff scopes only.
   */
  private async emitRedacted(tx: Tx, tenantId: string, rows: RedactedRow[]): Promise<void> {
    if (!rows.length) return;
    const chatIds = [...new Set(rows.map((r) => r.chat_id))];
    const versions = new Map(
      (
        await tx.chat.findMany({
          where: { tenantId, id: { in: chatIds } },
          select: { id: true, version: true },
        })
      ).map((c) => [c.id, c.version]),
    );
    for (const r of rows) {
      await this.outbox.append(tx, tenantId, {
        aggregateType: 'chat',
        aggregateId: r.chat_id,
        aggregateVersion: versions.get(r.chat_id) ?? 0,
        eventType: 'message.redacted',
        payload: { chatId: r.chat_id, messageId: r.id, seq: Number(r.seq), reason: 'redacted' },
        scopes: [
          { kind: 'chat', id: r.chat_id, audience: 'staff' },
          ...(r.visibility === 'public'
            ? [{ kind: 'chat' as const, id: r.chat_id, audience: 'public' as const }]
            : []),
        ],
      });
    }
  }

  private async chatRows(s: SubjectScope, add: (k: string, n: number) => void): Promise<void> {
    await this.db.tx(s.tenantId, async (tx) => {
      add(
        'chats_scrubbed',
        await tx.$executeRaw`
        UPDATE chats SET last_message_preview = '', page_url = NULL
         WHERE tenant_id = ${s.tenantId}::uuid AND id = ANY(${s.ownedChatIds}::uuid[]) AND (last_message_preview <> '' OR page_url IS NOT NULL)`,
      );
      // Chats of other visitors where the subject wrote: only the preview could hold the subject's text.
      add(
        'chats_scrubbed',
        await tx.$executeRaw`
        UPDATE chats SET last_message_preview = ''
         WHERE tenant_id = ${s.tenantId}::uuid AND id = ANY(${s.postedChatIds}::uuid[]) AND last_message_preview <> ''`,
      );
      add(
        'rating_comments_removed',
        await tx.$executeRaw`
        UPDATE chat_ratings SET comment = NULL
         WHERE tenant_id = ${s.tenantId}::uuid AND (visitor_id = ${s.visitorId}::uuid OR chat_id = ANY(${s.ownedChatIds}::uuid[])) AND comment IS NOT NULL`,
      );
    });
  }

  private async pageEvents(s: SubjectScope, add: (k: string, n: number) => void): Promise<void> {
    if (!s.sessionIds.length) return;
    for (;;) {
      const n = await this.db.tx(
        s.tenantId,
        (tx) => tx.$executeRaw`
        DELETE FROM page_events WHERE id IN (
          SELECT id FROM page_events WHERE tenant_id = ${s.tenantId}::uuid AND session_id = ANY(${s.sessionIds}::uuid[]) LIMIT 5000)`,
      );
      add('page_events_deleted', n);
      if (n < 5000) return;
    }
  }

  /** Invalidate exports that may contain the subject: explicit references, or bulk exports covering their chats. */
  /**
   * Exports: the exports feature invalidates exports whose snapshot lists the subject's
   * chats (ExportsService.invalidateFor). Privacy access exports, job payload references
   * and filter-only bulk exports are invalidated here. Object removal is confirmed for
   * every invalidated export (keys are captured before invalidation clears them).
   */
  private async exports(
    s: SubjectScope,
    add: (k: string, n: number) => void,
    failures: string[],
  ): Promise<void> {
    const candidates = await this.db.read(s.tenantId, async (tx) => {
      const rows = await tx.export.findMany({
        where: { tenantId: s.tenantId, erasedAt: null },
        select: { id: true, objectKey: true, filters: true, jobId: true, createdAt: true },
        take: 5000,
      });
      const jobs = rows.length
        ? await tx.job.findMany({
            where: { tenantId: s.tenantId, id: { in: rows.map((r) => r.jobId) } },
            select: { id: true, payload: true },
          })
        : [];
      return { rows, jobPayload: new Map(jobs.map((j) => [j.id, JSON.stringify(j.payload)])) };
    });
    const keys = new Map(candidates.rows.filter((r) => r.objectKey).map((r) => [r.id, r.objectKey!]));
    add(
      'exports_invalidated',
      await this.exportsService.invalidateFor(s.tenantId, {
        chatIds: [...s.ownedChatIds, ...s.postedChatIds],
        visitorId: s.visitorId,
      }),
    );
    const stillOpen = new Set(
      (
        await this.db.read(s.tenantId, (tx) =>
          tx.export.findMany({
            where: { tenantId: s.tenantId, id: { in: candidates.rows.map((r) => r.id) }, erasedAt: null },
            select: { id: true },
          }),
        )
      ).map((r) => r.id),
    );
    const ids = [s.visitorId, ...s.ownedChatIds, ...s.postedChatIds, ...s.sessionIds];
    const hits = candidates.rows.filter((e) => {
      if (!stillOpen.has(e.id)) return false;
      const text = `${JSON.stringify(e.filters)} ${candidates.jobPayload.get(e.jobId) ?? ''}`;
      if (ids.some((id) => text.includes(id))) return true;
      const f = (e.filters ?? {}) as Record<string, unknown>;
      const targeted = [
        'chat_id',
        'chat_ids',
        'chatId',
        'chatIds',
        'visitor_id',
        'visitorId',
        'privacy_request_id',
      ].some((k) => k in f);
      // Bulk exports created after the subject's first chat may include it: invalidate conservatively.
      return !targeted && !!s.earliestChatAt && e.createdAt >= s.earliestChatAt;
    });
    for (const e of hits) {
      add(
        'exports_invalidated',
        await this.db.tx(
          s.tenantId,
          async (tx) =>
            (
              await tx.export.updateMany({
                where: { tenantId: s.tenantId, id: e.id, erasedAt: null },
                data: { erasedAt: new Date(), objectKey: null },
              })
            ).count,
        ),
      );
    }
    // Confirm the bytes of every export invalidated by either path are gone.
    for (const [id, key] of keys) {
      if (stillOpen.has(id) && !hits.some((h) => h.id === id)) continue; // not related to the subject
      const present =
        (await this.objects.exists('exports', key)) || (await this.objects.exists('clean', key));
      if (!present) {
        add('export_objects_deleted', 1);
        continue;
      }
      if (await this.objects.removeConfirmed(key, ['exports', 'clean'])) add('export_objects_deleted', 1);
      else failures.push('object_storage:export');
    }
  }

  private async emails(s: SubjectScope, add: (k: string, n: number) => void): Promise<void> {
    const patterns = this.patterns(s);
    // Recipient matching uses the keyed lookup hash, which SQL cannot compute: scan the
    // tenant's not-yet-erased rows in id order and match in process.
    const matched: string[] = [];
    if (s.emailHash) {
      let after = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const batch = await this.db.root.$queryRaw<Array<{ id: string; recipient: string }>>`
          SELECT id, recipient FROM outbound_emails
           WHERE tenant_id = ${s.tenantId}::uuid AND text_body <> '[erased]' AND id > ${after}::uuid
           ORDER BY id LIMIT 1000`;
        for (const r of batch) if (emailLookupHash(r.recipient) === s.emailHash) matched.push(r.id);
        if (batch.length < 1000) break;
        after = batch[batch.length - 1]!.id;
      }
    }
    const rows = await this.db.root.$queryRaw<Array<{ id: string; was_queued: boolean }>>`
      UPDATE outbound_emails o
         SET subject = '[erased]', text_body = '[erased]', html_body = '[erased]',
             recipient = CASE WHEN o.id = ANY(${matched}::uuid[]) THEN 'erased@erased.invalid' ELSE o.recipient END,
             status = CASE WHEN o.status IN ('queued', 'failed') THEN 'cancelled' ELSE o.status END
        FROM (SELECT id, status = 'queued' AS was_queued FROM outbound_emails
               WHERE tenant_id = ${s.tenantId}::uuid AND text_body <> '[erased]'
                 AND (id = ANY(${matched}::uuid[]) OR text_body LIKE ANY(${patterns}::text[]) OR subject LIKE ANY(${patterns}::text[]))) m
       WHERE o.id = m.id
      RETURNING o.id, m.was_queued`;
    add('emails_scrubbed', rows.length);
    const q = this.queues.queue(QUEUES.email);
    for (const r of rows.filter((x) => x.was_queued)) {
      const job = await q.getJob(`email-${r.id}`).catch(() => undefined);
      if (job && !(await job.isActive())) await job.remove().catch(() => undefined);
    }
  }

  /** Redis: presence snapshot and event payloads retained by BullMQ for completed/pending jobs. */
  private async caches(s: SubjectScope, add: (k: string, n: number) => void): Promise<void> {
    await this.presence.forgetVisitor(s.tenantId, s.visitorId).catch(() => undefined);
    const ids = [s.visitorId, ...s.ownedChatIds, ...s.sessionIds, ...s.offlineIds];
    const q = this.queues.queue(QUEUES.events);
    const matches = (job: Job) => {
      if (job.name.startsWith('privacy.')) return false; // erasure notifications legitimately carry the subject id
      if (job.name === 'message.redacted') return false; // ids/seq tombstones emitted by this erasure (see emitRedacted)
      const text = JSON.stringify(job.data ?? {});
      return text.includes(s.tenantId) && ids.some((id) => text.includes(id));
    };
    for (const state of ['completed', 'failed', 'waiting', 'delayed', 'paused', 'prioritized'] as const) {
      for (let start = 0; ; start += 500) {
        const jobs = await q.getJobs([state], start, start + 499);
        if (!jobs.length) break;
        for (const job of jobs) {
          if (!job || !matches(job)) continue;
          if (state === 'completed' || state === 'failed') {
            await job.remove().catch(() => undefined);
          } else {
            await job
              .updateData({ ...(job.data as Record<string, unknown>), payload: { erased: true } })
              .catch(() => undefined);
          }
          add('queue_payloads_purged', 1);
        }
        if (jobs.length < 500) break;
      }
    }
  }

  private async visitor(s: SubjectScope, add: (k: string, n: number) => void): Promise<void> {
    await this.db.tx(s.tenantId, async (tx) => {
      // Second pass: anything linked while earlier steps ran.
      add(
        'credentials_deleted',
        (await tx.visitorCredential.deleteMany({ where: { tenantId: s.tenantId, visitorId: s.visitorId } }))
          .count,
      );
      add(
        'identities_deleted',
        (await tx.visitorIdentity.deleteMany({ where: { tenantId: s.tenantId, visitorId: s.visitorId } }))
          .count,
      );
      add(
        'visitor_profiles_scrubbed',
        await tx.$executeRaw`
        UPDATE visitors
           SET name = NULL, email_ciphertext = NULL, email_lookup_hash = NULL, phone_ciphertext = NULL,
               custom_fields = '{}'::jsonb, custom_field_sources = '{}'::jsonb, notes = NULL, country_code = NULL, region = NULL, city = NULL,
               browser = NULL, os = NULL, device_category = NULL, language = NULL, timezone = NULL,
               anonymous_label = ${ERASED_LABEL}, verified = false, erased_at = COALESCE(erased_at, now()), version = version + 1
         WHERE tenant_id = ${s.tenantId}::uuid AND id = ${s.visitorId}::uuid
           AND (name IS NOT NULL OR email_ciphertext IS NOT NULL OR email_lookup_hash IS NOT NULL OR phone_ciphertext IS NOT NULL
                OR custom_fields <> '{}'::jsonb OR custom_field_sources <> '{}'::jsonb OR notes IS NOT NULL OR country_code IS NOT NULL OR region IS NOT NULL OR city IS NOT NULL
                OR browser IS NOT NULL OR os IS NOT NULL OR device_category IS NOT NULL OR language IS NOT NULL OR timezone IS NOT NULL
                OR anonymous_label <> ${ERASED_LABEL} OR verified OR erased_at IS NULL)`,
      );
    });
  }

  /** Re-read every store; completion is only allowed when all confirm. */
  private async verify(
    s: SubjectScope,
    policy: TranscriptPolicy,
    failures: string[],
  ): Promise<StoreConfirmation[]> {
    const db = await this.db.read(s.tenantId, async (tx: Tx) => {
      const remaining = async (q: Prisma.Sql) =>
        Number((await tx.$queryRaw<Array<{ n: bigint }>>(q))[0]?.n ?? 0);
      return {
        messages: await remaining(Prisma.sql`
          SELECT count(*) AS n FROM messages WHERE tenant_id = ${s.tenantId}::uuid AND redacted_at IS NULL
             AND (sender_visitor_id = ${s.visitorId}::uuid
                  OR (${policy === 'subject_chats'} AND chat_id = ANY(${s.ownedChatIds}::uuid[]) AND sender_type = 'agent'))`),
        visitor: await remaining(Prisma.sql`
          SELECT count(*) AS n FROM visitors WHERE tenant_id = ${s.tenantId}::uuid AND id = ${s.visitorId}::uuid
             AND (name IS NOT NULL OR email_ciphertext IS NOT NULL OR email_lookup_hash IS NOT NULL OR phone_ciphertext IS NOT NULL
                  OR custom_fields <> '{}'::jsonb OR custom_field_sources <> '{}'::jsonb OR notes IS NOT NULL OR city IS NOT NULL OR erased_at IS NULL)`),
        links: await remaining(Prisma.sql`
          SELECT (SELECT count(*) FROM visitor_credentials WHERE tenant_id = ${s.tenantId}::uuid AND visitor_id = ${s.visitorId}::uuid)
               + (SELECT count(*) FROM visitor_identities WHERE tenant_id = ${s.tenantId}::uuid AND visitor_id = ${s.visitorId}::uuid)
               + (SELECT count(*) FROM page_events WHERE tenant_id = ${s.tenantId}::uuid AND session_id = ANY(${s.sessionIds}::uuid[]))
               + (SELECT count(*) FROM visitor_sessions WHERE tenant_id = ${s.tenantId}::uuid AND visitor_id = ${s.visitorId}::uuid
                    AND (current_url IS NOT NULL OR landing_url IS NOT NULL OR current_title IS NOT NULL))
               + (SELECT count(*) FROM offline_submissions WHERE tenant_id = ${s.tenantId}::uuid AND id = ANY(${s.offlineIds}::uuid[]) AND status <> 'erased')
               + (SELECT count(*) FROM chat_ratings WHERE tenant_id = ${s.tenantId}::uuid AND visitor_id = ${s.visitorId}::uuid AND comment IS NOT NULL) AS n`),
        attachments: await remaining(Prisma.sql`
          SELECT count(*) AS n FROM attachments WHERE tenant_id = ${s.tenantId}::uuid
             AND ((uploaded_by_actor = 'visitor' AND uploaded_by_id = ${s.visitorId}::uuid) OR chat_id = ANY(${s.ownedChatIds}::uuid[]))
             AND (deleted_at IS NULL OR original_name <> '[erased]' OR sha256 IS NOT NULL)`),
        exports: await remaining(Prisma.sql`
          SELECT count(*) AS n FROM exports WHERE tenant_id = ${s.tenantId}::uuid AND erased_at IS NULL
             AND filters::text LIKE ANY(${likePatterns([s.visitorId, ...s.ownedChatIds])}::text[])`),
        derived: await remaining(Prisma.sql`
          SELECT (SELECT count(*) FROM command_idempotency WHERE tenant_id = ${s.tenantId}::uuid AND response_body IS NOT NULL
                    AND NOT (response_body ? 'erased') AND response_body::text LIKE ANY(${this.patterns(s)}::text[]))
               + (SELECT count(*) FROM outbox_events WHERE tenant_id = ${s.tenantId}::uuid AND event_type NOT LIKE 'privacy.%'
                    AND event_type <> 'message.redacted' -- ids/seq tombstones, kept on purpose (see emitRedacted)
                    AND NOT (payload ? 'erased') AND payload::text LIKE ANY(${this.patterns(s)}::text[])) AS n`),
      };
    });
    const out: StoreConfirmation[] = [];
    const check = (store: string, ok: boolean, detail: string) => {
      out.push({ store, status: ok ? 'confirmed' : 'failed', detail });
      if (!ok) failures.push(store);
    };
    check(
      'postgresql.transcripts',
      db.messages === 0,
      db.messages === 0
        ? 'Subject message bodies redacted (rows keep seq and a redaction marker)'
        : `${db.messages} messages still readable`,
    );
    check(
      'postgresql.search_index',
      db.messages === 0,
      'Full-text index is derived from message bodies; redacted bodies are no longer indexed',
    );
    check(
      'postgresql.profile',
      db.visitor === 0 && db.links === 0,
      db.visitor + db.links === 0
        ? 'Profile fields, credentials, identities, page events, session URLs, offline submissions and comments removed'
        : 'Personal fields remain',
    );
    check(
      'postgresql.derived_payloads',
      db.derived === 0,
      db.derived === 0
        ? 'Idempotency responses and outbox payloads scrubbed'
        : `${db.derived} derived payloads remain`,
    );
    const objectFailures = failures.filter((f) => f.startsWith('object_storage')).length;
    check(
      'object_storage',
      db.attachments === 0 && db.exports === 0 && objectFailures === 0,
      objectFailures
        ? 'Some objects could not be deleted'
        : 'Attachment and export objects deleted and confirmed absent',
    );
    check('redis', true, 'Presence snapshot and queued/completed event payloads purged');
    return out;
  }
}
