import { lockForUpdate } from '../../db/row-lock';
import { Injectable } from '@nestjs/common';
import { Prisma, type WebhookDelivery, type WebhookEndpoint } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../../common/audit.service';
import { decrypt, encrypt, sha256 } from '../../common/crypto';
import { type AuthContext, AppError, badRequest, conflict } from '../../common/http';
import { decodeCursor, encodeCursor, page } from '../../common/wire';
import { TenantDb } from '../../db/tenant-db';
import { integrationsConfig } from './config';
import { newWebhookSecret } from './signing';
import { resolveWebhookTarget, SsrfError } from './ssrf';
import { WebhookDispatcher } from './webhook-dispatcher';
import { WEBHOOK_TEST_TYPE, webhookBody, type WebhookEventType } from './webhook-events';

export interface WebhookResource {
  id: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  enabled: boolean;
  secretHint: string;
  signingGeneration: number;
  previousSecretExpiresAt: Date | null;
  lastSuccessAt: Date | null;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface DeliveryResource {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  responseStatus: number | null;
  responseExcerpt: string | null;
  lastError: string | null;
  durationMs: number | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

function hint(ciphertext: string): string {
  try {
    const s = decrypt(ciphertext);
    return `whsec_…${s.slice(-4)}`;
  } catch {
    return 'whsec_…';
  }
}

export function webhookResource(e: WebhookEndpoint): WebhookResource {
  const overlap =
    e.previousKeyCiphertext && e.previousKeyExpiresAt && e.previousKeyExpiresAt > new Date()
      ? e.previousKeyExpiresAt
      : null;
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    eventTypes: e.eventTypes,
    enabled: e.enabled,
    secretHint: hint(e.signingKeyCiphertext),
    signingGeneration: e.keyVersion,
    previousSecretExpiresAt: overlap,
    lastSuccessAt: e.lastSuccessAt,
    failureCount: e.failureCount,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    version: e.version,
  };
}

export function deliveryResource(d: WebhookDelivery): DeliveryResource {
  const pending = d.status === 'pending' || d.status === 'retrying' || d.status === 'sending';
  return {
    id: d.id,
    endpointId: d.endpointId,
    eventId: d.eventId,
    eventType: d.eventType,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: pending ? d.nextAttemptAt : null,
    responseStatus: d.responseStatus,
    responseExcerpt: d.responseExcerpt,
    lastError: d.lastError,
    durationMs: d.durationMs,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
  };
}

/** Parse `If-Match: "3"` / `W/"3"` / `3`. */
export function parseIfMatch(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(value.trim());
  if (!m)
    throw badRequest('If-Match must be the resource version', { if_match: ['Use the ETag returned by GET'] });
  return Number(m[1]);
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

/** Webhook endpoint administration (ch. 45/55/77). */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly dispatcher: WebhookDispatcher,
  ) {}

  /** SSRF validation at save time (resolves DNS; rejects private/metadata targets). */
  async validateUrl(url: string): Promise<string> {
    try {
      const target = await resolveWebhookTarget(url, integrationsConfig());
      return target.url.toString();
    } catch (err) {
      if (err instanceof SsrfError)
        throw new AppError(422, 'VALIDATION_FAILED', err.message, {
          fieldErrors: { url: [err.message] },
          details: { reason: err.code },
        });
      throw err;
    }
  }

