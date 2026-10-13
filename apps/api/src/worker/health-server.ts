import { createServer, type Server } from 'node:http';
import type { INestApplicationContext } from '@nestjs/common';
import { RedisService } from '../common/redis.service';
import { isPrivateAddress } from '../common/ip';
import { MetricsService, metricsAllowed } from '../core/metrics.service';
import { registerOperationalGauges } from '../core/operational-gauges';
import { TenantDb } from '../db/tenant-db';
import { isDraining } from '../common/graceful-shutdown';

/**
 * The worker has no Nest HTTP stack, so it serves its own tiny listener for
 * container probes and Prometheus: `/health/live`, `/health/ready`,
 * `/health/metrics` (internal network or METRICS_TOKEN only).
 */
export function startWorkerHealthServer(app: INestApplicationContext, port: number): Server {
  const db = app.get(TenantDb);
  const redis = app.get(RedisService);
  const metrics = app.get(MetricsService);
  registerOperationalGauges(metrics, db);

  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET') return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only', retryable: false } });
    if (path === '/health/live') return json(res, 200, { data: { status: 'ok', uptime: Math.round(process.uptime()), process: 'worker' } });
    if (path === '/health/ready') {
      if (isDraining()) return json(res, 503, { data: { status: 'draining', checks: {} } });
      void (async () => {
        const checks: Record<string, string> = {};
        try {
          await db.root.$queryRaw`SELECT 1`;
          checks.database = 'ok';
        } catch {
          checks.database = 'unavailable';
        }
        try {
          checks.redis = (await redis.client.ping()) === 'PONG' ? 'ok' : 'unavailable';
        } catch {
          checks.redis = 'unavailable';
        }
        const ok = Object.values(checks).every((c) => c === 'ok');
        json(res, ok ? 200 : 503, { data: { status: ok ? 'ready' : 'not_ready', checks } });
      })();
      return;
    }
    if (path === '/health/metrics') {
      if (!metricsAllowed(req.socket.remoteAddress, req.headers.authorization, isPrivateAddress)) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } });
      void metrics.render().then((text) => {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        res.end(text);
      });
      return;
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } });
  });
  server.listen(port, '0.0.0.0');
  return server;
}
