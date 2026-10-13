import './config/role-api';
import './config/load-env';
import './instrument';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { env } from './config/env';
import { PinoNestLogger, rootLogger } from './common/logger';
import { configureHttp } from './bootstrap';
import { installGracefulShutdown } from './common/graceful-shutdown';
import { ApiModule } from './modules';

async function bootstrap() {
  const e = env();
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { logger: new PinoNestLogger(), rawBody: true, bufferLogs: true, bodyParser: false });
  const { io } = configureHttp(app, { realtime: process.env.GATEWAY_SEPARATE !== 'true' });
  await app.listen(e.PORT, e.HOST);
  installGracefulShutdown(app, { name: 'api', beforeClose: async () => io?.closeAll() });
  rootLogger().info(`Talkivio API listening on ${e.API_URL} (${e.NODE_ENV})`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
