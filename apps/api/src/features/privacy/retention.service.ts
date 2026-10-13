import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mergeOrgSettings } from '@talkivio/contracts';
import { AuditService } from '../../common/audit.service';
import { RedisService } from '../../common/redis.service';
import { TenantDb } from '../../db/tenant-db';
import { privacyConfig } from './config';
import { ExportsService } from '../exports/exports.service';
import { FilesService } from '../files/files.service';
import { PrivacyObjectStore } from './object-store';

const DAY = 86_400_000;

export interface RetentionReport {
  dryRun: boolean;
  generatedAt: Date;
  policy: {
    transcriptRetentionDays: number;
    pageEventRetentionDays: number;
    webhookDeliveryRetentionDays: number;
    verificationEvidenceRetentionDays: number;
    batchSize: number;
  };
  cutoffs: { transcripts: Date; pageEvents: Date; webhookDeliveries: Date; verificationEvidence: Date };
  /** Rows that are (dry run) or were (run) in scope of this batch. */
  targets: {
    closedChats: number;
    messages: number;
    attachments: number;
    /** Unexpired transcript exports covering a chat in the batch (invalidated, bytes deleted). */
    transcriptExports: number;
    pageEvents: number;
    expiredPrivacyExports: number;
    webhookDeliveries: number;
    verificationEvidence: number;
  };
  remainingAfterBatch: boolean;
  legalHolds: { modeled: false; note: string };
  failures: string[];
}

