import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { nextScheduleBoundary } from '@talkivio/contracts';
import { TenantDb } from '../../db/tenant-db';
import { QueueService, QUEUES } from '../../core/queue.service';
import { WorkerService } from '../../worker/worker.service';
import { AvailabilityBroadcaster } from '../availability/availability.broadcaster';
import { toEffectiveSchedule } from '../availability/availability.service';

export const AVAILABILITY_BOUNDARY_TIMER = 'availability-boundary';
const TIMER_SLACK_MS = 250;
const HORIZON_DAYS = 35;

/**
 * Durable availability timers (ch. 22): the next instant at which any of the
 * tenant's schedules opens/closes, or an emergency closure starts/ends, is armed as a BullMQ
 * delayed job. When it fires the worker recomputes and broadcasts availability
 * (so widgets change state without a refresh) and arms the following boundary.
 * A one-minute maintenance pass re-arms every tenant, so lost Redis jobs and
 * schedule/department/site edits made elsewhere are picked up promptly.
 */
@Injectable()
export class ScheduleTimers implements OnModuleInit {
  private readonly logger = new Logger('ScheduleTimers');

  constructor(
    private readonly db: TenantDb,
    private readonly queues: QueueService,
    private readonly worker: WorkerService,
    private readonly broadcaster: AvailabilityBroadcaster,
  ) {}

  onModuleInit(): void {
    this.worker.onTimer(async (name, data) => {
      if (name !== AVAILABILITY_BOUNDARY_TIMER) return false;
      await this.broadcaster.refresh(data.tenantId);
      await this.armTenant(data.tenantId);
      return true;
    });
    this.worker.onMaintenance('schedule-boundaries', async () => {
      for (const tenantId of await this.db.activeTenantIds()) {
        await this.armTenant(tenantId).catch((err) => this.logger.warn(`arm ${tenantId} failed: ${(err as Error).message}`));
      }
    });
  }

  /** Next availability-relevant instant for a tenant (schedule boundary or closure start/end). */
  async nextBoundary(tenantId: string, now = Date.now()): Promise<number | null> {
    const exceptionFrom = new Date(now - 3 * 86_400_000);
    // Every non-archived schedule is considered, not only the ones attached right now:
    // attachments change in other modules (tenant default, departments, sites) without
    // notifying this one, and a spurious refresh at an unused boundary is harmless.
    const { schedules, closures } = await this.db.read(tenantId, async (tx) => {
      const schedules = await tx.schedule.findMany({ where: { tenantId, archivedAt: null }, include: { exceptions: { where: { localDate: { gte: exceptionFrom } } } } });
      const closures = await tx.emergencyClosure.findMany({
        where: { tenantId, revokedAt: null, OR: [{ endsAt: { gt: new Date(now) } }, { startsAt: { gt: new Date(now) } }] },
        select: { startsAt: true, endsAt: true },
      });
      return { schedules, closures };
    });
    const candidates: number[] = [];
    for (const s of schedules) {
      const b = nextScheduleBoundary(toEffectiveSchedule(s), new Date(now), HORIZON_DAYS);
      if (b) candidates.push(b.at);
    }
    for (const c of closures) {
      if (c.startsAt.getTime() > now) candidates.push(c.startsAt.getTime());
      if (c.endsAt && c.endsAt.getTime() > now) candidates.push(c.endsAt.getTime());
    }
    return candidates.length ? Math.min(...candidates) : null;
  }

  /** Arm (idempotently, by job id) the tenant's next availability boundary. */
  async armTenant(tenantId: string): Promise<number | null> {
    const now = Date.now();
    const at = await this.nextBoundary(tenantId, now);
    if (at === null) return null;
    await this.queues.add(
      QUEUES.timers,
      AVAILABILITY_BOUNDARY_TIMER,
      { tenantId, at },
      { jobId: `avb-${tenantId}-${at}`, delay: Math.max(0, at - now) + TIMER_SLACK_MS, removeOnComplete: true, removeOnFail: 100, attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    );
    return at;
  }

  /** Fire-and-forget re-arm after a configuration change. */
  rearm(tenantId: string): void {
    void this.armTenant(tenantId).catch((err) => this.logger.warn(`re-arm ${tenantId} failed: ${(err as Error).message}`));
  }
}
