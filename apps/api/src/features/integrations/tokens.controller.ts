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
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { type AppRequest, Auth, type AuthContext, body, RecentAuth } from '../../common/http';
import { IdempotencyService, validateIdempotencyKey } from '../../common/idempotency';
import { TOKEN_SCOPES } from '../../common/permissions';
import { AuditedRequire, routeOf, SecurityTelemetry } from './authz';
import { IntegrationTokensService, type TokenResource } from './tokens.service';
import { RequiresPlan } from '../billing/plan-gate';

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.string().max(40)).min(1).max(TOKEN_SCOPES.length),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const listSchema = z.object({ includeRevoked: z.enum(['true', 'false']).optional() }).strict();

/**
 * Integration tokens (ch. 45/55). Session-only (tokens cannot mint tokens); creation
 * and rotation require recent authentication. The plaintext token appears exactly
 * once in the 201/200 response; idempotent replays return metadata with `token: null`
 * because secrets are never persisted (only sha256 hashes).
 */
@RequiresPlan('integrations')
@Controller('integration-tokens')
export class IntegrationTokensController {
  constructor(
    private readonly tokens: IntegrationTokensService,
    private readonly idempotency: IdempotencyService,
    private readonly telemetry: SecurityTelemetry,
  ) {}

  @Get('scopes')
  @AuditedRequire('integration_token', 'integrations.manage')
  scopes(@Auth() auth: AuthContext) {
    return this.tokens.scopes(auth);
  }

  @Get()
  @AuditedRequire('integration_token', 'integrations.manage')
  list(@Auth() auth: AuthContext, @Query(body(listSchema)) q: z.infer<typeof listSchema>) {
    return this.tokens.list(auth, q.includeRevoked === 'true');
  }

  @Post()
  @RecentAuth()
  @AuditedRequire('integration_token', 'integrations.manage')
  async create(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Body(body(createSchema)) input: z.infer<typeof createSchema>,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const violations = this.tokens.scopeViolations(auth, input.scopes);
    if (violations.length)
      await this.telemetry.denied(auth, {
        reason: 'scope_exceeds_creator',
        permission: violations.join(','),
        route: routeOf(req),
        objectType: 'integration_token',
      });
    let secret: string | null = null;
    const r = await this.idempotency.run(
      auth.tenantId,
      `user:${auth.userId}`,
      'integration_tokens.create',
      validateIdempotencyKey(key),
      input,
      async () => {
        const created = await this.tokens.create(auth, input);
        secret = created.token;
        return { status: 201, body: { ...created.resource, token: null as string | null } };
      },
    );
    res.status(r.status);
    if (!r.replayed) res.setHeader('Location', `/api/v1/integration-tokens/${(r.body as TokenResource).id}`);
    return { ...r.body, token: secret, tokenShownOnce: true };
  }

  @Delete(':id')
  @HttpCode(204)
  @AuditedRequire('integration_token', 'integrations.manage')
  async revoke(@Auth() auth: AuthContext, @Req() req: AppRequest, @Param('id', ParseUUIDPipe) id: string) {
    if (!(await this.tokens.revoke(auth, id)))
      await this.telemetry.notFound(auth, req, 'integration_token', id, 'Integration token');
  }

  @Post(':id/rotate')
  @HttpCode(200)
  @RecentAuth()
  @AuditedRequire('integration_token', 'integrations.manage')
  async rotate(
    @Auth() auth: AuthContext,
    @Req() req: AppRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    let secret: string | null = null;
    const r = await this.idempotency.run(
      auth.tenantId,
      `user:${auth.userId}`,
      `integration_tokens.rotate:${id}`,
      validateIdempotencyKey(key),
      {},
      async () => {
        const rotated = await this.tokens.rotate(auth, id);
        if (!rotated) return this.telemetry.notFound(auth, req, 'integration_token', id, 'Integration token');
        secret = rotated.token;
        return { status: 200, body: { ...rotated.resource, token: null as string | null } };
      },
    );
    res.status(r.status);
    return { ...r.body, token: secret, tokenShownOnce: true };
  }
}
