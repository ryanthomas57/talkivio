import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Job } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { badRequest, conflict, denied, notFound, type AuthContext } from '../../common/http';
import { env, tenantDeletionGraceSeconds } from '../../config/env';
import { MailService, type MailTemplate } from '../../core/mail.service';
import { RateLimitService } from '../../core/rate-limit.service';
import { lockForUpdate } from '../../db/row-lock';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { ExportsService, type ExportState } from '../exports/exports.service';
import {
  ACTIVE_DEDUPE_KEY,
  ARCHIVE_CHAT_LIMIT,
  ARCHIVE_SCOPE,
  cancelledDedupeKey,
  deletionPolicy,
  requestState,
  TENANT_DELETION_KIND,
  type DeletionPayload,
  type DeletionState,
} from './policy';
import { TenantDestroyer } from './tenant-destroyer';

export interface WorkspaceArchive {
  id: string;
  state: ExportState;
  format: 'json';
  contents: string;
  excludes: string[];
  includesInternalNotes: boolean;
  chatCount: number;
  totalChats: number;
  chatLimit: number;
  truncated: boolean;
  sizeBytes: number | null;
  sha256: string | null;
  expiresAt: Date;
  downloadPath: string;
}

export interface TenantDeletionResource {
  id: string;
  state: DeletionState;
  requestedAt: Date;
  requestedBy: string | null;
  destroyAfter: Date;
  cancelBefore: Date;
  cancelledAt: Date | null;
  policy: ReturnType<typeof deletionPolicy>;
  /** Owner/admin only (null for other members, or if the archive row is gone). */
  export: WorkspaceArchive | null;
}

const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Tenant deletion requests (ch. 41): owner + recent auth, slug confirmation, one active request
 * per tenant (jobs UNIQUE(tenant_id, kind, dedupe_key) with dedupe key `active`), a cancellation
 * window, an owner-downloadable transcript archive and notifications to owners and admins.
 * Destruction itself runs in the worker (TenantDestroyer).
 */
