import { Injectable, Logger } from '@nestjs/common';
import { TenantDb } from '../../db/tenant-db';
import { RedisService } from '../../common/redis.service';
import { roomFor } from '../../outbox/outbox.service';
import { AGENT_NS, RealtimeService, VISITOR_NS } from '../../realtime/realtime.service';
import { AvailabilityService } from './availability.service';

/**
 * Pushes `availability.changed` to embedded widgets (public config scope) and the
 * team view whenever a site's effective availability changes. Coalesced through a
 * Redis fingerprint per site so repeated recomputation does not spam clients.
 */
@Injectable()
export class AvailabilityBroadcaster {
  private readonly logger = new Logger('AvailabilityBroadcaster');
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: TenantDb,
    private readonly availability: AvailabilityService,
    private readonly realtime: RealtimeService,
    private readonly redis: RedisService,
  ) {}

  /** Debounced refresh (250 ms) for a tenant. */
  schedule(tenantId: string): void {
    if (this.pending.has(tenantId)) return;
    this.pending.set(
      tenantId,
      setTimeout(() => {
        this.pending.delete(tenantId);
        void this.refresh(tenantId).catch((err) => this.logger.warn(`availability refresh failed: ${(err as Error).message}`));
      }, 250),
    );
  }

  async refresh(tenantId: string): Promise<void> {
    const sites = await this.db.read(tenantId, (tx) => tx.site.findMany({ where: { tenantId, enabled: true, archivedAt: null }, select: { id: true, configRevision: true } }));
    for (const s of sites) {
      const a = await this.availability.forSite(tenantId, s.id);
      const payload = {
        siteId: s.id,
        // ch. 48: site-level state (department states are listed below); config_version lets the widget refetch.
        departmentId: null,
        configVersion: s.configRevision,
        state: a.state,
        reason: a.reason,
        nextOpenAt: a.nextOpenAt,
        departments: a.departments.map((d) => ({ id: d.id, label: d.label, state: d.state, nextOpenAt: d.nextOpenAt })),
      };
      const fingerprint = JSON.stringify(payload);
      const prev = await this.redis.client.getset(`avail:${tenantId}:${s.id}`, fingerprint);
      await this.redis.client.expire(`avail:${tenantId}:${s.id}`, 3600);
      if (prev === fingerprint) continue;
      this.realtime.ephemeral(VISITOR_NS, roomFor(tenantId, 'config', s.id, 'public'), 'availability.changed', { kind: 'config', id: s.id }, payload, 60_000);
      this.realtime.ephemeral(AGENT_NS, roomFor(tenantId, 'team', 'all', 'staff'), 'availability.changed', { kind: 'config', id: s.id }, payload, 60_000);
    }
  }
}
