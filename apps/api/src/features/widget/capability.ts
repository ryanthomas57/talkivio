import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import { hashIp, hmacSha256, safeEqual } from '../../common/crypto';
import { AppError, type AppRequest, type VisitorContext } from '../../common/http';
import { normalizeIp } from '../../common/ip';
import { RedisService } from '../../common/redis.service';

const TTL_SECONDS = 3600;

interface CapabilityClaims {
  t: string; // tenant
  s: string; // site
  v: string; // visitor
  vs: string; // visitor session
  o: string | null; // validated host origin
  exp: number;
}

function key(): string {
  return `visitor-cap:${env().APP_SECRET}`;
}

/** Short-lived signed visitor capability (`rdv1.<claims>.<sig>`), scoped to tenant/site/visitor/session. */
export function signCapability(c: Omit<CapabilityClaims, 'exp'>): { token: string; expiresAt: Date } {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const body = Buffer.from(JSON.stringify({ ...c, exp })).toString('base64url');
  const sig = hmacSha256(key(), body, 'base64url');
  return { token: `rdv1.${body}.${sig}`, expiresAt: new Date(exp * 1000) };
}

export function verifyCapability(token: string | null | undefined): CapabilityClaims | null {
  if (!token?.startsWith('rdv1.')) return null;
  const [, body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(hmacSha256(key(), body, 'base64url'), sig)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CapabilityClaims;
    return c.exp > Math.floor(Date.now() / 1000) ? c : null;
  } catch {
    return null;
  }
}

/** Revocation key for a visitor session's capabilities (set by identity reset). */
export const capabilityRevocationKey = (sessionId: string) => `rd:vcap:revoked:${sessionId}`;

/** Canonical visitor IP hash (IPv4-mapped IPv6 normalized) so exact-IP bans always match. */
export function visitorIpHash(ip: string | null | undefined): string | null {
  return ip ? hashIp(normalizeIp(ip)) : null;
}

/**
 * Route guard for visitor-capability endpoints: verifies the signed capability and
 * rejects capabilities whose session was revoked (identity reset / host logout).
 */
@Injectable()
export class VisitorGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const h = req.headers.authorization;
    const claims = verifyCapability(h?.startsWith('Bearer ') ? h.slice(7) : null);
    if (!claims) throw new AppError(401, 'AUTH_REQUIRED', 'Your chat session expired. Refresh to continue.', { retryable: true });
    if ((await this.redis.client.exists(capabilityRevocationKey(claims.vs))) === 1) {
      throw new AppError(401, 'AUTH_REQUIRED', 'Your chat session expired. Refresh to continue.', { retryable: true });
    }
    const visitor: VisitorContext = {
      tenantId: claims.t,
      siteId: claims.s,
      visitorId: claims.v,
      sessionId: claims.vs,
      requestId: req.requestId ?? '',
      ipHash: visitorIpHash(req.ip),
      origin: claims.o,
      capabilityExpiresAt: new Date(claims.exp * 1000).toISOString(),
    };
    req.visitor = visitor;
    return true;
  }
}
