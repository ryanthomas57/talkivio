import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { isValidTimezone, BILLING_CYCLES, PLAN_IDS } from '@talkivio/contracts';
import { TenantDb } from '../db/tenant-db';
import {
  AllowPendingMfa,
  body,
  CurrentUser,
  notFound,
  Public,
  RecentAuth,
  UserScoped,
  type UserContext,
} from '../common/http';
import { AuthService, securityContext, type SecurityContext } from './auth.service';
import { OAuthService } from './oauth.service';
import { SessionService } from './session.service';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);
const password = z.string().min(12, 'Use at least 12 characters').max(128, 'Use at most 128 characters');
const signupSchema = z
  .object({
    email,
    password,
    tenantName: z.string().trim().min(1, 'Enter a workspace name').max(120),
    timezone: z.string().refine(isValidTimezone, 'Unknown timezone').default('UTC'),
    displayName: z.string().trim().min(1).max(120).optional(),
    /** The plan and billing cycle picked on the pricing page (used when billing is on). */
    plan: z.enum(PLAN_IDS).optional(),
    cycle: z.enum(BILLING_CYCLES).optional(),
  })
  .strict();
const loginSchema = z
  .object({
    email,
    password: z.string().min(1).max(128),
    totpCode: z.string().trim().max(20).optional(),
    challenge: z.string().min(16).max(64).optional(),
    rememberDevice: z.boolean().optional(),
  })
  .strict();
const tokenSchema = z.object({ token: z.string().min(10).max(200) }).strict();
const resetSchema = z.object({ token: z.string().min(10).max(200), newPassword: password }).strict();
const changeSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: password })
  .strict();
const reauthSchema = z
  .object({ password: z.string().min(1).max(128), totpCode: z.string().max(20).optional() })
  .strict();
const profileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    avatarUrl: z.string().url().max(500).nullable().optional(),
  })
  .strict();
const mfaConfirmSchema = z
  .object({ enrollmentId: z.string().min(8).max(64), code: z.string().trim().min(6).max(20) })
  .strict();
const codeSchema = z.object({ code: z.string().trim().min(6).max(20) }).strict();
const switchSchema = z.object({ tenantId: z.string().uuid() }).strict();
const createTenantSchema = z
  .object({
    tenantName: z.string().trim().min(1).max(120),
    timezone: z.string().refine(isValidTimezone, 'Unknown timezone').default('UTC'),
    plan: z.enum(PLAN_IDS).optional(),
    cycle: z.enum(BILLING_CYCLES).optional(),
  })
  .strict();
