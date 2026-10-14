import { Injectable } from '@nestjs/common';
import { sha256, verifyJwtHS256 } from '../../common/crypto';
import { AppError } from '../../common/http';
import { RedisService } from '../../common/redis.service';
import { EMAIL_RE } from './visitor-common';

/**
 * Customer-backend JWTs (ch. 25/26), HS256 with the per-site identity secret.
 *
 * Required claims: iss (site id or site key), aud, sub, iat, exp, jti.
 *   - aud `talkivio visitor` for identity tokens, `talkivio handoff` for handoff requests
 *     (an identity token can never be replayed as a handoff request or vice versa);
 *   - exp − iat ≤ 300 s (identity) / 60 s (handoff); 60 s clock skew;
 *   - optional tenant_id / site_id / site_ids must include this tenant/site;
 *   - jti is single use (Redis NX until the token can no longer be valid).
 */
export const IDENTITY_AUDIENCE = 'talkivio visitor';
export const HANDOFF_AUDIENCE = 'talkivio handoff';
const SKEW_S = 60;

export interface VerifiedClaims {
  sub: string;
  name: string | null;
  email: string | null;
  jti: string;
  exp: number;
  claims: Record<string, unknown>;
}

const invalid = (message = 'Identity token is invalid or expired') =>
  new AppError(401, 'TOKEN_EXPIRED', message);

@Injectable()
export class IdentityTokenVerifier {
  constructor(private readonly redis: RedisService) {}

  /** Validate signature and claims (no side effects). */
  verify(
    token: string,
    ctx: {
      secret: string;
      tenantId: string;
      siteId: string;
      siteKeys: string[];
      audience: string;
      maxLifetimeS: number;
    },
  ): VerifiedClaims {
    if (!token || token.length > 4000) throw invalid();
    const c = verifyJwtHS256(token, ctx.secret);
    if (!c) throw invalid();
    const now = Math.floor(Date.now() / 1000);
    const iat = c.iat;
    const exp = c.exp;
    if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isFinite(iat) || !Number.isFinite(exp))
      throw invalid('Identity token must carry iat and exp');
    if (exp <= iat || exp - iat > ctx.maxLifetimeS)
      throw invalid(`Identity token lifetime must be at most ${ctx.maxLifetimeS} seconds`);
    if (exp + SKEW_S < now || iat - SKEW_S > now) throw invalid();
    const aud = c.aud;
    if (!(aud === ctx.audience || (Array.isArray(aud) && aud.includes(ctx.audience))))
      throw invalid('Identity token audience is not accepted');
    if (typeof c.iss !== 'string' || !(c.iss === ctx.siteId || ctx.siteKeys.includes(c.iss)))
      throw invalid('Identity token issuer does not match this site');
    if (c.tenant_id !== undefined && c.tenant_id !== ctx.tenantId)
      throw invalid('Identity token is for another workspace');
    if (c.site_id !== undefined && c.site_id !== ctx.siteId)
      throw invalid('Identity token is for another site');
    if (c.site_ids !== undefined && !(Array.isArray(c.site_ids) && c.site_ids.includes(ctx.siteId)))
      throw invalid('Identity token is for another site');
    const sub = typeof c.sub === 'string' ? c.sub.trim() : '';
    if (!sub || sub.length > 200) throw invalid('Identity token has no valid subject');
    const jti = typeof c.jti === 'string' ? c.jti : '';
    if (!jti || jti.length > 128) throw invalid('Identity token must carry a jti');
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 100) : null;
    const rawEmail = typeof c.email === 'string' ? c.email.trim().toLowerCase().slice(0, 200) : null;
    const email = rawEmail && EMAIL_RE.test(rawEmail) ? rawEmail : null;
    return { sub, name, email, jti, exp, claims: c };
  }

  /** Mark the jti used. Throws TOKEN_USED on replay. Call only after every other check passed. */
  async consume(siteId: string, audience: string, v: VerifiedClaims): Promise<void> {
    const ttl = Math.max(60, v.exp - Math.floor(Date.now() / 1000) + SKEW_S * 2);
    const fresh = await this.redis.client.set(
      `rd:jti:${audience === HANDOFF_AUDIENCE ? 'h' : 'i'}:${siteId}:${sha256(v.jti)}`,
      '1',
      'EX',
      ttl,
      'NX',
    );
    if (!fresh) throw new AppError(401, 'TOKEN_USED', 'Identity token was already used');
  }
}

/** Stable subject hash used for VisitorIdentity rows (issuer = site). */
export function subjectHash(sub: string): string {
  return sha256(`subject:${sub}`);
}