/**
 * Retention (ch. 53): `tenants.retention_days` applies to closed chats (messages and
 * attachment bytes/rows are deleted, and transcript exports covering the chat are invalidated; the chat row keeps
 * non-identifying metadata for analytics), `settings.tracking.pageEventRetentionDays` to page events, plus expired
 * privacy access exports, finished webhook delivery history and verification
 * evidence references. Work happens in bounded batches; `preview` is the dry run.
 * Legal holds are not modeled in this release (no hold table exists), so nothing is
 * exempted — this is stated in every report.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger('Retention');

  constructor(
    private readonly db: TenantDb,
    private readonly objects: PrivacyObjectStore,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly exportsService: ExportsService,
  ) {}

  private async policy(tenantId: string) {
    const cfg = privacyConfig();
    const t = await this.db.read(tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { retentionDays: true, settings: true },
      }),
    );
    const settings = mergeOrgSettings(t.settings);
    const now = Date.now();
    const policy = {
      transcriptRetentionDays: t.retentionDays,
      pageEventRetentionDays: settings.tracking.pageEventRetentionDays,
      webhookDeliveryRetentionDays: cfg.webhookDeliveryRetentionDays,
      verificationEvidenceRetentionDays: cfg.proofRetentionDays,
      batchSize: cfg.retentionBatch,
    };
    const cutoffs = {
      transcripts: new Date(now - policy.transcriptRetentionDays * DAY),
      pageEvents: new Date(now - policy.pageEventRetentionDays * DAY),
      webhookDeliveries: new Date(now - policy.webhookDeliveryRetentionDays * DAY),
      verificationEvidence: new Date(now - policy.verificationEvidenceRetentionDays * DAY),
    };
    return { policy, cutoffs };
  }

  private chatsWhere(tenantId: string, cutoff: Date): Prisma.Sql {
    return Prisma.sql`c.tenant_id = ${tenantId}::uuid AND c.status = 'closed' AND c.closed_at < ${cutoff}
      AND (c.last_message_preview <> '' OR c.page_url IS NOT NULL
           OR EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.chat_id = c.id)
           OR EXISTS (SELECT 1 FROM attachments a WHERE a.tenant_id = c.tenant_id AND a.chat_id = c.id AND a.deleted_at IS NULL))`;
  }

  private legal() {
    return {
      modeled: false as const,
      note: 'Legal holds are not modeled in this release; no records are exempted from retention.',
    };
  }

  /** Dry run: what the next batch would touch, and whether more remains. */
  async preview(tenantId: string): Promise<RetentionReport> {
    const { policy, cutoffs } = await this.policy(tenantId);
    const n = (rows: Array<{ n: bigint }>) => Number(rows[0]?.n ?? 0);
    const totals = await this.db.read(tenantId, async (tx) => {
      const chats = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT c.id FROM chats c WHERE ${this.chatsWhere(tenantId, cutoffs.transcripts)} ORDER BY c.closed_at LIMIT ${policy.batchSize}`;
      const chatIds = chats.map((c) => c.id);
      const allChats = n(
        await tx.$queryRaw`SELECT count(*) AS n FROM chats c WHERE ${this.chatsWhere(tenantId, cutoffs.transcripts)}`,
      );
      return {
        closedChats: chatIds.length,
        allChats,
        messages: n(
          await tx.$queryRaw`SELECT count(*) AS n FROM messages WHERE tenant_id = ${tenantId}::uuid AND chat_id = ANY(${chatIds}::uuid[])`,
        ),
        attachments: n(
          await tx.$queryRaw`SELECT count(*) AS n FROM attachments WHERE tenant_id = ${tenantId}::uuid AND chat_id = ANY(${chatIds}::uuid[]) AND deleted_at IS NULL`,
        ),
        transcriptExports: n(
          await tx.$queryRaw`SELECT count(*) AS n FROM exports WHERE tenant_id = ${tenantId}::uuid AND erased_at IS NULL AND filters->'chatIds' ?| ${chatIds}::text[]`,
        ),
        pageEvents: n(
          await tx.$queryRaw`SELECT count(*) AS n FROM page_events WHERE tenant_id = ${tenantId}::uuid AND received_at < ${cutoffs.pageEvents}`,
        ),
        expiredPrivacyExports: n(
          await tx.$queryRaw`SELECT count(*) AS n FROM exports WHERE tenant_id = ${tenantId}::uuid AND erased_at IS NULL AND expires_at < now() AND filters ? 'privacy_request_id'`,
        ),
        webhookDeliveries: n(
          await tx.$queryRaw`SELECT count(*) AS n FROM webhook_deliveries WHERE tenant_id = ${tenantId}::uuid AND created_at < ${cutoffs.webhookDeliveries} AND status IN ('delivered', 'failed', 'dead', 'cancelled')`,
        ),
        verificationEvidence: n(
          await tx.$queryRaw`SELECT count(*) AS n FROM privacy_requests WHERE tenant_id = ${tenantId}::uuid AND proof_reference IS NOT NULL AND state IN ('completed', 'failed') AND updated_at < ${cutoffs.verificationEvidence}`,
        ),
      };
    });
    const pageBatch = policy.batchSize * 25;
    return {
      dryRun: true,
      generatedAt: new Date(),
      policy,
      cutoffs,
      targets: {
        closedChats: totals.closedChats,
        messages: totals.messages,
        attachments: totals.attachments,
        transcriptExports: totals.transcriptExports,
        pageEvents: Math.min(totals.pageEvents, pageBatch),
        expiredPrivacyExports: Math.min(totals.expiredPrivacyExports, policy.batchSize),
        webhookDeliveries: Math.min(totals.webhookDeliveries, pageBatch),
        verificationEvidence: Math.min(totals.verificationEvidence, policy.batchSize),
      },
      remainingAfterBatch:
        totals.allChats > totals.closedChats ||
        totals.pageEvents > pageBatch ||
        totals.webhookDeliveries > pageBatch ||
        totals.expiredPrivacyExports > policy.batchSize,
      legalHolds: this.legal(),
      failures: [],
    };
  }

  /** Apply one bounded batch for a tenant. */
  async runTenant(tenantId: string): Promise<RetentionReport> {
    const { policy, cutoffs } = await this.policy(tenantId);
    const failures: string[] = [];
    const targets = {
      closedChats: 0,
      messages: 0,
      attachments: 0,
      transcriptExports: 0,
      pageEvents: 0,
      expiredPrivacyExports: 0,
      webhookDeliveries: 0,
      verificationEvidence: 0,
    };
    const chats = await this.db.read(
      tenantId,
      (tx) =>
        tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT c.id FROM chats c WHERE ${this.chatsWhere(tenantId, cutoffs.transcripts)} ORDER BY c.closed_at LIMIT ${policy.batchSize}`,
    );
    for (const { id: chatId } of chats) {
      // Bytes and rows via the files feature (rows become erased tombstones), then confirm absence.
      targets.attachments += await this.files.eraseChatAttachments(tenantId, [chatId]);
      // Exports are short-lived (24 h) but one created before the cutoff still holds this transcript.
      targets.transcriptExports += await this.exportsService.invalidateFor(tenantId, { chatIds: [chatId] });
      const files = await this.db.read(tenantId, (tx) =>
        tx.attachment.findMany({
          where: { tenantId, chatId },
          select: { id: true, objectKey: true, thumbnailKey: true },
        }),
      );
      let allGone = true;
      for (const f of files) {
        for (const key of [f.objectKey, ...(f.thumbnailKey ? [f.thumbnailKey] : [])]) {
          if ((await this.objects.exists('quarantine', key)) || (await this.objects.exists('clean', key))) {
            if (!(await this.objects.removeConfirmed(key, ['quarantine', 'clean']))) {
              allGone = false;
              failures.push(`attachment:${f.id}`);
            }
          }
        }
      }
      if (!allGone) continue; // keep the transcript until every file is gone; retried next run
      await this.db.tx(
        tenantId,
        async (tx) => {
          targets.messages += (await tx.message.deleteMany({ where: { tenantId, chatId } })).count;
          await tx.chat.update({ where: { id: chatId }, data: { lastMessagePreview: '', pageUrl: null } });
          await tx.chatRating.updateMany({
            where: { tenantId, chatId, comment: { not: null } },
            data: { comment: null },
          });
          targets.closedChats += 1;
        },
        { timeoutMs: 60_000 },
      );
    }
    const pageBatch = policy.batchSize * 25;
    targets.pageEvents = await this.db.tx(
      tenantId,
      (tx) => tx.$executeRaw`
      DELETE FROM page_events WHERE id IN (
        SELECT id FROM page_events WHERE tenant_id = ${tenantId}::uuid AND received_at < ${cutoffs.pageEvents} LIMIT ${pageBatch})`,
    );
    const expired = await this.db.read(
      tenantId,
      (tx) =>
        tx.$queryRaw<Array<{ id: string; objectKey: string | null }>>`
        SELECT id, object_key AS "objectKey" FROM exports
         WHERE tenant_id = ${tenantId}::uuid AND erased_at IS NULL AND expires_at < now() AND filters ? 'privacy_request_id'
         ORDER BY expires_at LIMIT ${policy.batchSize}`,
    );
    for (const e of expired) {
      if (e.objectKey && !(await this.objects.removeConfirmed(e.objectKey, ['exports']))) {
        failures.push(`export:${e.id}`);
        continue;
      }
      targets.expiredPrivacyExports += await this.db.tx(
        tenantId,
        async (tx) =>
          (
            await tx.export.updateMany({
              where: { tenantId, id: e.id },
              data: { erasedAt: new Date(), objectKey: null },
            })
          ).count,
      );
    }
    targets.webhookDeliveries = await this.db.tx(
      tenantId,
      (tx) => tx.$executeRaw`
      DELETE FROM webhook_deliveries WHERE id IN (
        SELECT id FROM webhook_deliveries WHERE tenant_id = ${tenantId}::uuid AND created_at < ${cutoffs.webhookDeliveries}
           AND status IN ('delivered', 'failed', 'dead', 'cancelled') LIMIT ${pageBatch})`,
    );
    targets.verificationEvidence = await this.db.tx(
      tenantId,
      (tx) => tx.$executeRaw`
      UPDATE privacy_requests SET proof_reference = NULL
       WHERE id IN (SELECT id FROM privacy_requests WHERE tenant_id = ${tenantId}::uuid AND proof_reference IS NOT NULL
                       AND state IN ('completed', 'failed') AND updated_at < ${cutoffs.verificationEvidence} LIMIT ${policy.batchSize})`,
    );
    const total = Object.values(targets).reduce((a, b) => a + b, 0);
    if (total || failures.length) {
      await this.audit.system(tenantId, {
        action: 'retention.applied',
        objectType: 'tenant',
        objectId: tenantId,
        outcome: failures.length ? 'failure' : 'success',
        safeDiff: {
          chat_transcripts: targets.closedChats,
          transcript_rows: targets.messages,
          files: targets.attachments,
          transcript_exports: targets.transcriptExports,
          page_events: targets.pageEvents,
          expired_exports: targets.expiredPrivacyExports,
          webhook_history: targets.webhookDeliveries,
          evidence_refs: targets.verificationEvidence,
          failed_targets: failures.length,
        },
      });
    }
    return {
      dryRun: false,
      generatedAt: new Date(),
      policy,
      cutoffs,
      targets,
      remainingAfterBatch:
        chats.length >= policy.batchSize ||
        targets.pageEvents >= pageBatch ||
        targets.webhookDeliveries >= pageBatch,
      legalHolds: this.legal(),
      failures,
    };
  }

  /** Maintenance entry point: at most once per interval across the cluster. */
  async scheduled(): Promise<void> {
    const interval = privacyConfig().retentionIntervalMinutes * 60;
    const fresh = await this.redis.client.set(
      'rd:retention:last-run',
      String(Date.now()),
      'EX',
      interval,
      'NX',
    );
    if (!fresh) return;
    for (const tenantId of await this.db.activeTenantIds()) {
      try {
        const r = await this.runTenant(tenantId);
        if (r.failures.length)
          this.logger.warn(`Retention for ${tenantId}: ${r.failures.length} targets could not be removed`);
      } catch (err) {
        this.logger.error(`Retention failed for tenant ${tenantId}: ${(err as Error).message}`);
      }
    }
  }
}
