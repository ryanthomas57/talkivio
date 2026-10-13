import { Logger, type INestApplicationContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

/**
 * Graceful drain (ch. 45, docs/operations/deployment.md §7). On SIGTERM/SIGINT a process:
 *   1. reports `draining` on /health/ready (503) so the load balancer stops routing to it,
 *   2. waits SHUTDOWN_DRAIN_DELAY_MS for the balancer to notice,
 *   3. lets in-flight HTTP requests finish (new ones get 503 + Connection: close, retryable),
 *   4. runs `beforeClose` (close Socket.IO / stop job workers) while DB and Redis are still up,
 *   5. closes the Nest app (module destroy hooks) and exits 0 — or 1 if the shutdown timed out or failed.
 * Nest's own enableShutdownHooks() is not used: it destroys modules (DB/Redis) before the HTTP
 * server and sockets stop, which fails in-flight requests.
 */
let draining = false;
let inflight = 0;

export const isDraining = (): boolean => draining;
export const inflightRequests = (): number => inflight;

export function drainMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (draining && !req.path.startsWith('/health')) {
    res.setHeader('Connection', 'close');
    res.setHeader('Retry-After', '1');
    res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'This server is restarting. Please retry.', retryable: true } });
    return;
  }
  inflight++;
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    inflight--;
  };
  res.on('finish', end);
  res.on('close', end);
  next();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function installGracefulShutdown(app: INestApplicationContext, opts: { name: string; beforeClose?: () => Promise<void> }): void {
  const logger = new Logger('Shutdown');
  const e = env();
  const delayMs = e.SHUTDOWN_DRAIN_DELAY_MS ?? (e.NODE_ENV === 'production' ? 5000 : 0);
  const timeoutMs = e.SHUTDOWN_TIMEOUT_MS;
  let started = false;

  const run = async (signal: string) => {
    if (started) return;
    started = true;
    draining = true;
    const t0 = Date.now();
    logger.log(`${signal}: draining ${opts.name} (readiness 503, ${delayMs} ms delay, ${inflight} request(s) in flight)`);
    const hardStop = setTimeout(() => {
      logger.error(`${opts.name} did not stop within ${timeoutMs + delayMs} ms; exiting`);
      process.exit(1);
    }, timeoutMs + delayMs + 2000);
    hardStop.unref();
    await sleep(delayMs);
    while (inflight > 0 && Date.now() - t0 < delayMs + timeoutMs) await sleep(25);
    if (inflight > 0) logger.warn(`${inflight} request(s) still in flight after the drain timeout; closing anyway`);
    let code = 0;
    try {
      await opts.beforeClose?.();
      await app.close();
    } catch (err) {
      code = 1;
      logger.error(`${opts.name} shutdown failed: ${(err as Error).message}`);
    }
    logger.log(`${opts.name} stopped after ${Date.now() - t0} ms`);
    process.exit(code);
  };
  process.once('SIGTERM', () => void run('SIGTERM'));
  process.once('SIGINT', () => void run('SIGINT'));
}
