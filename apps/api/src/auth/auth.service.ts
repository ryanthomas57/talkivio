import { Injectable, Logger } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { defaultSchedule, mergeOrgSettings, type OrgSettings } from '@talkivio/contracts';
import { TenantDb } from '../db/tenant-db';
import { decrypt, encrypt, hashIp, hashIpBucket, randomToken, sha256 } from '../common/crypto';
import { AppError, badRequest, conflict, unauthorized } from '../common/http';
import { AuditService } from '../common/audit.service';
import { env } from '../config/env';
import { MailService } from '../core/mail.service';
import { RateLimitService } from '../core/rate-limit.service';
import { DEVICE_COOKIE, SessionService } from './session.service';
import type { BillingCycle, PlanId } from '@talkivio/contracts';
import { openBillingAccount } from '../features/billing/open-account';

authenticator.options = { window: 1 };

/** The RFC 6238 time step a TOTP code matches within the ±1 step window, or null when it does not match. */
function totpStep(code: string, secret: string): bigint | null {
  const epoch = Date.now();
  const delta = authenticator.clone({ epoch }).checkDelta(code.replace(/\s/g, ''), secret);
  return delta === null ? null : BigInt(Math.floor(epoch / 1000 / authenticator.allOptions().step) + delta);
}
const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const RESET_TTL_MS = 30 * 60 * 1000;
const VERIFY_TTL_MS = 48 * 3600 * 1000;
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 3600 * 1000;
const MFA_KEY_VERSION = 1;

export interface MeResult {
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    emailVerified: boolean;
    mfaEnabled: boolean;
    createdAt: Date;
  };
  memberships: Array<{
    membershipId: string;
    tenantId: string;
    tenantName: string;
    tenantSlug: string;
    role: string;
    enabled: boolean;
    onboardingCompleted: boolean;
    plan: string;
  }>;
  activeTenantId: string | null;
}

/** Where a security event came from: the request id and hashed client address (never the address itself). */
export interface SecurityContext {
  requestId?: string;
  ipHash?: string | null;
}
export const securityContext = (req: Request): SecurityContext => ({
  requestId: (req as Request & { requestId?: string }).requestId,
  ipHash: hashIp(req.ip),
});

