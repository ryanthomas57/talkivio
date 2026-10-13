import { Injectable } from '@nestjs/common';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AuditService, type AuditActor } from '../../common/audit.service';
import { decrypt, randomToken, sha256 } from '../../common/crypto';
import { AppError, badRequest, notFound } from '../../common/http';
import { RateLimitService } from '../../core/rate-limit.service';
import { normalizeOrigin, originAllowed } from '../widget/origins';
import { HANDOFF_AUDIENCE, IdentityTokenVerifier, subjectHash } from './identity-tokens';

export const HANDOFF_TTL_MS = 60_000;
const CODE_PREFIX = 'rdho_';

/**
 * Cross-domain identity handoff (ch. 26).
 *
 * Authority (documented choice): the customer backend authenticates with its
 * per-site identity secret — the same secret it already uses to sign visitor
 * identity tokens — by sending `Authorization: Bearer <JWT>` where the JWT is
 * HS256 with `aud: "talkivio handoff"`, `iss` = source site id or site key,
 * `sub` = the visitor subject, `iat`/`exp` (≤ 60 s), single-use `jti`, and
 * optional `destination_site_id` / `destination_origin` claims that must
 * match the body. No integration token or dashboard session is accepted.
 *
 * The issued code is opaque (no PII), single use, valid 60 s; only its
 * SHA-256 is stored (`identity_handoffs.nonce_hash`). Redemption consumes it
 * atomically and verifies the exact destination site and origin.
 */
