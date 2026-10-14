import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { type AppRequest, Auth, type AuthContext, body, RecentAuth } from '../../common/http';
import { IdempotencyService, validateIdempotencyKey } from '../../common/idempotency';
import { contentDisposition } from '../../core/storage.service';
import { AuditedRequire, SecurityTelemetry } from '../integrations/authz';
import { PrivacyJobRunner } from './privacy-jobs';
import { PrivacyService } from './privacy.service';
import { RetentionService } from './retention.service';
import { RequiresPlan } from '../billing/plan-gate';

const createSchema = z
  .object({
    kind: z.enum(['access', 'erase']),
    visitorId: z.string().uuid(),
    /** Opaque reference to identity evidence held outside Talkivio (ticket id, case number). Never the document itself. */
    proofReference: z.string().trim().min(1).max(200),
  })
  .strict();
const verifySchema = z
  .object({
    method: z.enum(['verified_identity', 'email_confirmation', 'account_login', 'document_check', 'other']),
    proofReference: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const listSchema = z
  .object({
    state: z.enum(['pending_verification', 'queued', 'running', 'completed', 'failed']).optional(),
    kind: z.enum(['access', 'erase']).optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/**
 * Privacy requests (ch. 45/53): `privacy.manage` only (no integration-token access).
 * Responses carry safe progress and counts, never erased text.
 */
@Controller('privacy')
export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly runner: PrivacyJobRunner,
    private readonly retention: RetentionService,
    private readonly idempotency: IdempotencyService,
    private readonly telemetry: SecurityTelemetry,
  ) {}

  @Post('requests')
  @HttpCode(202)
  @AuditedRequire('privacy_request', 'privacy.manage')
  async create(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Body(body(createSchema)) input: z.infer<typeof createSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idempotency.run(
      auth.tenantId,
      `user:${auth.userId}`,
      'privacy.requests.create',
      validateIdempotencyKey(key),
      input,
      async () => {
        const created = await this.privacy.create(auth, input);
        if (!created) return this.telemetry.notFound(auth, req, 'visitor', input.visitorId, 'Visitor');
        return { status: 202, body: created };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Get('requests')
  @AuditedRequire('privacy_request', 'privacy.manage')
  list(@Auth() auth: AuthContext, @Query(body(listSchema)) q: z.infer<typeof listSchema>) {
    return this.privacy.list(auth, q);
  }

  @Get('requests/:id')
  @AuditedRequire('privacy_request', 'privacy.manage')
  async get(@Auth() auth: AuthContext, @Req() req: AppRequest, @Param('id', ParseUUIDPipe) id: string) {
    return (
      (await this.privacy.get(auth, id)) ??
      this.telemetry.notFound(auth, req, 'privacy_request', id, 'Privacy request')
    );
  }

  @Post('requests/:id/verify')
  @HttpCode(202)
  @RecentAuth()
  @AuditedRequire('privacy_request', 'privacy.manage')
  async verify(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(body(verifySchema)) input: z.infer<typeof verifySchema>,
  ) {
    const r = await this.privacy.verify(auth, id, input);
    if (!r) return this.telemetry.notFound(auth, req, 'privacy_request', id, 'Privacy request');
    await this.runner.enqueue(auth.tenantId, r.jobId, r.attempts);
    return r.resource;
  }

  @Post('requests/:id/resume')
  @HttpCode(202)
  @RecentAuth()
  @AuditedRequire('privacy_request', 'privacy.manage')
  async resume(@Auth() auth: AuthContext, @Req() req: AppRequest, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.privacy.resume(auth, id);
    if (!r) return this.telemetry.notFound(auth, req, 'privacy_request', id, 'Privacy request');
    await this.runner.enqueue(auth.tenantId, r.jobId, r.attempts);
    return r.resource;
  }

  @Get('requests/:id/export')
  @AuditedRequire('privacy_request', 'privacy.manage')
  async download(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const file = await this.privacy.openExport(auth, id);
    if (!file) return this.telemetry.notFound(auth, req, 'privacy_request', id, 'Privacy request');
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader('Content-Disposition', contentDisposition(file.filename));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    file.stream.pipe(res);
  }

  /** Dry run: what the next retention batch would remove. */
  @RequiresPlan('auditLog')
  @Get('retention/preview')
  @AuditedRequire('retention', 'privacy.manage')
  preview(@Auth() auth: AuthContext) {
    return this.retention.preview(auth.tenantId);
  }

  /** Apply one bounded retention batch now (the worker also runs it periodically). */
  @RequiresPlan('auditLog')
  @Post('retention/run')
  @HttpCode(200)
  @RecentAuth()
  @AuditedRequire('retention', 'privacy.manage')
  run(@Auth() auth: AuthContext) {
    return this.retention.runTenant(auth.tenantId);
  }
}
