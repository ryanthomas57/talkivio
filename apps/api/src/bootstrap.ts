import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { nulGuardMiddleware, requestIdMiddleware } from './common/http';
import { drainMiddleware } from './common/graceful-shutdown';
import { rootLogger } from './common/logger';
import { RedisIoAdapter } from './realtime/redis-io.adapter';
import { MetricsService, routeGroup } from './core/metrics.service';
import { widgetDistDir } from './features/widget/widget.controller';

function trustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

/** Shared HTTP setup for the api and gateway processes. Returns the Socket.IO adapter (if any) for graceful shutdown. */
export function configureHttp(
  app: NestExpressApplication,
  opts: { realtime: boolean },
): { io: RedisIoAdapter | null } {
  const e = env();
  app.set('trust proxy', trustProxy(e.TRUST_PROXY));
  app.disable('x-powered-by');
  // Keep idle connections open longer than load balancers and HTTP clients do (AWS ALB/ELB 60 s): Node's 5 s
  // default closes sockets those peers are about to reuse, which surfaces as sporadic 502s / "other side closed".
  const server = app.getHttpServer() as import('node:http').Server;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  app.use(requestIdMiddleware);
  app.use(drainMiddleware);
  const metrics = app.get(MetricsService);
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const group = routeGroup(req.originalUrl ?? req.url);
      if (group === 'metrics' || group === 'health' || group === 'widget_assets') return;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      metrics.httpDuration.observe(
        metrics.labels({
          route_group: group,
          method: req.method,
          status_class: `${Math.floor(res.statusCode / 100)}xx`,
        }),
        seconds,
      );
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        metrics.command(`${group}.${req.method.toLowerCase()}`, metrics.outcomeFor(res.statusCode));
      }
    });
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: false, // set per-route on the widget frame; API responses are JSON
      frameguard: false, // the widget frame uses CSP frame-ancestors from approved origins
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));
  app.use(nulGuardMiddleware);
  app.use(
    pinoHttp({
      logger: rootLogger(),
      genReqId: (req) => (req as express.Request & { requestId?: string }).requestId ?? '',
      autoLogging: {
        ignore: (req) =>
          (req.url ?? '').startsWith('/health') ||
          (req.url ?? '').startsWith('/widget/frame/') ||
          (req.url ?? '').endsWith('.js'),
      },
      serializers: {
        req: (r) => ({ id: r.id, method: r.method, url: (r.url as string)?.split('?')[0] }),
        res: (r) => ({ statusCode: r.statusCode }),
      },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );
  const appOrigins = [
    ...new Set(
      [...e.CORS_ORIGINS.split(','), e.APP_URL].map((o) => o.trim().replace(/\/$/, '')).filter(Boolean),
    ),
  ];
  app.enableCors((req: express.Request, cb: (err: Error | null, options: CorsOptions) => void) => {
    const origin = req.header('origin');
    if (origin && appOrigins.includes(origin))
      return cb(null, { origin, credentials: true, exposedHeaders: ['X-Request-Id', 'Retry-After'] });
    // Public widget endpoints are called from the widget frame origin without credentials.
    if (req.path.startsWith('/widget/'))
      return cb(null, { origin: true, credentials: false, exposedHeaders: ['X-Request-Id', 'Retry-After'] });
    cb(null, { origin: false });
  });
  app.use(
    '/widget',
    express.static(widgetDistDir(), {
      index: false,
      fallthrough: true,
      setHeaders: (res, path) => {
        res.setHeader(
          'Cache-Control',
          path.endsWith('loader.js')
            ? 'public, max-age=300, stale-while-revalidate=86400'
            : 'public, max-age=31536000, immutable',
        );
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
  );
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'widget/{*path}', method: RequestMethod.ALL },
      { path: 'health/{*path}', method: RequestMethod.ALL },
    ],
  });
  let io: RedisIoAdapter | null = null;
  if (opts.realtime) {
    io = new RedisIoAdapter(app as unknown as INestApplication);
    io.connect();
    app.useWebSocketAdapter(io);
  }
  // Signals are handled by installGracefulShutdown (not enableShutdownHooks).
  return { io };
}
