import type { LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import { env } from '../config/env';

let root: Logger | null = null;

export function rootLogger(): Logger {
  if (root) return root;
  const e = env();
  const pretty = e.NODE_ENV === 'development';
  root = pino({
    level: e.LOG_LEVEL,
    base: { service: process.env.TALKIVIO_PROCESS ?? 'api' },
    redact: {
      paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-visitor-token"]', '*.password', '*.token'],
      censor: '[redacted]',
    },
    transport: pretty
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } }
      : undefined,
  });
  return root;
}

/** Adapter so Nest's internal logging flows through pino (structured JSON in production). */
export class PinoNestLogger implements LoggerService {
  private readonly log_ = rootLogger();
  log(message: unknown, context?: string) {
    this.log_.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.log_.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.log_.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.log_.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.log_.trace({ context }, String(message));
  }
}