  async list(auth: AuthContext): Promise<WebhookResource[]> {
    return this.db.read(auth.tenantId, async (tx) => {
      const rows = await tx.webhookEndpoint.findMany({ where: { tenantId: auth.tenantId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100 });
      // Latest attempt per endpoint in one query (the list shows delivery health without N+1 calls).
      const last = rows.length
        ? await tx.$queryRaw<Array<{ endpoint_id: string; event_type: string; status: string; response_status: number | null; last_error: string | null; at: Date }>>`
            SELECT DISTINCT ON (endpoint_id) endpoint_id, event_type, status, response_status, last_error, coalesce(delivered_at, created_at) AS at
              FROM webhook_deliveries WHERE tenant_id = ${auth.tenantId}::uuid AND endpoint_id = ANY(${rows.map((r) => r.id)}::uuid[])
             ORDER BY endpoint_id, created_at DESC`
        : [];
      const byEndpoint = new Map(last.map((d) => [d.endpoint_id, { eventType: d.event_type, status: d.status, responseStatus: d.response_status, error: d.last_error, at: d.at }]));
      return rows.map((r) => ({ ...webhookResource(r), lastDelivery: byEndpoint.get(r.id) ?? null }));
    });
  }

  async get(auth: AuthContext, id: string): Promise<WebhookResource | null> {
    const row = await this.db.read(auth.tenantId, (tx) =>
      tx.webhookEndpoint.findFirst({ where: { tenantId: auth.tenantId, id } }),
    );
    return row ? webhookResource(row) : null;
  }

  async create(
    auth: AuthContext,
    input: { url: string; eventTypes: WebhookEventType[]; description?: string | null },
  ): Promise<{ resource: WebhookResource; secret: string }> {
    const url = await this.validateUrl(input.url);
    const eventTypes = [...new Set(input.eventTypes)].sort();
    const secret = newWebhookSecret();
    const row = await this.db.tx(auth.tenantId, async (tx) => {
      const count = await tx.webhookEndpoint.count({ where: { tenantId: auth.tenantId } });
      if (count >= integrationsConfig().maxEndpointsPerTenant)
        throw conflict('CONFLICT', 'Webhook endpoint limit reached');
      const created = await tx.webhookEndpoint.create({
        data: {
          tenantId: auth.tenantId,
          url,
          description: input.description?.trim() || null,
          signingKeyCiphertext: encrypt(secret),
          keyVersion: 1,
          eventTypes,
          enabled: true,
        },
      });
      await this.audit.inTx(tx, auth, {
        action: 'webhook.created',
        objectType: 'webhook_endpoint',
        objectId: created.id,
        safeDiff: { url_host: urlHost(url), event_types: eventTypes },
      });
      return created;
    });
    return { resource: webhookResource(row), secret };
  }

  async update(
    auth: AuthContext,
    id: string,
    expectedVersion: number,
    patch: { url?: string; eventTypes?: WebhookEventType[]; enabled?: boolean; description?: string | null },
  ): Promise<WebhookResource | null> {
    const url = patch.url !== undefined ? await this.validateUrl(patch.url) : undefined;
    const row = await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'webhook_endpoints', auth.tenantId, id);
      const current = await tx.webhookEndpoint.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!current) return null;
      if (current.version !== expectedVersion)
        throw conflict(
          'VERSION_CONFLICT',
          'This webhook was changed by someone else. Reload and try again.',
          false,
          { current_version: current.version },
        );
      const data: Prisma.WebhookEndpointUpdateInput = { version: { increment: 1 } };
      const changed: string[] = [];
      if (url !== undefined && url !== current.url) {
        data.url = url;
        changed.push('url');
      }
      if (patch.eventTypes) {
        data.eventTypes = [...new Set(patch.eventTypes)].sort();
        changed.push('event_types');
      }
      if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
        data.enabled = patch.enabled;
        if (patch.enabled) data.failureCount = 0;
        changed.push('enabled');
      }
      if (patch.description !== undefined) {
        data.description = patch.description?.trim() || null;
        changed.push('description');
      }
      const updated = await tx.webhookEndpoint.update({ where: { id }, data });
      await this.audit.inTx(tx, auth, {
        action: 'webhook.updated',
        objectType: 'webhook_endpoint',
        objectId: id,
        safeDiff: {
          fields: changed,
          url_host: url !== undefined ? { from: urlHost(current.url), to: urlHost(url) } : undefined,
          event_types: data.eventTypes,
          enabled: patch.enabled,
        },
      });
      return updated;
    });
    return row ? webhookResource(row) : null;
  }

  async remove(auth: AuthContext, id: string, expectedVersion: number | null): Promise<boolean> {
    return this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'webhook_endpoints', auth.tenantId, id);
      const current = await tx.webhookEndpoint.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!current) return false;
      if (expectedVersion !== null && current.version !== expectedVersion)
        throw conflict('VERSION_CONFLICT', 'This webhook was changed by someone else. Reload and try again.');
      await tx.webhookEndpoint.delete({ where: { id } });
      await this.audit.inTx(tx, auth, {
        action: 'webhook.deleted',
        objectType: 'webhook_endpoint',
        objectId: id,
        safeDiff: { url_host: urlHost(current.url) },
      });
      return true;
    });
  }

  /**
   * Rotate the signing secret. During the bounded overlap both secrets sign every
   * delivery (`X-Talkivio-Signature: v1=<new>,v1=<previous>`); afterwards the old
   * secret is discarded. overlapMinutes=0 retires the previous secret immediately.
   */
  async rotateSecret(
    auth: AuthContext,
    id: string,
    overlapMinutes: number,
  ): Promise<{ resource: WebhookResource; secret: string } | null> {
    const secret = newWebhookSecret();
    const row = await this.db.tx(auth.tenantId, async (tx) => {
      const current = await tx.webhookEndpoint.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!current) return null;
      const expires = overlapMinutes > 0 ? new Date(Date.now() + overlapMinutes * 60_000) : null;
      const updated = await tx.webhookEndpoint.update({
        where: { id },
        data: {
          signingKeyCiphertext: encrypt(secret),
          previousKeyCiphertext: expires ? current.signingKeyCiphertext : null,
          previousKeyExpiresAt: expires,
          keyVersion: { increment: 1 },
          version: { increment: 1 },
        },
      });
      await this.audit.inTx(tx, auth, {
        action: 'webhook.secret_rotated',
        objectType: 'webhook_endpoint',
        objectId: id,
        safeDiff: { signing_generation: updated.keyVersion, overlap_minutes: overlapMinutes },
      });
      return updated;
    });
    return row ? { resource: webhookResource(row), secret } : null;
  }

  /** Safe sample event (no real personal data) delivered through the normal pipeline. */
  async sendTest(auth: AuthContext, id: string): Promise<DeliveryResource | null> {
    const delivery = await this.db.tx(auth.tenantId, async (tx) => {
      const endpoint = await tx.webhookEndpoint.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!endpoint) return null;
      const eventId = randomUUID();
      const occurredAt = new Date().toISOString();
      const body = webhookBody({ eventId, tenantId: auth.tenantId, occurredAt }, WEBHOOK_TEST_TYPE, {
        message: 'This is a test event from Talkivio. It contains no customer data.',
        endpoint_id: endpoint.id,
        sample: { chat_id: '00000000-0000-4000-8000-000000000000', status: 'closed' },
      });
      const d = await tx.webhookDelivery.create({
        data: {
          tenantId: auth.tenantId,
          endpointId: endpoint.id,
          eventId,
          eventType: WEBHOOK_TEST_TYPE,
          payload: body as unknown as Prisma.InputJsonValue,
          status: 'pending',
        },
      });
      await this.audit.inTx(tx, auth, {
        action: 'webhook.test_sent',
        objectType: 'webhook_endpoint',
        objectId: endpoint.id,
        safeDiff: { event_ref: sha256(eventId).slice(0, 12) },
      });
      return d;
    });
    if (!delivery) return null;
    await this.dispatcher.enqueue(auth.tenantId, delivery.id, delivery.attempts, 0);
    return deliveryResource(delivery);
  }

  async deliveries(
    auth: AuthContext,
    endpointId: string,
    q: { cursor?: string; status?: string; limit?: number },
  ) {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    const filterHash = sha256(JSON.stringify({ endpointId, status: q.status ?? null })).slice(0, 16);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur)
      throw badRequest('This cursor does not match the current filters', { cursor: ['Invalid cursor'] });
    return this.db.read(auth.tenantId, async (tx) => {
      const endpoint = await tx.webhookEndpoint.findFirst({
        where: { tenantId: auth.tenantId, id: endpointId },
        select: { id: true },
      });
      if (!endpoint) return null;
      const where: Prisma.WebhookDeliveryWhereInput = {
        tenantId: auth.tenantId,
        endpointId,
        ...(q.status ? { status: q.status } : {}),
      };
      if (cur)
        where.OR = [
          { createdAt: { lt: new Date(cur.t) } },
          { createdAt: new Date(cur.t), id: { lt: cur.id } },
        ];
      const rows = await tx.webhookDelivery.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const slice = rows.slice(0, limit);
      const last = slice[slice.length - 1];
      return page(
        slice.map(deliveryResource),
        rows.length > limit && last
          ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }, filterHash)
          : null,
      );
    });
  }

  /** Manual redelivery: same event id and body, one new attempt (ch. 45). */
  async retryDelivery(auth: AuthContext, deliveryId: string): Promise<DeliveryResource | null> {
    const d = await this.db.tx(auth.tenantId, async (tx) => {
      const current = await tx.webhookDelivery.findFirst({
        where: { tenantId: auth.tenantId, id: deliveryId },
        include: { endpoint: { select: { enabled: true } } },
      });
      if (!current) return null;
      if (current.status === 'sending' || current.status === 'pending' || current.status === 'retrying') {
        throw conflict('CONFLICT', 'This delivery is already scheduled', true, { status: current.status });
      }
      if (!current.endpoint.enabled)
        throw conflict('INTEGRATION_UNAVAILABLE', 'Enable the webhook endpoint before retrying deliveries');
      const updated = await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'pending', nextAttemptAt: new Date(), lastError: null },
      });
      await this.audit.inTx(tx, auth, {
        action: 'webhook.delivery_retried',
        objectType: 'webhook_delivery',
        objectId: deliveryId,
        safeDiff: { event_type: current.eventType, previous_status: current.status },
      });
      return updated;
    });
    if (!d) return null;
    await this.dispatcher.enqueue(auth.tenantId, d.id, d.attempts, 0);
    return deliveryResource(d);
  }
}
