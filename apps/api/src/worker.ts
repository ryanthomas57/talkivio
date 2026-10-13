import './config/role-worker';
import './config/load-env';
import './instrument';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PinoNestLogger, rootLogger } from './common/logger';
import { WorkerModule } from './modules';
import { WorkerService } from './worker/worker.service';
import { startWorkerHealthServer } from './worker/health-server';
import { env } from './config/env';
import { installGracefulShutdown } from './common/graceful-shutdown';

/** Worker process: outbox publisher, event consumers, timers, email, maintenance. */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: new PinoNestLogger() });
  await app.get(WorkerService).start();
  installGracefulShutdown(app, { name: 'worker', beforeClose: () => app.get(WorkerService).stop() });
  const port = env().WORKER_HEALTH_PORT;
  if (port > 0) startWorkerHealthServer(app, port);
  rootLogger().info(`Talkivio worker ready${port > 0 ? ` (health on :${port})` : ''}`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
