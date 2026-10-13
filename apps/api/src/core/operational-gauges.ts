import type { TenantDb } from '../db/tenant-db';
import type { MetricsService } from './metrics.service';

/**
 * Scrape-time gauges derived from PostgreSQL through `rd_metrics_snapshot()`
 * (SECURITY DEFINER, returns ages only). Cached for 5 s so frequent scrapes from
 * several Prometheus replicas stay cheap. While the database is unreachable the series are absent.
 */
export function registerOperationalGauges(metrics: MetricsService, db: TenantDb): void {
  let last = 0;
  metrics.onCollect(async () => {
    if (Date.now() - last < 5000) return;
    last = Date.now();
    let rows: Array<{ oldest_routable_queued_seconds: number; oldest_unroutable_queued_seconds: number; oldest_unscanned_seconds: number; oldest_unpublished_seconds: number }>;
    try {
      rows = await db.root.$queryRaw`SELECT * FROM rd_metrics_snapshot()`;
    } catch (err) {
      // Database unreachable: the ages are unknown. Export no series rather than the last (stale) values;
      // readiness reports the outage (TalkivioApiReadinessLost) and the next scrape retries.
      for (const g of [metrics.queueOldest, metrics.scanBacklog, metrics.outboxLag]) g.reset();
      last = 0;
      throw err;
    }
    const r = rows[0];
    if (!r) return;
    // "routable": an online serving agent exists for the chat's department (open availability interval).
    metrics.queueOldest.set(metrics.labels({ routable: 'true' }), Number(r.oldest_routable_queued_seconds));
    metrics.queueOldest.set(metrics.labels({ routable: 'false' }), Number(r.oldest_unroutable_queued_seconds));
    metrics.scanBacklog.set(metrics.labels(), Number(r.oldest_unscanned_seconds));
    metrics.outboxLag.set(metrics.labels(), Number(r.oldest_unpublished_seconds));
  });
}
