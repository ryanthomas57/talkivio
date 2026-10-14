import { AuditService } from '../common/audit.service';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import { mergeOrgSettings, type PlanFeature } from '@talkivio/contracts';
import { TenantDb } from '../db/tenant-db';
import { hashIp, sha256 } from '../common/crypto';
import {
  ALLOW_PENDING_MFA,
  BILLING_EXEMPT,
  AppError,
  type AppRequest,
  type AuthContext,
  denied,
  IS_PUBLIC,
  RECENT_AUTH,
  REQUIRE,
  TOKEN_ALLOWED,
  unauthorized,
  USER_SCOPED,
} from '../common/http';
import { ipAllowed } from '../common/ip';
import {
  permissionsForRole,
  permissionsForScopes,
  TENANT_WIDE_ROLES,
  type Permission,
} from '../common/permissions';
import { billingOn, effectivePlan, featureRefusal, PLAN_FEATURE } from '../features/billing/plan-gate';
import { billingBlockMessage } from '../features/billing/states';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RECENT_AUTH_MS = 15 * 60 * 1000;

export interface MembershipContext {
  membershipId: string;
  role: Role;
  enabled: boolean;
  displayName: string;
  servedDepartmentIds: string[];
  monitoredDepartmentIds: string[];
  settings: ReturnType<typeof mergeOrgSettings>;
  tenantStatus: string;
  /** Subscription state, or null when the workspace has no billing account (billing off, or created before it). */
  billingState: string | null;
  billingPlan: string | null;
}

