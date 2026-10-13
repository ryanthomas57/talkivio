/**
 * Permission checks with security telemetry (ch. 54 acceptance: "failed
 * authorization records safe security telemetry without revealing other tenant
 * objects"). Runs after the global AuthGuard has authenticated the caller (session or
 * integration token) and records an `authorization.denied` audit event in the
 * caller's own tenant: permission name and route pattern only, never object
 * contents. Writes are rate limited per actor so probing cannot flood the trail.
 */
import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../../common/audit.service';
import { type AppRequest, type AuthContext, denied, notFound, unauthorized } from '../../common/http';
import type { Permission } from '../../common/permissions';
import { RateLimitService } from '../../core/rate-limit.service';

const AUDITED_PERMISSION = 'rd:audited-permission';

@Injectable()
export class SecurityTelemetry {
  private readonly logger = new Logger('SecurityTelemetry');
  constructor(
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Record a denied attempt (best effort; never throws). */
  async denied(
    auth: AuthContext,
    detail: {
      reason: 'missing_permission' | 'not_found' | 'scope_exceeds_creator';
      permission?: string;
      route: string;
      objectType: string;
      objectId?: string | null;
    },
  ): Promise<void> {
    try {
      const actor = auth.userId ?? auth.tokenId ?? 'unknown';
      if (!(await this.rateLimit.hit(`authz-denied:${auth.tenantId}:${actor}`, 30, 60))) return;
      await this.audit.log(auth, {
        action: 'authorization.denied',
        objectType: detail.objectType,
        // Only an id the caller supplied is recorded; nothing from another tenant is read or returned.
        objectId: detail.objectId && /^[0-9a-f-]{36}$/i.test(detail.objectId) ? detail.objectId : null,
        outcome: 'denied',
        safeDiff: {
          reason: detail.reason,
          permission: detail.permission ?? null,
          route: detail.route,
          role: auth.tokenId ? 'integration_token' : auth.role,
        },
      });
    } catch (err) {
      this.logger.warn(`Could not record denied attempt: ${(err as Error).message}`);
    }
  }

  /** 404 for an id that does not exist in the caller's tenant, recorded as a denied probe. */
  async notFound(
    auth: AuthContext,
    req: AppRequest,
    objectType: string,
    objectId: string,
    what: string,
  ): Promise<never> {
    await this.denied(auth, { reason: 'not_found', route: routeOf(req), objectType, objectId });
    throw notFound(what);
  }
}

export function routeOf(req: AppRequest): string {
  const pattern =
    (req.route as { path?: string } | undefined)?.path ??
    req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id');
  return `${req.method} ${pattern}`.slice(0, 200);
}

@Injectable()
export class AuditedPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly telemetry: SecurityTelemetry,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<{ permissions: Permission[]; objectType: string }>(
      AUDITED_PERMISSION,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!meta) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const auth = req.auth;
    if (!auth) throw unauthorized();
    const missing = meta.permissions.find((p) => !auth.permissions.has(p));
    if (missing) {
      await this.telemetry.denied(auth, {
        reason: 'missing_permission',
        permission: missing,
        route: routeOf(req),
        objectType: meta.objectType,
        objectId: (req.params as Record<string, string> | undefined)?.id ?? null,
      });
      throw denied();
    }
    return true;
  }
}

/** Require permissions (server side) and record denied attempts as security telemetry. */
export const AuditedRequire = (objectType: string, ...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(AUDITED_PERMISSION, { permissions, objectType }),
    UseGuards(AuditedPermissionGuard),
  );
