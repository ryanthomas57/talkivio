import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { RedisService } from '../common/redis.service';

/**
 * BullMQ queues. Redis holds scheduling only: every job's durable effect is keyed
 * in PostgreSQL (outbox seq, delivery rows, trigger effects, job rows), so losing
 * Redis delays work but never loses or duplicates an observable result.
 */
export const QUEUES = {
  /** Internal consumers of committed outbox events (webhooks, triggers, metrics, notifications). */
  events: 'events',
  email: 'email',
  webhooks: 'webhooks',
  /** Durable timers (trigger waits, offer expiry nudges, invitation timers). */
  timers: 'timers',
  /** Long-running jobs backed by `jobs` rows (exports, privacy, imports). */
  jobs: 'jobs',
  /** Attachment malware scanning. */
  scans: 'scans',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly redis: RedisService) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.redis.create(`queue:${name}`, { forBullMQ: true }),
        prefix: 'rd',
        defaultJobOptions: { removeOnComplete: { age: 3600, count: 2000 }, removeOnFail: { age: 7 * 24 * 3600 } },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  add<T>(name: QueueName, jobName: string, data: T, opts?: JobsOptions) {
    return this.queue(name).add(jobName, data, opts);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}