@Injectable()
export class TenantDeletionService {
  private readonly logger = new Logger('TenantDeletion');

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly exports: ExportsService,
    private readonly mail: MailService,
    private readonly rateLimit: RateLimitService,
    private readonly destroyer: TenantDestroyer,
  ) {}

  async request(auth: AuthContext, confirmSlug: string): Promise<TenantDeletionResource> {
    if (!auth.membershipId || !auth.permissions.has('tenant.owner')) throw denied('Only the workspace owner can delete the workspace');
    await this.rateLimit.enforce(`tenant-deletion:${auth.tenantId}`, 10, 86_400, 'Too many deletion requests for this workspace today.');
    const windowSeconds = tenantDeletionGraceSeconds();
    const created = await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'tenants', auth.tenantId, auth.tenantId);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { slug: true, name: true, status: true, timezone: true } });
      if (confirmSlug !== tenant.slug) throw badRequest('The confirmation does not match this workspace.', { confirm_slug: ['Type the workspace slug exactly as shown to confirm.'] });
      if (tenant.status !== 'active') throw conflict('CONFLICT', 'This workspace is not active.');
      const active = await tx.job.findUnique({ where: { tenantId_kind_dedupeKey: { tenantId: auth.tenantId, kind: TENANT_DELETION_KIND, dedupeKey: ACTIVE_DEDUPE_KEY } } });
      if (active) {
        throw conflict('CONFLICT', 'A deletion request is already scheduled for this workspace. Cancel it before requesting again.', false, {
          requestId: active.id,
          destroyAfter: (active.payload as unknown as DeletionPayload).destroy_after,
        });
      }
      const destroyAfter = new Date(Date.now() + windowSeconds * 1000);
      const archive = await this.exports.createWorkspaceArchive(tx, auth, { limit: ARCHIVE_CHAT_LIMIT, retainUntil: destroyAfter, timezone: tenant.timezone });
      const payload: DeletionPayload = {
        destroy_after: destroyAfter.toISOString(),
        window_seconds: windowSeconds,
        export_id: archive.exportId,
        export_job_id: archive.jobId,
        total_chats: archive.totalChats,
        archived_chats: archive.chatCount,
        chat_limit: ARCHIVE_CHAT_LIMIT,
      };
      const job = await tx.job.create({
        data: { tenantId: auth.tenantId, kind: TENANT_DELETION_KIND, dedupeKey: ACTIVE_DEDUPE_KEY, state: 'queued', runAfter: destroyAfter, requestedBy: auth.membershipId, progress: 0, payload: payload as unknown as Prisma.InputJsonValue },
      });
      await this.audit.inTx(tx, auth, {
        action: 'tenant.deletion_requested',
        objectType: 'tenant',
        objectId: auth.tenantId,
        safeDiff: { request_id: job.id, destroy_after: payload.destroy_after, window_seconds: windowSeconds, export_id: archive.exportId, archived_chats: archive.chatCount, total_chats: archive.totalChats },
      });
      return { job, tenant, resource: await this.resource(tx, auth, job) };
    });
    // After commit. Both have durable fallbacks: the export sweep re-queues stuck export jobs and
    // the `tenant-deletion-sweep` maintenance job schedules due requests whose timer was lost.
    await this.exports.enqueue(auth.tenantId, (created.job.payload as unknown as DeletionPayload).export_job_id).catch((err) => this.logger.warn(`Archive enqueue failed (sweep will retry): ${(err as Error).message}`));
    await this.destroyer.schedule(auth.tenantId, created.job.id, 0, windowSeconds * 1000).catch((err) => this.logger.warn(`Deletion timer failed (sweep will retry): ${(err as Error).message}`));
    await this.notify(auth, created.job, created.tenant.name, 'tenant_deletion_scheduled', created.resource);
    return created.resource;
  }

  async current(auth: AuthContext): Promise<TenantDeletionResource | null> {
    return this.db.read(auth.tenantId, async (tx) => {
      const job = await tx.job.findUnique({ where: { tenantId_kind_dedupeKey: { tenantId: auth.tenantId, kind: TENANT_DELETION_KIND, dedupeKey: ACTIVE_DEDUPE_KEY } } });
      return job ? this.resource(tx, auth, job) : null;
    });
  }

  /** Cancel while the request is still scheduled. Idempotent for an already-cancelled request; 409 once destruction started. */
  async cancel(auth: AuthContext, id: string): Promise<TenantDeletionResource> {
    if (!auth.membershipId || !auth.permissions.has('tenant.owner')) throw denied('Only the workspace owner can cancel a deletion request');
    const r = await this.db.tx(auth.tenantId, async (tx) => {
      // Same row lock as the worker's claim: cancel and the start of destruction are serialised.
      await lockForUpdate(tx, 'tenants', auth.tenantId, auth.tenantId);
      const job = await tx.job.findFirst({ where: { tenantId: auth.tenantId, id, kind: TENANT_DELETION_KIND } });
      if (!job) throw notFound('Deletion request');
      if (job.state === 'cancelled') return { job, changed: false, tenantName: '', resource: await this.resource(tx, auth, job) };
      if (job.state !== 'queued') throw conflict('CONFLICT', 'Destruction has already started and can no longer be cancelled.');
      const done = await tx.job.update({ where: { id: job.id }, data: { state: 'cancelled', dedupeKey: cancelledDedupeKey(job.id), completedAt: new Date(), leaseUntil: null } });
      await this.audit.inTx(tx, auth, {
        action: 'tenant.deletion_cancelled',
        objectType: 'tenant',
        objectId: auth.tenantId,
        safeDiff: { request_id: job.id, destroy_after: (job.payload as unknown as DeletionPayload).destroy_after },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { name: true } });
      return { job: done, changed: true, tenantName: tenant.name, resource: await this.resource(tx, auth, done) };
    });
    if (r.changed) {
      await this.destroyer.unschedule(r.job.id).catch(() => undefined);
      await this.notify(auth, r.job, r.tenantName, 'tenant_deletion_cancelled', r.resource);
    }
    return r.resource;
  }

  private async resource(tx: Tx, auth: AuthContext, job: Job): Promise<TenantDeletionResource> {
    const p = job.payload as unknown as DeletionPayload;
    const destroyAfter = new Date(p.destroy_after);
    const ex = auth.permissions.has('tenant.manage') ? await this.exports.exportWithJob(tx, auth.tenantId, p.export_id) : null;
    return {
      id: job.id,
      state: requestState(job.state),
      requestedAt: job.createdAt,
      requestedBy: job.requestedBy,
      destroyAfter,
      cancelBefore: destroyAfter,
      cancelledAt: job.state === 'cancelled' ? job.completedAt : null,
      policy: deletionPolicy(p.window_seconds, job.state === 'queued'),
      export: ex
        ? {
            id: ex.id,
            state: ex.state,
            format: 'json',
            contents: ARCHIVE_SCOPE.contents,
            excludes: [...ARCHIVE_SCOPE.excludes],
            includesInternalNotes: ex.includeInternal,
            chatCount: p.archived_chats,
            totalChats: p.total_chats,
            chatLimit: p.chat_limit,
            truncated: p.total_chats > p.archived_chats,
            sizeBytes: ex.sizeBytes,
            sha256: ex.sha256,
            expiresAt: ex.expiresAt,
            downloadPath: `/api/v1/exports/${ex.id}/download`,
          }
        : null,
    };
  }

  /** Owners and admins of the workspace (enabled memberships of enabled users). Mail failures never fail the command. */
  private async notify(auth: AuthContext, job: Job, tenantName: string, template: MailTemplate, r: TenantDeletionResource): Promise<void> {
    try {
      const members = await this.db.read(auth.tenantId, (tx) =>
        tx.membership.findMany({ where: { tenantId: auth.tenantId, role: { in: ['owner', 'admin'] }, enabled: true, archivedAt: null }, select: { userId: true } }),
      );
      const users = await this.db.root.user.findMany({ where: { id: { in: members.map((m) => m.userId) }, disabledAt: null }, select: { email: true } });
      const vars = {
        tenant: tenantName,
        requester: auth.actorName,
        destroyAfter: stamp(r.destroyAfter),
        cancelBefore: stamp(r.cancelBefore),
        exportScope: r.export ? `${r.export.chatCount} of ${r.export.totalChats} chats as JSON transcripts` : 'transcripts in JSON',
        url: `${env().APP_URL.replace(/\/$/, '')}/settings/general`,
      };
      const step = template === 'tenant_deletion_scheduled' ? 'requested' : 'cancelled';
      for (const u of users) await this.mail.sendTemplate(template, u.email, vars, `tenant-deletion:${job.id}:${step}`, auth.tenantId);
    } catch (err) {
      this.logger.warn(`Deletion notification failed: ${(err as Error).message}`);
    }
  }
}