/**
 * Global authentication and authorization guard (ch. 04/07).
 * - Session cookie (dashboard) with session-bound CSRF token on mutations, or a
 *   tenant integration token (`Authorization: Bearer rdt_…`) on token-enabled routes.
 * - Active tenant comes from the server-side session, never from the request.
 * - Enforces membership, tenant security policy, permissions and recent-auth.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  /** Throttle for denial telemetry: one audit row per actor + route per minute. */
  private readonly deniedSeen = new Map<string, number>();

  constructor(
    private readonly reflector: Reflector,
    private readonly db: TenantDb,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Safe security telemetry for refused authorization (ch. 54): records the actor,
   * the route template and the missing permission — never request bodies.
   */
  private recordDenied(
    ctx: ExecutionContext,
    actor: {
      tenantId: string;
      userId: string | null;
      tokenId: string | null;
      actorName: string;
      requestId: string;
      ipHash: string | null;
    },
    reason: string,
  ): void {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const route = `${req.method} ${(req as unknown as { route?: { path?: string } }).route?.path ?? ctx.getHandler().name}`;
    const key = `${actor.tenantId}:${actor.tokenId ?? actor.userId}:${route}`;
    const now = Date.now();
    if ((this.deniedSeen.get(key) ?? 0) > now - 60_000) return;
    this.deniedSeen.set(key, now);
    if (this.deniedSeen.size > 5000) this.deniedSeen.clear();
    void this.audit
      .log(actor, {
        action: 'authorization.denied',
        objectType: 'route',
        objectId: null,
        outcome: 'denied',
        safeDiff: { route, reason },
      })
      .catch(() => undefined);
  }

  private meta<T>(key: string, ctx: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const isPublic = this.meta<boolean>(IS_PUBLIC, ctx) ?? false;
    if (isPublic && (req.path.startsWith('/widget/') || req.path.startsWith('/api/v1/widget/'))) return true;

    const authz = req.headers.authorization;
    if (authz?.startsWith('Bearer rdt_')) {
      if (isPublic) return true;
      return this.authenticateToken(req, authz.slice(7), ctx);
    }

    const session = await this.sessions.resolve(req);
    if (!session) {
      if (isPublic) return true;
      throw unauthorized();
    }
    req.user = {
      userId: session.userId,
      sessionId: session.id,
      requestId: req.requestId ?? '',
      ipHash: hashIp(req.ip),
      userAgent: req.headers['user-agent'] ?? null,
      recentAuthAt: session.recentAuthAt,
      emailVerified: !!session.user.emailVerifiedAt,
    };
    if (!SAFE_METHODS.has(req.method) && !this.sessions.checkCsrf(req, session)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'Missing or invalid CSRF token');
    }
    if (isPublic) return true;

    if (
      this.meta<boolean>(RECENT_AUTH, ctx) &&
      Date.now() - session.recentAuthAt.getTime() > RECENT_AUTH_MS
    ) {
      throw new AppError(403, 'RECENT_AUTH_REQUIRED', 'Confirm your password to continue');
    }
    if (this.meta<boolean>(USER_SCOPED, ctx)) return true;

    const tenantId = session.activeTenantId;
    if (!tenantId) throw new AppError(403, 'PERMISSION_DENIED', 'Choose a workspace first');
    const m = await this.membership(tenantId, session.userId);
    if (!m || !m.enabled)
      throw new AppError(403, 'PERMISSION_DENIED', 'You no longer have access to this workspace');
    if (m.tenantStatus !== 'active')
      throw new AppError(403, 'PERMISSION_DENIED', 'This workspace is not active');
    // Workspace session-length policy (security.sessionTimeoutHours): absolute lifetime from sign-in.
    const maxAgeHours = m.settings.security.sessionTimeoutHours;
    if (maxAgeHours && Date.now() - session.createdAt.getTime() > maxAgeHours * 3_600_000) {
      await this.sessions.revoke(session.id);
      throw unauthorized('Your session reached this workspace’s session length limit. Sign in again.');
    }
    if (!ipAllowed(req.ip, m.settings.security.ipAllowlist))
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'Access from your network is restricted by your workspace',
      );
    if (
      m.settings.security.requireMfa &&
      !session.user.mfaEnabledAt &&
      !this.meta<boolean>(ALLOW_PENDING_MFA, ctx)
    ) {
      throw new AppError(403, 'MFA_REQUIRED', 'Your workspace requires two-factor authentication');
    }

    const permissions = permissionsForRole(m.role);
    const missing = this.missingPermission(ctx, permissions);
    if (missing) {
      this.recordDenied(
        ctx,
        {
          tenantId,
          userId: session.userId,
          tokenId: null,
          actorName: m.displayName || session.user.displayName,
          requestId: req.requestId ?? '',
          ipHash: hashIp(req.ip),
        },
        `missing ${missing}`,
      );
      throw denied();
    }
    this.assertBillingOpen(ctx, m.billingState, m.billingPlan);
    req.auth = {
      tenantId,
      userId: session.userId,
      membershipId: m.membershipId,
      role: m.role,
      permissions,
      departmentScope: TENANT_WIDE_ROLES.has(m.role)
        ? 'all'
        : [...new Set([...m.servedDepartmentIds, ...m.monitoredDepartmentIds])],
      servedDepartmentIds: m.servedDepartmentIds,
      sessionId: session.id,
      tokenId: null,
      actorName: m.displayName || session.user.displayName,
      requestId: req.requestId ?? '',
      ipHash: hashIp(req.ip),
      userAgent: req.headers['user-agent'] ?? null,
    };
    return true;
  }

  /**
   * A workspace without a card (incomplete), paused for an unpaid balance (suspended) or whose subscription ended
   * answers 402 everywhere except the routes needed to put billing right.
   */
  private assertBillingOpen(ctx: ExecutionContext, state: string | null, plan: string | null): void {
    if (!billingOn()) return;
    const message = billingBlockMessage(state);
    if (message && !this.meta<boolean>(BILLING_EXEMPT, ctx))
      throw new AppError(402, 'PAYMENT_REQUIRED', message, { details: { billing_state: state } });
    // Team and Business capabilities, for routes that declare one with @RequiresPlan.
    const feature = this.meta<PlanFeature>(PLAN_FEATURE, ctx);
    const refusal = feature ? featureRefusal(effectivePlan(plan), feature) : null;
    if (refusal) throw refusal;
  }

  private missingPermission(ctx: ExecutionContext, permissions: ReadonlySet<Permission>): Permission | null {
    const required = this.meta<Permission[]>(REQUIRE, ctx) ?? [];
    return required.find((p) => !permissions.has(p)) ?? null;
  }

  async membership(tenantId: string, userId: string): Promise<MembershipContext | null> {
    return this.db.read(tenantId, async (tx) => {
      const m = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        include: {
          departments: { select: { departmentId: true, canServe: true, canMonitor: true } },
          user: { select: { displayName: true } },
        },
      });
      if (!m || m.archivedAt) return null;
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true, status: true, deletedAt: true },
      });
      if (!tenant || tenant.deletedAt) return null;
      const billing = await tx.billingAccount.findUnique({
        where: { tenantId },
        select: { state: true, plan: true },
      });
      return {
        membershipId: m.id,
        role: m.role,
        enabled: m.enabled,
        displayName: m.displayName || m.user.displayName,
        servedDepartmentIds: m.departments.filter((d) => d.canServe).map((d) => d.departmentId),
        monitoredDepartmentIds: m.departments.filter((d) => d.canMonitor).map((d) => d.departmentId),
        settings: mergeOrgSettings(tenant.settings),
        tenantStatus: tenant.status,
        billingState: billing?.state ?? null,
        billingPlan: billing?.plan ?? null,
      };
    });
  }

  private async authenticateToken(req: AppRequest, token: string, ctx: ExecutionContext): Promise<boolean> {
    const rows = await this.db.root.$queryRaw<
      Array<{
        id: string;
        tenant_id: string;
        name: string;
        scopes: string[];
        enabled: boolean;
        expires_at: Date;
        revoked_at: Date | null;
        last_used_at: Date | null;
      }>
    >`
      SELECT * FROM rd_resolve_api_token(${sha256(token)})`;
    const t = rows[0];
    if (!t || !t.enabled || t.revoked_at || t.expires_at < new Date())
      throw unauthorized('Invalid or expired integration token', 'TOKEN_EXPIRED');
    const actor = {
      tenantId: t.tenant_id,
      userId: null,
      tokenId: t.id,
      actorName: `Integration token “${t.name}”`,
      requestId: req.requestId ?? '',
      ipHash: hashIp(req.ip),
    };
    if (!this.meta<boolean>(TOKEN_ALLOWED, ctx)) {
      this.recordDenied(ctx, actor, 'endpoint not available to integration tokens');
      throw denied('This endpoint is not available to integration tokens');
    }
    const permissions = permissionsForScopes(t.scopes);
    const missing = this.missingPermission(ctx, permissions);
    if (missing) {
      this.recordDenied(ctx, actor, `missing ${missing}`);
      throw denied();
    }
    const { settings, billing } = await this.db.read(t.tenant_id, async (tx) => ({
      settings: mergeOrgSettings(
        (await tx.tenant.findUniqueOrThrow({ where: { id: t.tenant_id } })).settings,
      ),
      billing: await tx.billingAccount.findUnique({
        where: { tenantId: t.tenant_id },
        select: { state: true, plan: true },
      }),
    }));
    this.assertBillingOpen(ctx, billing?.state ?? null, billing?.plan ?? null);
    if (!ipAllowed(req.ip, settings.security.ipAllowlist))
      throw new AppError(403, 'PERMISSION_DENIED', 'IP not allowed');
    if (!t.last_used_at || Date.now() - t.last_used_at.getTime() > 60_000) {
      await this.db.tx(t.tenant_id, (tx) =>
        tx.integrationCredential.update({ where: { id: t.id }, data: { lastUsedAt: new Date() } }),
      );
    }
    req.auth = {
      tenantId: t.tenant_id,
      userId: null,
      membershipId: null,
      role: 'admin',
      permissions,
      departmentScope: 'all',
      servedDepartmentIds: [],
      sessionId: null,
      tokenId: t.id,
      actorName: `Integration token “${t.name}”`,
      requestId: req.requestId ?? '',
      ipHash: hashIp(req.ip),
      userAgent: req.headers['user-agent'] ?? null,
    };
    return true;
  }
}
