import './config/role-gateway';
import './config/load-env';
import './instrument';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { env } from './config/env';
import { PinoNestLogger, rootLogger } from './common/logger';
import { configureHttp } from './bootstrap';
import { installGracefulShutdown } from './common/graceful-shutdown';
import { GatewayModule } from './modules';

/** Realtime gateway process: Socket.IO at /realtime/v1 with the Redis adapter. */
async function bootstrap() {
  const port = Number(process.env.GATEWAY_PORT ?? 4001);
  const app = await NestFactory.create<NestExpressApplication>(GatewayModule, { logger: new PinoNestLogger(), bodyParser: false });
  const { io } = configureHttp(app, { realtime: true });
  await app.listen(port, env().HOST);
  installGracefulShutdown(app, { name: 'gateway', beforeClose: async () => io?.closeAll() });
  rootLogger().info(`Talkivio gateway listening on :${port}`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
