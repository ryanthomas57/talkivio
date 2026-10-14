import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, body, RecentAuth, Require, type AuthContext, BillingExempt } from '../../common/http';
import { IdempotencyService, validateIdempotencyKey } from '../../common/idempotency';
import { TenantDeletionService } from './tenant-deletion.service';

const requestSchema = z.object({ confirmSlug: z.string().min(1).max(100) }).strict();

/** Tenant deletion requests (ch. 41). */
/** Owners can still delete a workspace whose billing has blocked it. */
@BillingExempt()
@Controller('tenants/current/deletion-requests')
export class TenantDeletionController {
  constructor(
    private readonly deletions: TenantDeletionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** 202: staged destruction scheduled after the cancellation window, with a transcript archive. 409 while one is already scheduled. */
  @Post()
  @HttpCode(202)
  @RecentAuth()
  @Require('tenant.owner')
  async create(
    @Auth() auth: AuthContext,
    @Body(body(requestSchema)) input: z.infer<typeof requestSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idempotency.run(
      auth.tenantId,
      `member:${auth.membershipId}`,
      'tenants.deletion-requests.create',
      validateIdempotencyKey(key),
      input,
      async () => ({
        status: 202,
        body: await this.deletions.request(auth, input.confirmSlug),
      }),
    );
    res.status(r.status);
    return r.body;
  }

  /** The scheduled request (dashboard banner) or `null`. Archive details only for owners and admins. */
  @Get()
  @Require('tenant.read')
  current(@Auth() auth: AuthContext) {
    return this.deletions.current(auth);
  }

  @Delete(':id')
  @HttpCode(200)
  @RecentAuth()
  @Require('tenant.owner')
  cancel(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.deletions.cancel(auth, id);
  }
}
