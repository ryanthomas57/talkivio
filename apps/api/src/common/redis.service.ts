import { Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { env } from '../config/env';
import { OUTBOX_NUDGE_CHANNEL, setOutboxNudger } from '../outbox/outbox.service';

/**
 * Shared Redis connections: a general-purpose client plus factories for
 * dedicated connections (pub/sub, BullMQ) which must not be shared.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  private readonly extra: Redis[] = [];

  constructor() {
    this.client = this.create('main');
    setOutboxNudger(() => void this.client.publish(OUTBOX_NUDGE_CHANNEL, '1').catch(() => undefined));
  }

  create(name: string, opts: { forBullMQ?: boolean } = {}): Redis {
    const conn = new IORedis(env().REDIS_URL, {
      connectionName: `talkivio:${name}`,
      maxRetriesPerRequest: opts.forBullMQ ? null : 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    conn.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNREFUSED') console.error(`[redis:${name}]`, err.message);
    });
    if (name !== 'main') this.extra.push(conn);
    return conn;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.client.quit(), ...this.extra.map((c) => c.quit())]);
  }
}
