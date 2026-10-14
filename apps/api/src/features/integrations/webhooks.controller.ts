import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  type AppRequest,
  AppError,
  Auth,
  type AuthContext,
  body,
  RecentAuth,
  TokenAccess,
} from '../../common/http';
import { IdempotencyService, validateIdempotencyKey } from '../../common/idempotency';
import { AuditedRequire, SecurityTelemetry } from './authz';
import { integrationsConfig } from './config';
import { WEBHOOK_EVENT_TYPES } from './webhook-events';
import { parseIfMatch, type WebhookResource, WebhooksService } from './webhooks.service';
import { RequiresPlan } from '../billing/plan-gate';

const eventTypes = z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length);
const createSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    eventTypes,
    description: z.string().trim().max(200).nullable().optional(),
  })
  .strict();
const patchSchema = z
  .object({
    url: z.string().trim().min(1).max(2048).optional(),
    eventTypes: eventTypes.optional(),
    enabled: z.boolean().optional(),
    description: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to change');
const rotateSchema = z.object({ overlapMinutes: z.number().int().min(0).max(1440).optional() }).strict();
const deliveriesSchema = z
  .object({
    cursor: z.string().max(400).optional(),
    status: z.enum(['pending', 'sending', 'retrying', 'delivered', 'failed', 'dead', 'cancelled']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const ifMatchRequired = () =>
  new AppError(428, 'PRECONDITION_REQUIRED', 'Send If-Match with the webhook version (ETag) to change it');

/**
 * Webhook endpoints (ch. 45/55/77). Admin (`integrations.manage`) or an integration
 * token with the `webhooks:manage` scope. Signing secrets are shown once (create and
 * rotate) and never returned by GET. PATCH/DELETE require If-Match (428/409).
 */
@RequiresPlan('integrations')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly idempotency: IdempotencyService,
    private readonly telemetry: SecurityTelemetry,
  ) {}

  private actorScope(auth: AuthContext): string {
    return auth.tokenId ? `token:${auth.tokenId}` : `user:${auth.userId}`;
  }

  @Get()
  @TokenAccess()
  @AuditedRequire('webhook_endpoint', 'integrations.manage')
  list(@Auth() auth: AuthContext) {
    return this.webhooks.list(auth);
  }

  @Get('event-types')
  @TokenAccess()
  @AuditedRequire('webhook_endpoint', 'integrations.manage')
  types() {
    const cfg = integrationsConfig();
    return {
      eventTypes: [...WEBHOOK_EVENT_TYPES],
      signature: {
        header: 'X-Talkivio-Signature',
        scheme: 'v1=<hex HMAC-SHA256(secret, timestamp + "." + raw_body)>',
        timestampHeader: 'X-Talkivio-Timestamp',
        toleranceSeconds: 300,
      },
      retryScheduleSeconds: cfg.retryScheduleMs.map((ms) => Math.round(ms / 1000)),
    };
  }

  @Post()
  @RecentAuth()
  @TokenAccess()
  @AuditedRequire('webhook_endpoint', 'integrations.manage')
  async create(
    @Auth() auth: AuthContext,
    @Body(body(createSchema)) input: z.infer<typeof createSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    let secret: string | null = null;
    const r = await this.idempotency.run(
      auth.tenantId,
      this.actorScope(auth),
      'webhooks.create',
      validateIdempotencyKey(key),
      input,
      async () => {
        const created = await this.webhooks.create(auth, input);
        secret = created.secret;
        return { status: 201, body: { ...created.resource, secret: null as string | null } };
      },
    );
    res.status(r.status);
    const resource = r.body as WebhookResource;
    res.setHeader('Location', `/api/v1/webhooks/${resource.id}`);
    res.setHeader('ETag', `"${resource.version}"`);
    return { ...r.body, secret, secretShownOnce: true };
  }

  @Get(':id')
  @TokenAccess()
  @AuditedRequire('webhook_endpoint', 'integrations.manage')
  async get(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const w = await this.webhooks.get(auth, id);
    if (!w) return this.telemetry.notFound(auth, req, 'webhook_endpoint', id, 'Webhook');
    res.setHeader('ETag', `"${w.version}"`);
    return w;
  }

  @Patch(':id')
  @TokenAccess()
  @AuditedRequire('webhook_endpoint', 'integrations.manage')
  async update(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(body(patchSchema)) input: z.infer<typeof patchSchema>,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const version = parseIfMatch(ifMatch);
    if (version === null) throw ifMatchRequired();
    const w = await this.webhooks.update(auth, id, version, input);
    if (!w) return this.telemetry.notFound(auth, req, 'webhook_endpoint', id, 'Webhook');
    res.setHeader('ETag', `"${w.version}"`);
    return w;
  }

  @Delete(':id')
  @HttpCode(204)
  @TokenAccess()
  @AuditedRequire('webhook_endpoint', 'integrations.manage')
  async remove(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    const version = parseIfMatch(ifMatch);
    if (version === null) throw ifMatchRequired();
    if (!(await this.webhooks.remove(auth, id, version)))
      await this.telemetry.notFound(auth, req, 'webhook_endpoint', id, 'Webhook');
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @RecentAuth()
  @TokenAccess()
  @AuditedRequire('webhook_endpoint', 'integrations.manage')
  async rotate(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(body(rotateSchema)) input: z.infer<typeof rotateSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const overlap = input.overlapMinutes ?? integrationsConfig().rotationOverlapMinutes;
    let secret: string | null = null;
    const r = await this.idempotency.run(
      auth.tenantId,
      this.actorScope(auth),
      `webhooks.rotate:${id}`,
      validateIdempotencyKey(key),
      { overlap },
      async () => {
        const rotated = await this.webhooks.rotateSecret(auth, id, overlap);
        if (!rotated) return this.telemetry.notFound(auth, req, 'webhook_endpoint', id, 'Webhook');
        secret = rotated.secret;
        return { status: 200, body: { ...rotated.resource, secret: null as string | null } };
      },
    );
    res.status(r.status);
    res.setHeader('ETag', `"${(r.body as WebhookResource).version}"`);
    return { ...r.body, secret, secretShownOnce: true };
  }

  @Post(':id/test')
  @HttpCode(202)
  @TokenAccess()
  @AuditedRequire('webhook_endpoint', 'integrations.manage')
  async test(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idempotency.run(
      auth.tenantId,
      this.actorScope(auth),
      `webhooks.test:${id}`,
      validateIdempotencyKey(key),
      {},
      async () => {
        const d = await this.webhooks.sendTest(auth, id);
        if (!d) return this.telemetry.notFound(auth, req, 'webhook_endpoint', id, 'Webhook');
        return { status: 202, body: d };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Get(':id/deliveries')
  @TokenAccess()
  @AuditedRequire('webhook_endpoint', 'integrations.manage')
  async deliveries(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(body(deliveriesSchema)) q: z.infer<typeof deliveriesSchema>,
  ) {
    const p = await this.webhooks.deliveries(auth, id, q);
    if (!p) return this.telemetry.notFound(auth, req, 'webhook_endpoint', id, 'Webhook');
    return p;
  }
}

@RequiresPlan('integrations')
@Controller('webhook-deliveries')
export class WebhookDeliveriesController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly idempotency: IdempotencyService,
    private readonly telemetry: SecurityTelemetry,
  ) {}

  @Post(':id/retry')
  @HttpCode(202)
  @TokenAccess()
  @AuditedRequire('webhook_delivery', 'integrations.manage')
  async retry(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const scope = auth.tokenId ? `token:${auth.tokenId}` : `user:${auth.userId}`;
    const r = await this.idempotency.run(
      auth.tenantId,
      scope,
      `webhook_deliveries.retry:${id}`,
      validateIdempotencyKey(key),
      {},
      async () => {
        const d = await this.webhooks.retryDelivery(auth, id);
        if (!d) return this.telemetry.notFound(auth, req, 'webhook_delivery', id, 'Webhook delivery');
        return { status: 202, body: d };
      },
    );
    res.status(r.status);
    return r.body;
  }
}