@Injectable()
export class IdentityHandoffService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly verifier: IdentityTokenVerifier,
    private readonly rateLimit: RateLimitService,
  ) {}

  private async resolveSite(siteKey: string): Promise<{ tenantId: string; siteId: string }> {
    if (!siteKey || siteKey.length > 80) throw notFound('Site');
    const rows = await this.db.root.$queryRaw<Array<{ tenant_id: string; site_id: string; active: boolean }>>`SELECT * FROM rd_resolve_site_key(${siteKey})`;
    const r = rows[0];
    if (!r || !r.active) throw notFound('Site');
    return { tenantId: r.tenant_id, siteId: r.site_id };
  }

  async issue(
    authorization: string | undefined,
    input: { siteKey: string; destinationSiteId: string; destinationOrigin: string; visitorSubject: string },
    req: { ipHash: string | null; requestId: string },
  ): Promise<{ handoffCode: string; expiresAt: Date; destinationSiteId: string; destinationOrigin: string; purpose: 'resume' }> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'A signed backend handoff token is required');
    const source = await this.resolveSite(input.siteKey);
    if (!(await this.rateLimit.hit(`handoff-issue:${source.siteId}`, 600, 60))) throw new AppError(429, 'RATE_LIMITED', 'Too many handoff requests', { retryable: true, retryAfter: 30 });
    const destOrigin = normalizeOrigin(input.destinationOrigin);
    if (!destOrigin || destOrigin !== input.destinationOrigin.replace(/\/$/, '').toLowerCase()) {
      throw badRequest('destination_origin must be an exact origin (scheme://host[:port])', { destination_origin: ['Exact origin required'] });
    }

    const site = await this.db.read(source.tenantId, (tx) =>
      tx.site.findFirstOrThrow({ where: { tenantId: source.tenantId, id: source.siteId }, select: { identitySecretCiphertext: true, publicKey: true, previousPublicKey: true } }),
    );
    if (!site.identitySecretCiphertext) throw new AppError(403, 'PERMISSION_DENIED', 'Identity verification is not configured for this site');
    const claims = this.verifier.verify(token, {
      secret: decrypt(site.identitySecretCiphertext),
      tenantId: source.tenantId,
      siteId: source.siteId,
      siteKeys: [site.publicKey, ...(site.previousPublicKey ? [site.previousPublicKey] : [])],
      audience: HANDOFF_AUDIENCE,
      maxLifetimeS: 60,
    });
    if (claims.sub !== input.visitorSubject) throw new AppError(401, 'TOKEN_EXPIRED', 'Handoff token subject does not match visitor_subject');
    if (claims.claims.destination_site_id !== undefined && claims.claims.destination_site_id !== input.destinationSiteId) throw new AppError(401, 'TOKEN_EXPIRED', 'Handoff token destination does not match');
    if (claims.claims.destination_origin !== undefined && claims.claims.destination_origin !== destOrigin) throw new AppError(401, 'TOKEN_EXPIRED', 'Handoff token destination does not match');

    const prepared = await this.db.read(source.tenantId, async (tx) => {
      const dest = await tx.site.findFirst({ where: { tenantId: source.tenantId, id: input.destinationSiteId, enabled: true, archivedAt: null }, select: { id: true } });
      if (!dest) throw notFound('Destination site');
      const rules = await tx.siteOrigin.findMany({ where: { tenantId: source.tenantId, siteId: dest.id }, select: { origin: true, patternType: true } });
      if (!originAllowed(destOrigin, rules)) throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'destination_origin is not approved for the destination site');
      const identity = await tx.visitorIdentity.findUnique({
        where: { tenantId_issuerId_subjectHash: { tenantId: source.tenantId, issuerId: source.siteId, subjectHash: subjectHash(claims.sub) } },
      });
      if (!identity) throw notFound('Visitor');
      const visitor = await tx.visitor.findFirst({ where: { tenantId: source.tenantId, id: identity.visitorId, erasedAt: null }, select: { id: true } });
      if (!visitor) throw notFound('Visitor');
      await this.assertServiceConsent(tx, source.tenantId, visitor.id);
      return { visitorId: visitor.id };
    });

    await this.verifier.consume(source.siteId, HANDOFF_AUDIENCE, claims);
    const code = `${CODE_PREFIX}${randomToken(32)}`;
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
    await this.db.tx(source.tenantId, async (tx) => {
      const h = await tx.identityHandoff.create({
        data: { tenantId: source.tenantId, nonceHash: sha256(code), visitorId: prepared.visitorId, sourceSiteId: source.siteId, destinationSiteId: input.destinationSiteId, destinationOrigin: destOrigin, expiresAt },
      });
      await this.audit.inTx(tx, this.backendActor(source.tenantId, req), {
        action: 'visitor.handoff_issued',
        objectType: 'visitor',
        objectId: prepared.visitorId,
        safeDiff: { handoff_id: h.id, source_site_id: source.siteId, destination_site_id: input.destinationSiteId },
      });
    });
    return { handoffCode: code, expiresAt, destinationSiteId: input.destinationSiteId, destinationOrigin: destOrigin, purpose: 'resume' };
  }

  /** Atomically consume a code for the exact destination; the code is burned even when checks fail. */
  async consume(tenantId: string, code: string, destination: { siteId: string; origin: string }, req: { ipHash: string | null; requestId: string }): Promise<{ visitorId: string; sourceSiteId: string }> {
    if (!code.startsWith(CODE_PREFIX) || code.length > 100) throw new AppError(401, 'TOKEN_EXPIRED', 'This handoff code is invalid or expired');
    const r = await this.db.tx(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; visitor_id: string; source_site_id: string; destination_site_id: string; destination_origin: string; expires_at: Date }>>`
        UPDATE identity_handoffs SET redeemed_at = now()
        WHERE tenant_id = ${tenantId}::uuid AND nonce_hash = ${sha256(code)} AND redeemed_at IS NULL
        RETURNING id, visitor_id, source_site_id, destination_site_id, destination_origin, expires_at`;
      const h = rows[0];
      if (!h) {
        const used = await tx.identityHandoff.findFirst({ where: { tenantId, nonceHash: sha256(code) }, select: { id: true } });
        return { error: used ? ('used' as const) : ('invalid' as const) };
      }
      const outcome =
        h.expires_at.getTime() <= Date.now() ? ('expired' as const) : h.destination_site_id !== destination.siteId || h.destination_origin !== destination.origin ? ('destination' as const) : ('ok' as const);
      await this.audit.inTx(tx, this.backendActor(tenantId, req, 'Visitor handoff'), {
        action: 'visitor.handoff_redeemed',
        objectType: 'visitor',
        objectId: h.visitor_id,
        outcome: outcome === 'ok' ? 'success' : 'denied',
        safeDiff: { handoff_id: h.id, destination_site_id: destination.siteId, result: outcome },
      });
      if (outcome !== 'ok') return { error: outcome };
      await this.assertServiceConsent(tx, tenantId, h.visitor_id).catch(() => {
        throw new AppError(403, 'CONSENT_REQUIRED', 'The visitor withdrew consent for this service');
      });
      return { visitorId: h.visitor_id, sourceSiteId: h.source_site_id };
    });
    if ('error' in r) {
      if (r.error === 'used') throw new AppError(401, 'TOKEN_USED', 'This handoff code was already used');
      if (r.error === 'destination') throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'This handoff code is not valid for this website');
      throw new AppError(401, 'TOKEN_EXPIRED', 'This handoff code is invalid or expired');
    }
    return r;
  }

  /** Latest service-purpose consent must not be denied/withdrawn. */
  private async assertServiceConsent(tx: Tx, tenantId: string, visitorId: string): Promise<void> {
    const latest = await tx.consentRecord.findFirst({ where: { tenantId, visitorId, purpose: 'service' }, orderBy: { recordedAt: 'desc' }, select: { state: true } });
    if (latest && latest.state !== 'granted') throw new AppError(403, 'CONSENT_REQUIRED', 'The visitor has not consented to this service');
  }

  private backendActor(tenantId: string, req: { ipHash: string | null; requestId: string }, name = 'Customer backend'): AuditActor {
    return { tenantId, userId: null, tokenId: null, actorName: name, requestId: req.requestId, ipHash: req.ipHash };
  }
}