export function validatePassword(p: string): void {
  if (typeof p !== 'string' || p.length < 12)
    throw badRequest('Use at least 12 characters', { password: ['Use at least 12 characters'] });
  if (p.length > 128)
    throw badRequest('Use at most 128 characters', { password: ['Use at most 128 characters'] });
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return base.length >= 3
    ? base
    : `${base || 'team'}-${randomToken(3)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, 'x')}`;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    private readonly db: TenantDb,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  hashPassword(p: string) {
    return argonHash(p, ARGON_OPTS);
  }

  async verifyPassword(hash: string | null, p: string): Promise<boolean> {
    if (!hash) return false;
    try {
      return await argonVerify(hash, p);
    } catch {
      return false;
    }
  }

  async me(userId: string, activeTenantId: string | null): Promise<MeResult> {
    const user = await this.db.root.user.findUniqueOrThrow({ where: { id: userId } });
    const memberships = await this.db.root.$queryRaw<
      Array<{
        membership_id: string;
        tenant_id: string;
        tenant_name: string;
        tenant_slug: string;
        role: string;
        enabled: boolean;
        onboarding_completed: boolean;
        plan: string;
      }>
    >`
      SELECT * FROM rd_user_memberships(${userId}::uuid)`;
    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        emailVerified: !!user.emailVerifiedAt,
        mfaEnabled: !!user.mfaEnabledAt,
        createdAt: user.createdAt,
      },
      memberships: memberships.map((m) => ({
        membershipId: m.membership_id,
        tenantId: m.tenant_id,
        tenantName: m.tenant_name,
        tenantSlug: m.tenant_slug,
        role: m.role,
        enabled: m.enabled,
        onboardingCompleted: m.onboarding_completed,
        plan: m.plan,
      })),
      activeTenantId: memberships.some((m) => m.tenant_id === activeTenantId && m.enabled)
        ? activeTenantId
        : null,
    };
  }

  // ───────── Signup / tenant creation ─────────

  async signup(
    input: {
      email: string;
      password: string;
      tenantName: string;
      timezone?: string;
      displayName?: string;
      plan?: PlanId;
      cycle?: BillingCycle;
    },
    req: Request,
    res: Response,
  ) {
    await this.rateLimit.enforce(`signup:${hashIpBucket(req.ip)}`, 10, 3600);
    const email = input.email.trim().toLowerCase();
    validatePassword(input.password);
    if (await this.db.root.user.findUnique({ where: { email } })) {
      // Generic response guidance without revealing account details beyond what login offers.
      throw conflict('CONFLICT', 'An account already exists for this email. Sign in or reset your password.');
    }
    const user = await this.db.root.user.create({
      data: {
        email,
        displayName: (input.displayName?.trim() || email.split('@')[0]).slice(0, 120),
        passwordHash: await this.hashPassword(input.password),
      },
    });
    const tenant = await this.createTenant(
      user.id,
      input.tenantName,
      input.timezone ?? 'UTC',
      securityContext(req),
      { plan: input.plan, cycle: input.cycle },
    );
    await this.sendVerification(user.id, user.email, user.displayName);
    await this.sessions.create(user, req, res, tenant.id);
    return {
      userId: user.id,
      tenantId: tenant.id,
      verificationRequired: true,
      me: await this.me(user.id, tenant.id),
    };
  }

  /** Create a tenant with its owner membership and safe defaults (one transaction). */
  async createTenant(
    userId: string,
    name: string,
    timezone: string,
    ctx: SecurityContext = {},
    billing: { plan?: PlanId; cycle?: BillingCycle } = {},
  ) {
    const tenantName = name.trim().slice(0, 120);
    if (!tenantName) throw badRequest('Enter a workspace name', { tenant_name: ['Required'] });
    let slug = slugify(tenantName);
    for (let i = 2; await this.slugTaken(slug); i++) slug = `${slugify(tenantName).slice(0, 55)}-${i}`;
    const tenantId = crypto.randomUUID();
    const settings: OrgSettings = mergeOrgSettings({ locale: { timezone } });
    await this.db.tx(tenantId, async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          name: tenantName,
          slug,
          timezone,
          ownerUserId: userId,
          settings: settings as unknown as Prisma.InputJsonValue,
        },
      });
      const m = await tx.membership.create({ data: { tenantId, userId, role: 'owner', capacity: 3 } });
      await tx.agentCapacity.create({ data: { tenantId, membershipId: m.id } });
      const sched = defaultSchedule(timezone);
      const schedule = await tx.schedule.create({
        data: {
          tenantId,
          name: 'Business hours',
          timezone,
          weeklyIntervals: sched.days as unknown as Prisma.InputJsonValue,
        },
      });
      const dept = await tx.department.create({
        data: {
          tenantId,
          name: 'Support',
          normalizedName: 'support',
          publicLabel: 'Support',
          description: 'General questions and help',
          routingMode: 'broadcast',
          scheduleId: null,
        },
      });
      await tx.departmentMember.create({
        data: { tenantId, departmentId: dept.id, membershipId: m.id, canServe: true, canMonitor: true },
      });
      // The default schedule exists but is not attached until the owner enables operating hours.
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          settings: {
            ...(settings as object),
            availability: { defaultScheduleId: null, suggestedScheduleId: schedule.id },
          } as Prisma.InputJsonValue,
        },
      });
      for (const r of DEFAULT_REPLIES) {
        await tx.cannedReply.create({
          data: {
            tenantId,
            scopeType: 'tenant',
            scopeKey: 'tenant',
            slug: r.slug,
            title: r.title,
            body: r.body,
            options: r.options ?? [],
          },
        });
      }
      await openBillingAccount(tx, tenantId, billing.plan, billing.cycle);
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'user',
          actorId: userId,
          action: 'tenant.created',
          objectType: 'tenant',
          objectId: tenantId,
          requestId: ctx.requestId || null,
          ipHash: ctx.ipHash ?? null,
        },
      });
    });
    return { id: tenantId, slug };
  }

  private async slugTaken(slug: string): Promise<boolean> {
    const r = await this.db.root.$queryRaw<Array<{ taken: boolean }>>`SELECT rd_slug_taken(${slug}) AS taken`;
    return !!r[0]?.taken;
  }

  // ───────── Login (with MFA challenge) ─────────

  async login(
    input: {
      email: string;
      password: string;
      totpCode?: string;
      challenge?: string;
      rememberDevice?: boolean;
    },
    req: Request,
    res: Response,
  ): Promise<MeResult> {
    const email = input.email.trim().toLowerCase();
    await this.rateLimit.enforce(`login:net:${hashIpBucket(req.ip)}`, 30, 300);
    await this.rateLimit.enforce(`login:acct:${sha256(email)}`, 10, 300);
    const user = await this.db.root.user.findUnique({ where: { email } });
    const ok = await this.verifyPassword(user?.passwordHash ?? null, input.password);
    const ctx = securityContext(req);
    if (!user || !ok || user.disabledAt) {
      // Recorded off the response path: an audit write only for existing accounts must not become a timing oracle.
      if (user)
        this.recordSecurityLater(user.id, 'security.login_failed', {
          outcome: 'failure',
          reason: ok ? 'account_disabled' : 'invalid_credentials',
          anonymous: true,
          ...ctx,
        });
      throw unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
    }

    if (user.mfaEnabledAt && !(await this.isTrustedDevice(user.id, req))) {
      if (!input.totpCode)
        throw await this.mfaChallenge(user.id, 'Enter the code from your authenticator app');
      // A challenge nonce, when sent back, binds the code to this sign-in attempt: live, this user, single use.
      const challengeHash = input.challenge ? sha256(input.challenge) : null;
      const liveChallenge = {
        userId: user.id,
        purpose: 'mfa_challenge',
        consumedAt: null,
        expiresAt: { gt: new Date() },
      } as const;
      if (
        challengeHash &&
        !(await this.db.root.authToken.findFirst({
          where: { tokenHash: challengeHash, ...liveChallenge },
          select: { id: true },
        }))
      ) {
        throw await this.mfaChallenge(user.id, 'This sign-in step expired. Enter a new code.');
      }
      await this.rateLimit.enforce(`mfa:${user.id}`, 5, 300, 'Too many codes tried. Wait a few minutes.');
      if (!(await this.checkMfaCode(user.id, input.totpCode))) {
        this.recordSecurityLater(user.id, 'security.login_failed', {
          outcome: 'failure',
          reason: 'invalid_mfa_code',
          anonymous: true,
          ...ctx,
        });
        throw unauthorized('That code is not valid', 'MFA_REQUIRED');
      }
      if (challengeHash) {
        const spent = await this.db.root.authToken.updateMany({
          where: { tokenHash: challengeHash, ...liveChallenge },
          data: { consumedAt: new Date() },
        });
        if (spent.count !== 1)
          throw await this.mfaChallenge(user.id, 'This sign-in step expired. Enter a new code.');
      }
      if (input.rememberDevice) await this.trustDevice(user.id, req, res);
    }
    const memberships = await this.me(user.id, null);
    const active = memberships.memberships.find((m) => m.enabled)?.tenantId ?? null;
    await this.sessions.create(user, req, res, active);
    return this.me(user.id, active);
  }

  async reauthenticate(
    userId: string,
    sessionId: string,
    password: string,
    totpCode?: string,
    ctx: SecurityContext = {},
  ): Promise<void> {
    await this.rateLimit.enforce(`reauth:${userId}`, 10, 300);
    const user = await this.db.root.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await this.verifyPassword(user.passwordHash, password))) {
      await this.recordSecurity(userId, 'security.reauth_failed', {
        outcome: 'failure',
        reason: 'invalid_credentials',
        ...ctx,
      });
      throw unauthorized('Incorrect password', 'INVALID_CREDENTIALS');
    }
    if (user.mfaEnabledAt && !(totpCode && (await this.checkMfaCode(userId, totpCode)))) {
      await this.recordSecurity(userId, 'security.reauth_failed', {
        outcome: 'failure',
        reason: 'invalid_mfa_code',
        ...ctx,
      });
      throw unauthorized('Enter a valid authentication code', 'MFA_REQUIRED');
    }
    await this.sessions.markRecentAuth(sessionId);
  }

  // ───────── Verification & reset ─────────

  async sendVerification(userId: string, email: string, name: string): Promise<void> {
    const token = randomToken(32);
    await this.db.root.authToken.create({
      data: {
        userId,
        purpose: 'verify',
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
      },
    });
    await this.mail.sendTemplate(
      'verify_email',
      email,
      { name, url: `${env().APP_URL}/verify-email?token=${encodeURIComponent(token)}` },
      `verify:${sha256(token)}`,
    );
  }

  async resendVerification(userId: string, ip: string | null | undefined): Promise<void> {
    await this.rateLimit.enforce(`verify-resend:${userId}:${hashIpBucket(ip)}`, 5, 3600);
    const user = await this.db.root.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.emailVerifiedAt) await this.sendVerification(user.id, user.email, user.displayName);
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.consume(token, 'verify');
    await this.db.root.user.update({ where: { id: record.userId! }, data: { emailVerifiedAt: new Date() } });
  }

  async requestReset(email: string, ip: string | null, ctx: SecurityContext = {}): Promise<void> {
    const norm = email.trim().toLowerCase();
    await this.rateLimit.enforce(`reset:net:${hashIpBucket(ip)}`, 10, 3600);
    if (!(await this.rateLimit.hit(`reset:acct:${sha256(norm)}`, 3, 3600))) return; // generic success regardless
    const user = await this.db.root.user.findUnique({ where: { email: norm } });
    if (!user || user.disabledAt) return;
    const token = randomToken(32);
    await this.db.root.authToken.create({
      data: {
        userId: user.id,
        purpose: 'reset',
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
    await this.mail.sendTemplate(
      'password_reset',
      user.email,
      { name: user.displayName, url: `${env().APP_URL}/reset-password?token=${encodeURIComponent(token)}` },
      `reset:${sha256(token)}`,
    );
    this.recordSecurityLater(user.id, 'security.password_reset_requested', { anonymous: true, ...ctx });
  }

  async resetPassword(token: string, password: string, ctx: SecurityContext = {}): Promise<void> {
    validatePassword(password);
    const record = await this.consume(token, 'reset');
    await this.db.root.user.update({
      where: { id: record.userId! },
      data: { passwordHash: await this.hashPassword(password), emailVerifiedAt: new Date() },
    });
    await this.sessions.revokeAllForUser(record.userId!);
    // A reset can follow a compromise: remembered devices must face the second factor again.
    await this.db.root.trustedDevice.deleteMany({ where: { userId: record.userId! } });
    await this.recordSecurity(record.userId!, 'security.password_reset', ctx);
  }

  async changePassword(
    userId: string,
    sessionId: string,
    current: string,
    next: string,
    ctx: SecurityContext = {},
  ): Promise<void> {
    validatePassword(next);
    const user = await this.db.root.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.passwordHash && !(await this.verifyPassword(user.passwordHash, current)))
      throw badRequest('Your current password is incorrect', { current_password: ['Incorrect password'] });
    await this.db.root.user.update({
      where: { id: userId },
      data: { passwordHash: await this.hashPassword(next) },
    });
    const revoked = await this.sessions.revokeAllForUser(userId, sessionId);
    await this.recordSecurity(userId, 'security.password_changed', {
      safeDiff: { other_sessions_revoked: revoked },
      ...ctx,
    });
  }

  /** Single-use token consumption under a row lock (ch. 07). */
  private async consume(token: string, purpose: 'verify' | 'reset') {
    return this.db.root.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM auth_tokens WHERE token_hash = ${sha256(token)} FOR UPDATE`;
      if (!rows.length) throw badRequest('This link is invalid or has expired', { token: ['Invalid link'] });
      const r = await tx.authToken.findUniqueOrThrow({ where: { id: rows[0].id } });
      if (r.purpose !== purpose || r.expiresAt < new Date())
        throw new AppError(422, 'TOKEN_EXPIRED', 'This link is invalid or has expired');
      if (r.consumedAt) throw new AppError(422, 'TOKEN_USED', 'This link has already been used');
      await tx.authToken.update({ where: { id: r.id }, data: { consumedAt: new Date() } });
      return r;
    });
  }

  // ───────── MFA (TOTP) ─────────

  async mfaEnroll(userId: string) {
    const user = await this.db.root.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabledAt) throw conflict('CONFLICT', 'Two-factor authentication is already enabled');
    const secret = authenticator.generateSecret(20);
    const enrollment = randomToken(16);
    await this.db.root.authToken.create({
      data: {
        userId,
        purpose: 'mfa_challenge',
        tokenHash: sha256(`enroll:${enrollment}`),
        payload: { secret: encrypt(secret), keyVersion: MFA_KEY_VERSION },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    const otpauthUrl = authenticator.keyuri(user.email, env().BRAND_NAME, secret);
    return {
      enrollmentId: enrollment,
      secret,
      otpauthUrl,
      qrDataUrl: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }),
    };
  }

  async mfaConfirm(userId: string, enrollmentId: string, code: string, ctx: SecurityContext = {}) {
    const rec = await this.db.root.authToken.findUnique({
      where: { tokenHash: sha256(`enroll:${enrollmentId}`) },
    });
    if (!rec || rec.userId !== userId || rec.consumedAt || rec.expiresAt < new Date())
      throw new AppError(422, 'TOKEN_EXPIRED', 'Enrollment expired. Start again.');
    const secret = decrypt((rec.payload as { secret: string }).secret);
    const step = totpStep(code, secret);
    if (step === null) throw badRequest('That code is not valid', { code: ['Invalid code'] });
    const recoveryCodes = Array.from({ length: 10 }, () =>
      randomToken(8).replace(/[-_]/g, 'x').slice(0, 10).toLowerCase(),
    );
    await this.db.root.$transaction(async (tx) => {
      // One enrollment confirms once, even when two confirmations race.
      const claimed = await tx.authToken.updateMany({
        where: { id: rec.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) throw new AppError(422, 'TOKEN_EXPIRED', 'Enrollment expired. Start again.');
      await tx.user.update({
        where: { id: userId },
        // The confirmation code is spent: it cannot also complete a sign-in.
        data: {
          mfaSecretCiphertext: encrypt(secret),
          mfaKeyVersion: MFA_KEY_VERSION,
          mfaEnabledAt: new Date(),
          mfaRecoveryHashes: recoveryCodes.map((c) => sha256(c)),
          mfaLastTotpStep: step,
        },
      });
    });
    await this.recordSecurity(userId, 'security.mfa_enabled', ctx);
    return { recoveryCodes };
  }

  async mfaDisable(userId: string, code: string, ctx: SecurityContext = {}): Promise<void> {
    if (!(await this.checkMfaCode(userId, code)))
      throw badRequest('That code is not valid', { code: ['Invalid code'] });
    await this.db.root.user.update({
      where: { id: userId },
      data: {
        mfaEnabledAt: null,
        mfaSecretCiphertext: null,
        mfaKeyVersion: null,
        mfaRecoveryHashes: [],
        mfaLastTotpStep: null,
      },
    });
    await this.db.root.trustedDevice.deleteMany({ where: { userId } });
    await this.recordSecurity(userId, 'security.mfa_disabled', ctx);
  }

  /**
   * User-level security events (ch. 07, ch. 54) are recorded in every workspace the user can act in, without
   * passwords, codes or tokens. `anonymous`: the request was not signed in (a failed sign-in or a reset request), so
   * the user is the object of the event, not its actor.
   */
  async recordSecurity(
    userId: string,
    action: string,
    opts: SecurityContext & {
      outcome?: 'success' | 'failure';
      reason?: string;
      anonymous?: boolean;
      safeDiff?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const tenants = await this.db.root.$queryRaw<Array<{ tenant_id: string; enabled: boolean }>>`
      SELECT tenant_id, enabled FROM rd_user_memberships(${userId}::uuid)`;
    const safeDiff =
      opts.reason || opts.safeDiff
        ? { ...(opts.reason ? { reason: opts.reason } : {}), ...opts.safeDiff }
        : undefined;
    for (const t of tenants.filter((x) => x.enabled)) {
      await this.db.tx(t.tenant_id, (tx) =>
        tx.auditEvent.create({
          data: {
            tenantId: t.tenant_id,
            actorType: opts.anonymous ? 'anonymous' : 'user',
            actorId: opts.anonymous ? null : userId,
            action,
            objectType: 'user',
            objectId: userId,
            outcome: opts.outcome ?? 'success',
            safeDiff: safeDiff as Prisma.InputJsonValue | undefined,
            requestId: opts.requestId || null,
            ipHash: opts.ipHash ?? null,
          },
        }),
      );
    }
  }

  /** recordSecurity off the response path; a failure is logged, never surfaced to the caller. */
  private recordSecurityLater(
    userId: string,
    action: string,
    opts: Parameters<AuthService['recordSecurity']>[2],
  ): void {
    this.recordSecurity(userId, action, opts).catch((err: unknown) =>
      this.logger.error(`Security audit failed (${action}): ${(err as Error).message}`),
    );
  }

  async regenerateRecovery(userId: string, code: string, ctx: SecurityContext = {}) {
    if (!(await this.checkMfaCode(userId, code)))
      throw badRequest('That code is not valid', { code: ['Invalid code'] });
    const recoveryCodes = Array.from({ length: 10 }, () =>
      randomToken(8).replace(/[-_]/g, 'x').slice(0, 10).toLowerCase(),
    );
    await this.db.root.user.update({
      where: { id: userId },
      data: { mfaRecoveryHashes: recoveryCodes.map((c) => sha256(c)) },
    });
    await this.recordSecurity(userId, 'security.mfa_recovery_codes_regenerated', ctx);
    return { recoveryCodes };
  }

  /**
   * Verifies and consumes a TOTP or recovery code. Both are single use, enforced by one conditional UPDATE
   * so concurrent requests cannot spend the same code twice: a TOTP time step is accepted only if it is
   * newer than the last accepted step (RFC 6238 §5.2), a recovery code only while it is still in the list.
   */
  async checkMfaCode(userId: string, code: string): Promise<boolean> {
    const user = await this.db.root.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaSecretCiphertext) return false;
    const clean = code.replace(/\s/g, '');
    if (/^\d{6}$/.test(clean)) {
      const step = totpStep(clean, decrypt(user.mfaSecretCiphertext));
      if (step === null) return false;
      const n = await this.db.root.$executeRaw`
        UPDATE users SET mfa_last_totp_step = ${step}
        WHERE id = ${userId}::uuid AND (mfa_last_totp_step IS NULL OR mfa_last_totp_step < ${step})`;
      return n === 1;
    }
    const h = sha256(clean.toLowerCase());
    const n = await this.db.root.$executeRaw`
      UPDATE users SET mfa_recovery_hashes = array_remove(mfa_recovery_hashes, ${h})
      WHERE id = ${userId}::uuid AND ${h} = ANY(mfa_recovery_hashes)`;
    return n === 1;
  }

  /** 401 MFA_REQUIRED carrying a fresh short-lived challenge nonce (stored hashed); no session exists yet. */
  private async mfaChallenge(userId: string, message: string): Promise<AppError> {
    const challenge = randomToken(24);
    await this.db.root.authToken.create({
      data: {
        userId,
        purpose: 'mfa_challenge',
        tokenHash: sha256(challenge),
        expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
      },
    });
    return new AppError(401, 'MFA_REQUIRED', message, { details: { challenge } });
  }

  private async isTrustedDevice(userId: string, req: Request): Promise<boolean> {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[DEVICE_COOKIE];
    if (!token) return false;
    const d = await this.db.root.trustedDevice.findUnique({ where: { tokenHash: sha256(token) } });
    if (!d || d.userId !== userId || d.expiresAt < new Date()) return false;
    await this.db.root.trustedDevice.update({ where: { id: d.id }, data: { lastUsedAt: new Date() } });
    return true;
  }

  private async trustDevice(userId: string, req: Request, res: Response) {
    const token = randomToken(32);
    await this.db.root.trustedDevice.create({
      data: {
        userId,
        tokenHash: sha256(token),
        label: String(req.headers['user-agent'] ?? 'Unknown').slice(0, 120),
        expiresAt: new Date(Date.now() + TRUSTED_DEVICE_TTL_MS),
      },
    });
    res.cookie(DEVICE_COOKIE, token, this.sessions.cookieOptions(TRUSTED_DEVICE_TTL_MS));
  }

  // ───────── Tenant context ─────────

  async switchTenant(userId: string, sessionId: string, tenantId: string, res: Response): Promise<MeResult> {
    const me = await this.me(userId, null);
    const m = me.memberships.find((x) => x.tenantId === tenantId && x.enabled);
    if (!m) throw new AppError(404, 'NOT_FOUND', 'Workspace not found');
    await this.sessions.setActiveTenant(sessionId, tenantId);
    await this.sessions.rotate(sessionId, res);
    return this.me(userId, tenantId);
  }
}

const DEFAULT_REPLIES = [
  {
    slug: 'hi',
    title: 'Greeting',
    body: 'Hi {{visitor.name}}! Thanks for reaching out. How can I help today?',
  },
  { slug: 'moment', title: 'One moment', body: 'Give me just a moment while I look into that for you.' },
  {
    slug: 'email',
    title: 'Ask for email',
    body: 'Could you share your email address so we can follow up if we get disconnected?',
  },
  {
    slug: 'anything',
    title: 'Anything else',
    body: 'Is there anything else I can help you with?',
    options: ['Yes, another question', "No, that's all"],
  },
  {
    slug: 'bye',
    title: 'Goodbye',
    body: 'Thanks for chatting with {{site.name}}, {{visitor.name}}. Have a great day!',
  },
];
