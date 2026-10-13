import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { isPrivateAddress } from './common/ip';
import { MetricsService, metricsAllowed } from './core/metrics.service';
import { registerOperationalGauges } from './core/operational-gauges';
import { TenantDb } from './db/tenant-db';
import { RedisService } from './common/redis.service';
import { Public } from './common/http';
import { isDraining } from './common/graceful-shutdown';

/** Liveness and readiness (ch. 45). Readiness checks required dependencies. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: TenantDb,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {
    registerOperationalGauges(metrics, db);
  }

  /** Prometheus exposition (docs/operations/alerts.md). Internal network or METRICS_TOKEN only. */
  @Public()
  @Get('metrics')
  async scrape(@Req() req: Request, @Res() res: Response) {
    if (!metricsAllowed(req.socket.remoteAddress, req.header('authorization'), isPrivateAddress)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } });
      return;
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(await this.metrics.render());
  }

  @Public()
  @Get('live')
  live() {
    return { status: 'ok', uptime: Math.round(process.uptime()), process: process.env.TALKIVIO_PROCESS ?? 'api' };
  }

  @Public()
  @Get('ready')
  async ready(@Res() res: Response) {
    if (isDraining()) {
      res.status(503).json({ data: { status: 'draining', checks: {} } });
      return;
    }
    const checks: Record<string, string> = {};
    try {
      await this.db.root.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'unavailable';
    }
    try {
      checks.redis = (await this.redis.client.ping()) === 'PONG' ? 'ok' : 'unavailable';
    } catch {
      checks.redis = 'unavailable';
    }
    const ok = Object.values(checks).every((c) => c === 'ok');
    res.status(ok ? 200 : 503).json({ data: { status: ok ? 'ready' : 'not_ready', checks } });
  }
}
