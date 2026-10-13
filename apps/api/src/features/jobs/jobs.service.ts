import { Injectable } from '@nestjs/common';
import type { JobState } from '@prisma/client';
import { notFound, type AuthContext } from '../../common/http';
import { TenantDb } from '../../db/tenant-db';

export interface JobStatus {
  id: string;
  kind: string;
  state: JobState;
  progress: number | null;
  attempts: number;
  runAfter: Date;
  completedAt: Date | null;
  createdAt: Date;
  lastErrorCode: string | null;
}

/**
 * Worker job status (ch. 45 `GET /jobs/{id}`): the job's requester or a workspace admin/owner.
 * `requested_by` holds a membership id for most kinds and a user id for some (visitor_merge,
 * privacy requests), so either identity of the caller matches. Never returns `payload` or
 * `result`; another tenant's job or someone else's job is a 404 so existence does not leak.
 */
@Injectable()
export class JobsService {
  constructor(private readonly db: TenantDb) {}

  async get(auth: AuthContext, id: string): Promise<JobStatus> {
    const job = await this.db.read(auth.tenantId, (tx) =>
      tx.job.findFirst({
        where: { tenantId: auth.tenantId, id },
        select: { id: true, kind: true, state: true, progress: true, attempts: true, runAfter: true, completedAt: true, createdAt: true, lastErrorCode: true, requestedBy: true },
      }),
    );
    if (!job) throw notFound('Job');
    const own = !!job.requestedBy && (job.requestedBy === auth.membershipId || job.requestedBy === auth.userId);
    if (!own && !auth.permissions.has('tenant.manage')) throw notFound('Job');
    const { requestedBy: _requester, ...status } = job;
    return status;
  }
}
