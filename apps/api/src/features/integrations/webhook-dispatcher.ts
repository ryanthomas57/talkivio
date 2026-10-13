import { MetricsService } from '../../core/metrics.service';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Worker } from 'bullmq';
import { decrypt } from '../../common/crypto';
import { RedisService } from '../../common/redis.service';
import { QueueService, QUEUES } from '../../core/queue.service';
import { TenantDb } from '../../db/tenant-db';
import { EventConsumers } from '../../outbox/event-consumers';
import type { InternalEvent } from '../../outbox/outbox.publisher';
import { WorkerService } from '../../worker/worker.service';
import { integrationsConfig } from './config';
import { postPinned } from './http-delivery';
import { classifyResponse, nextRetryDelay, signatureHeader } from './signing';
import { resolveWebhookTarget, SsrfError } from './ssrf';
import { chatIdOf, SOURCE_EVENTS, toWebhookData, webhookBody } from './webhook-events';

interface DeliveryJob {
  tenantId: string;
  deliveryId: string;
}

/** Delivery states: pending → sending → delivered | retrying → … | failed (permanent 4xx/SSRF) | dead (retries exhausted) | cancelled. */
const SENDING_LEASE_MS = 60_000;

/**
 * Webhook fan-out and delivery (ch. 55, HOOK01).
 *
 * 1. An internal outbox consumer (at-least-once) creates one `webhook_deliveries`
 *    row per subscribed endpoint, unique on (tenant, endpoint, event id), then
 *    enqueues a BullMQ job. Redelivered events hit the unique key and do nothing new.
 * 2. The `webhooks` queue worker claims the row (conditional update), re-validates
 *    the target against SSRF rules (fresh DNS → pinned connection), signs, POSTs and
 *    records status + sanitized excerpt. Retryable outcomes schedule the next attempt
 *    as a delayed job; exhaustion moves the row to `dead` (dead letter, visible in the
 *    delivery history and retryable by an admin).
 * 3. A maintenance sweep re-enqueues overdue rows, so losing Redis delays but never
 *    loses a delivery. PostgreSQL is the source of truth.
 */
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Webhooks');
  private worker: Worker<DeliveryJob> | null = null;

  constructor(
    private readonly db: TenantDb,
    private readonly consumers: EventConsumers,
    private readonly queues: QueueService,
    private readonly redis: RedisService,
    private readonly workerService: WorkerService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    const cfg = integrationsConfig();
    if (cfg.allowPrivateRefused)
      this.logger.error(
        'TALKIVIO_WEBHOOK_ALLOW_PRIVATE is set but refused because NODE_ENV=production; private webhook targets stay blocked.',
      );
    for (const source of Object.keys(SOURCE_EVENTS))
      this.consumers.on(source, `webhooks:${source}`, (ev) => this.fanOut(ev));
    this.workerService.onMaintenance('webhook-sweep', () => this.sweep());
  }

  onApplicationBootstrap(): void {
    if (process.env.TALKIVIO_PROCESS !== 'worker') return;
    const cfg = integrationsConfig();
    if (cfg.allowPrivate)
      this.logger.warn(
        `TEST MODE: private webhook targets allowed for ${cfg.privateAllowlist.map((r) => `${r.host}${r.port ? `:${r.port}` : ''}`).join(', ')}`,
      );
    this.worker = new Worker<DeliveryJob>(QUEUES.webhooks, (job) => this.deliver(job.data), {
      connection: this.redis.create('worker:webhooks', { forBullMQ: true }),
      prefix: 'rd',
      concurrency: 10,
    });
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`Delivery job ${job?.id} errored: ${err.message}`),
    );
    this.worker.on('error', (err) => this.logger.error(`Webhook worker error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }

  /** Enqueue one attempt. Job ids are per attempt; the row's conditional claim prevents double sends. */
  async enqueue(
    tenantId: string,
    deliveryId: string,
    attempts: number,
    delayMs: number,
    suffix = '',
  ): Promise<void> {
    await this.queues.add(QUEUES.webhooks, 'deliver', { tenantId, deliveryId } satisfies DeliveryJob, {
      jobId: `wd-${deliveryId}-${attempts}${suffix}`,
      delay: Math.max(0, delayMs),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /** Outbox consumer: create delivery rows for subscribed endpoints (idempotent). */
  async fanOut(ev: InternalEvent): Promise<void> {
    const mapped = toWebhookData(ev);
    if (!mapped) return;
    const created = await this.db.tx(ev.tenantId, async (tx) => {
      const chatId = chatIdOf(ev);
      if (chatId && /^[0-9a-f-]{36}$/i.test(chatId)) {
        const chat = await tx.chat.findFirst({
          where: { tenantId: ev.tenantId, id: chatId },
          select: { isPreview: true },
        });
        if (chat?.isPreview) return [];
      }
      const endpoints = await tx.webhookEndpoint.findMany({
        where: { tenantId: ev.tenantId, enabled: true, eventTypes: { has: mapped.type } },
        select: { id: true },
      });
      if (!endpoints.length) return [];
      const body = webhookBody(ev, mapped.type, mapped.data) as unknown as Prisma.InputJsonValue;
      await tx.webhookDelivery.createMany({
        data: endpoints.map((e) => ({
          tenantId: ev.tenantId,
          endpointId: e.id,
          eventId: ev.eventId,
          eventType: mapped.type,
          payload: body,
          status: 'pending',
        })),
        skipDuplicates: true,
      });
      return tx.webhookDelivery.findMany({
        where: { tenantId: ev.tenantId, eventId: ev.eventId, status: 'pending' },
        select: { id: true, attempts: true },
      });
    });
    for (const d of created) await this.enqueue(ev.tenantId, d.id, d.attempts, 0);
  }

  /** Worker: one delivery attempt. */
  async deliver({ tenantId, deliveryId }: DeliveryJob): Promise<void> {
    const cfg = integrationsConfig();
    const claim = await this.db.tx(tenantId, async (tx) => {
      const d = await tx.webhookDelivery.findFirst({
        where: { tenantId, id: deliveryId },
        include: { endpoint: true },
      });
      if (!d) return null;
      const now = Date.now();
      const due =
        (d.status === 'pending' || d.status === 'retrying') && d.nextAttemptAt.getTime() <= now + 2000;
      const stale = d.status === 'sending' && d.nextAttemptAt.getTime() < now;
      if (!due && !stale) return null;
      if (!d.endpoint.enabled) {
        await tx.webhookDelivery.update({
          where: { id: d.id },
          data: { status: 'cancelled', lastError: 'endpoint_disabled' },
        });
        return null;
      }
      const won = await tx.webhookDelivery.updateMany({
        where: { id: d.id, status: d.status, attempts: d.attempts },
        data: {
          status: 'sending',
          attempts: { increment: 1 },
          nextAttemptAt: new Date(now + SENDING_LEASE_MS),
        },
      });
      return won.count === 1 ? { delivery: d, attempt: d.attempts + 1 } : null;
    });
    if (!claim) return;
    const { delivery, attempt } = claim;
    const endpoint = delivery.endpoint;

    // SSRF re-validation at every dispatch (DNS rebinding): fresh resolution, pinned connection.
    let target;
    try {
      target = await resolveWebhookTarget(endpoint.url, cfg);
    } catch (err) {
      const code = err instanceof SsrfError ? err.code : 'invalid_url';
      const retryable = code === 'dns_failed';
      await this.finish(tenantId, delivery.id, endpoint.id, attempt, {
        outcome: retryable ? 'retry' : 'permanent',
        status: null,
        excerpt: null,
        lastError: retryable
          ? 'dns_failed: host name could not be resolved'
          : `ssrf_blocked: ${(err as Error).message}`.slice(0, 300),
        durationMs: 0,
        retryAfterMs: null,
      });
      return;
    }

    const secrets: string[] = [decrypt(endpoint.signingKeyCiphertext)];
    if (
      endpoint.previousKeyCiphertext &&
      endpoint.previousKeyExpiresAt &&
      endpoint.previousKeyExpiresAt > new Date()
    )
      secrets.push(decrypt(endpoint.previousKeyCiphertext));
    const rawBody = JSON.stringify(delivery.payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const result = await postPinned({
      url: target.url,
      address: target.address,
      family: target.family,
      body: rawBody,
      timeoutMs: cfg.timeoutMs,
      maxBytes: cfg.maxResponseBytes,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Talkivio-Webhooks/1.0',
        'x-talkivio-event-id': delivery.eventId,
        'x-talkivio-event-type': delivery.eventType,
        'x-talkivio-timestamp': timestamp,
        'x-talkivio-signature': signatureHeader(secrets, timestamp, rawBody),
        'x-talkivio-delivery-attempt': String(attempt),
      },
    });
    const outcome = result.errorCode ? 'retry' : classifyResponse(result.status);
    const lastError = result.errorCode
      ? `${result.errorCode}: ${result.errorMessage ?? ''}`.slice(0, 300)
      : outcome === 'delivered'
        ? null
        : result.status !== null && result.status >= 300 && result.status < 400
          ? `http_${result.status}: redirects are not followed`
          : `http_${result.status}`;
    await this.finish(tenantId, delivery.id, endpoint.id, attempt, {
      outcome,
      status: result.status,
      excerpt: result.excerpt,
      lastError,
      durationMs: result.durationMs,
      retryAfterMs: result.retryAfterMs,
    });
  }

  private async finish(
    tenantId: string,
    deliveryId: string,
    endpointId: string,
    attempt: number,
    r: {
      outcome: 'delivered' | 'retry' | 'permanent';
      status: number | null;
      excerpt: string | null;
      lastError: string | null;
      durationMs: number;
      retryAfterMs: number | null;
    },
  ): Promise<void> {
    const cfg = integrationsConfig();
    const delay =
      r.outcome === 'retry'
        ? nextRetryDelay(attempt, cfg.retryScheduleMs, r.retryAfterMs, cfg.maxRetryAfterMs)
        : null;
    const status =
      r.outcome === 'delivered'
        ? 'delivered'
        : r.outcome === 'permanent'
          ? 'failed'
          : delay === null
            ? 'dead'
            : 'retrying';
    const now = new Date();
    await this.db.tx(tenantId, async (tx) => {
      await tx.webhookDelivery.updateMany({
        where: { id: deliveryId, status: 'sending', attempts: attempt },
        data: {
          status,
          responseStatus: r.status,
          responseExcerpt: r.excerpt ? r.excerpt.slice(0, 1000) : null,
          lastError: r.lastError,
          durationMs: r.durationMs,
          nextAttemptAt: delay === null ? now : new Date(now.getTime() + delay),
          ...(status === 'delivered' ? { deliveredAt: now } : {}),
        },
      });
      if (status === 'delivered')
        await tx.webhookEndpoint.updateMany({
          where: { id: endpointId },
          data: { lastSuccessAt: now, failureCount: 0 },
        });
      else
        await tx.webhookEndpoint.updateMany({
          where: { id: endpointId },
          data: { failureCount: { increment: 1 } },
        });
    });
    this.metrics.webhookDeliveries.inc(this.metrics.labels({ outcome: status, status_class: r.status ? `${Math.floor(r.status / 100)}xx` : 'none' }));
    if (status === 'retrying' && delay !== null) await this.enqueue(tenantId, deliveryId, attempt, delay);
    if (status === 'dead')
      this.logger.warn(`Webhook delivery ${deliveryId} moved to dead letter after ${attempt} attempts`);
  }

  /** Recover deliveries whose queue job was lost (Redis restart) or whose sender crashed. */
  async sweep(): Promise<void> {
    const now = Date.now();
    for (const tenantId of await this.db.activeTenantIds()) {
      const overdue = await this.db.read(tenantId, (tx) =>
        tx.webhookDelivery.findMany({
          where: {
            tenantId,
            OR: [
              { status: { in: ['pending', 'retrying'] }, nextAttemptAt: { lt: new Date(now - 15_000) } },
              { status: 'sending', nextAttemptAt: { lt: new Date(now) } },
            ],
          },
          select: { id: true, attempts: true },
          orderBy: { nextAttemptAt: 'asc' },
          take: 200,
        }),
      );
      for (const d of overdue) await this.enqueue(tenantId, d.id, d.attempts, 0).catch(() => undefined);
    }
  }
}