const ctxOf = (user: UserContext): SecurityContext => ({ requestId: user.requestId, ipHash: user.ipHash });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly oauth: OAuthService,
    private readonly db: TenantDb,
  ) {}

  @Public()
  @Get('providers')
  providers() {
    return { oauth: this.oauth.enabledProviders() };
  }

  @Public()
  @Post('signup')
  signup(
    @Body(body(signupSchema)) input: z.infer<typeof signupSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.signup(input, req, res);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @Body(body(loginSchema)) input: z.infer<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.login(input, req, res);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const s = await this.sessions.resolve(req);
    if (s) await this.sessions.revoke(s.id);
    this.sessions.clear(res);
  }

  @UserScoped()
  @AllowPendingMfa()
  @Get('me')
  async me(@CurrentUser() user: UserContext) {
    const s = await this.db.root.authSession.findUniqueOrThrow({ where: { id: user.sessionId } });
    return this.auth.me(user.userId, s.activeTenantId);
  }

  @UserScoped()
  @Patch('profile')
  async profile(
    @CurrentUser() user: UserContext,
    @Body(body(profileSchema)) input: z.infer<typeof profileSchema>,
  ) {
    await this.db.root.user.update({ where: { id: user.userId }, data: input });
    const s = await this.db.root.authSession.findUniqueOrThrow({ where: { id: user.sessionId } });
    return this.auth.me(user.userId, s.activeTenantId);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  async verify(@Body(body(tokenSchema)) input: z.infer<typeof tokenSchema>) {
    await this.auth.verifyEmail(input.token);
  }

  @UserScoped()
  @Post('verify-email/resend')
  @HttpCode(202)
  async resend(@CurrentUser() user: UserContext) {
    await this.auth.resendVerification(user.userId, user.ipHash);
    return { accepted: true };
  }

  @Public()
  @Post('password/reset-request')
  @HttpCode(202)
  async resetRequest(
    @Body(body(z.object({ email }).strict())) input: { email: string },
    @Req() req: Request,
  ) {
    await this.auth.requestReset(input.email, req.ip ?? null, securityContext(req));
    return { accepted: true };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(204)
  async reset(@Body(body(resetSchema)) input: z.infer<typeof resetSchema>, @Req() req: Request) {
    await this.auth.resetPassword(input.token, input.newPassword, securityContext(req));
  }

  @UserScoped()
  @RecentAuth()
  @Post('password/change')
  @HttpCode(204)
  async change(
    @CurrentUser() user: UserContext,
    @Body(body(changeSchema)) input: z.infer<typeof changeSchema>,
  ) {
    await this.auth.changePassword(
      user.userId,
      user.sessionId,
      input.currentPassword,
      input.newPassword,
      ctxOf(user),
    );
  }

  @UserScoped()
  @Post('reauthenticate')
  @HttpCode(204)
  async reauth(
    @CurrentUser() user: UserContext,
    @Body(body(reauthSchema)) input: z.infer<typeof reauthSchema>,
  ) {
    await this.auth.reauthenticate(user.userId, user.sessionId, input.password, input.totpCode, ctxOf(user));
  }

  @UserScoped()
  @Get('sessions')
  async sessionsList(@CurrentUser() user: UserContext) {
    const rows = await this.db.root.authSession.findMany({
      where: { userId: user.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((s) => ({
      id: s.id,
      browser: s.uaSummary,
      location: s.locationLabel,
      lastActiveAt: s.lastSeenAt,
      createdAt: s.createdAt,
      current: s.id === user.sessionId,
    }));
  }

  @UserScoped()
  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: UserContext, @Param('id', ParseUUIDPipe) id: string) {
    const s = await this.db.root.authSession.findFirst({ where: { id, userId: user.userId } });
    if (!s) throw notFound('Session');
    await this.sessions.revoke(id);
    await this.auth.recordSecurity(user.userId, 'security.session_revoked', ctxOf(user));
  }

  @UserScoped()
  @Post('sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers(@CurrentUser() user: UserContext) {
    const revoked = await this.sessions.revokeAllForUser(user.userId, user.sessionId);
    await this.auth.recordSecurity(user.userId, 'security.other_sessions_revoked', {
      safeDiff: { revoked },
      ...ctxOf(user),
    });
    return { revoked };
  }

  @UserScoped()
  @AllowPendingMfa()
  @RecentAuth()
  @Post('mfa/enroll')
  enroll(@CurrentUser() user: UserContext) {
    return this.auth.mfaEnroll(user.userId);
  }

  @UserScoped()
  @AllowPendingMfa()
  @RecentAuth()
  @Post('mfa/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: UserContext,
    @Body(body(mfaConfirmSchema)) input: z.infer<typeof mfaConfirmSchema>,
  ) {
    return this.auth.mfaConfirm(user.userId, input.enrollmentId, input.code, ctxOf(user));
  }

  /** Ch. 41: `DELETE /auth/mfa {code}` — disable with a valid factor, audit, and issue a new session. */
  @UserScoped()
  @RecentAuth()
  @Delete('mfa')
  @HttpCode(204)
  async disableMfa(
    @CurrentUser() user: UserContext,
    @Body(body(codeSchema)) input: z.infer<typeof codeSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.mfaDisable(user.userId, input.code, ctxOf(user));
    await this.sessions.rotate(user.sessionId, res);
  }

  /** Deprecated alias of `DELETE /auth/mfa` (kept for existing clients). */
  @UserScoped()
  @RecentAuth()
  @Post('mfa/disable')
  @HttpCode(204)
  async disable(
    @CurrentUser() user: UserContext,
    @Body(body(codeSchema)) input: z.infer<typeof codeSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.disableMfa(user, input, res);
  }

  @UserScoped()
  @RecentAuth()
  @Post('mfa/recovery-codes')
  recovery(@CurrentUser() user: UserContext, @Body(body(codeSchema)) input: z.infer<typeof codeSchema>) {
    return this.auth.regenerateRecovery(user.userId, input.code, ctxOf(user));
  }

  @Public()
  @Get('oauth/:provider/start')
  oauthStart(
    @Param('provider') provider: string,
    @Query('redirect') redirect: string | undefined,
    @Res() res: Response,
  ) {
    if (provider !== 'google' && provider !== 'github') throw notFound('Provider');
    return this.oauth.start(provider, redirect, res);
  }

  @Public()
  @Get('oauth/:provider/callback')
  oauthCallback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (provider !== 'google' && provider !== 'github') throw notFound('Provider');
    return this.oauth.callback(provider, code, state, req, res);
  }
}

@Controller('tenants')
export class TenantSwitchController {
  constructor(private readonly auth: AuthService) {}

  @UserScoped()
  @Post('switch')
  @HttpCode(200)
  switch(
    @CurrentUser() user: UserContext,
    @Body(body(switchSchema)) input: z.infer<typeof switchSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.switchTenant(user.userId, user.sessionId, input.tenantId, res);
  }

  /** Additional workspace for an existing user. */
  @UserScoped()
  @Post()
  async create(
    @CurrentUser() user: UserContext,
    @Body(body(createTenantSchema)) input: z.infer<typeof createTenantSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const t = await this.auth.createTenant(user.userId, input.tenantName, input.timezone, ctxOf(user), {
      plan: input.plan,
      cycle: input.cycle,
    });
    return this.auth.switchTenant(user.userId, user.sessionId, t.id, res);
  }
}
