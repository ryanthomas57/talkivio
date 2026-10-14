import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Visitor, type VisitorCredential, type VisitorSession } from '@prisma/client';
import type { IncomingHttpHeaders } from 'node:http';
import {
  DEFAULT_WIDGET_CONFIG,
  generatedVisitorName,
  mergeOrgSettings,
  mergeWidgetConfig,
  type OrgSettings,
  type WidgetConfig,
} from '@talkivio/contracts';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AuditService, type AuditActor } from '../../common/audit.service';
import { decrypt, encrypt, randomToken, sha256, emailLookupHash } from '../../common/crypto';
import { AppError, badRequest, conflict, notFound, type VisitorContext } from '../../common/http';
import { GeoService } from '../../core/geo.service';
import { PresenceService } from '../../core/presence.service';
import { RateLimitService } from '../../core/rate-limit.service';
import { OutboxService } from '../../outbox/outbox.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { TicketsService } from '../../realtime/tickets.service';
import { AvailabilityService, type SiteAvailability } from '../availability/availability.service';
import { ChatStore } from '../chats/chat.store';
import type { PublicChat } from '../chats/chat.projections';
import { BansService, serviceUnavailable } from '../visitors/bans.service';
import { CustomFieldsService, trackSources, type FieldScalar } from '../visitors/custom-fields.service';
import { IdentityHandoffService } from '../visitors/identity-handoff.service';
import {
  IDENTITY_AUDIENCE,
  IdentityTokenVerifier,
  subjectHash,
  type VerifiedClaims,
} from '../visitors/identity-tokens';
import { VisitorCapabilityRevocations, visitorIpHash } from '../visitors/visitor-capability';
import { EMAIL_RE } from '../visitors/visitor-common';
import { VisitorMonitorService } from '../visitors/visitor-monitor.service';
import { normalizeOrigin, originAllowed, originOfUrl, sanitizeTrackedUrl, type OriginRule } from './origins';
import { signCapability } from './capability';

/** Persistent anonymous identity only with analytics consent (ch. 25/26); otherwise a short service credential. */
const CREDENTIAL_TTL_MS = 180 * 86_400_000;
const SERVICE_CREDENTIAL_TTL_MS = 24 * 3600_000;
const SESSION_IDLE_MS = 30 * 60_000;
const TAG_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ResolvedSite {
  tenantId: string;
  siteId: string;
  active: boolean;
  keyStatus: 'current' | 'previous';
}

export interface PublicAvailability {
  state: 'available' | 'busy' | 'offline';
  nextOpenAt: Date | null;
  acceptsQueue: boolean;
  departments: Array<{ id: string; label: string; state: string; nextOpenAt: Date | null }>;
  asOf: Date;
}

export function publicAvailability(a: SiteAvailability): PublicAvailability {
  return {
    state: a.state,
    nextOpenAt: a.nextOpenAt,
    acceptsQueue: a.acceptsQueue,
    departments: a.departments.map((d) => ({
      id: d.id,
      label: d.label,
      state: d.state,
      nextOpenAt: d.nextOpenAt,
    })),
    asOf: a.asOf,
  };
}

type ConsentInput = { analytics?: boolean; service?: boolean; policyVersion?: string } | null | undefined;
type PageInput = { url?: string | null; title?: string | null; referrer?: string | null } | null | undefined;
type RequestInfo = { ip: string | null; headers: IncomingHttpHeaders; requestId?: string };

interface StartSessionArgs {
  tenantId: string;
  siteId: string;
  visitorId: string;
  settings: OrgSettings;
  sessionKey?: string | null;
  consent?: ConsentInput;
  page?: PageInput;
  client: ReturnType<GeoService['parseUserAgent']>;
  geo: ReturnType<GeoService['lookup']>;
  /** Visitor IP and its network owner; stored only when settings.tracking.retainIp is on and tracking is allowed. */
  address: { ip: string | null; network: string | null };
  locale?: string | null;
  timezone?: string | null;
  isPreview?: boolean;
  presentedCredential: VisitorCredential | null;
  issueCredential: boolean;
  consentSource: string;
}

interface StartedSession {
  session: VisitorSession;
  sessionKey: string | null;
  credential: string | null;
  credentialExpiresAt: Date | null;
  analytics: 'granted' | 'denied' | 'unknown';
  activeChat: PublicChat | null;
}

/** Public widget API (ch. 46): bootstrap, visitor sessions, identity, consent, events, handoff. */
@Injectable()
export class WidgetService {
  private readonly logger = new Logger('Widget');

  constructor(
    private readonly db: TenantDb,
    private readonly availability: AvailabilityService,
    private readonly geo: GeoService,
    private readonly presence: PresenceService,
    private readonly tickets: TicketsService,
    private readonly rateLimit: RateLimitService,
    private readonly outbox: OutboxService,
    private readonly store: ChatStore,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly bans: BansService,
    private readonly customFields: CustomFieldsService,
    private readonly monitor: VisitorMonitorService,
    private readonly verifier: IdentityTokenVerifier,
    private readonly handoffs: IdentityHandoffService,
    private readonly revocations: VisitorCapabilityRevocations,
  ) {}

  async resolveSite(siteKey: string): Promise<ResolvedSite> {
    if (!siteKey || siteKey.length > 80) throw notFound('Site');
    const rows = await this.db.root.$queryRaw<
      Array<{ tenant_id: string; site_id: string; active: boolean; key_status: 'current' | 'previous' }>
    >`
      SELECT * FROM rd_resolve_site_key(${siteKey})`;
    const r = rows[0];
    if (!r || !r.active) throw notFound('Site');
    return { tenantId: r.tenant_id, siteId: r.site_id, active: r.active, keyStatus: r.key_status };
  }

  async origins(tenantId: string, siteId: string): Promise<OriginRule[]> {
    return this.db.read(tenantId, (tx) =>
      tx.siteOrigin.findMany({ where: { tenantId, siteId }, select: { origin: true, patternType: true } }),
    );
  }

  async assertOrigin(site: ResolvedSite, hostOrigin: string | null | undefined): Promise<string> {
    const rules = await this.origins(site.tenantId, site.siteId);
    if (!hostOrigin || !originAllowed(hostOrigin, rules))
      throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'This website is not allowed to use this widget');
    return hostOrigin;
  }

  async publishedConfig(tx: Tx, siteId: string): Promise<{ config: WidgetConfig; version: number }> {
    const rev = await tx.widgetConfigRevision.findFirst({
      where: { siteId, publishedAt: { not: null } },
      orderBy: { revision: 'desc' },
    });
    return {
      config: rev ? mergeWidgetConfig(rev.config) : DEFAULT_WIDGET_CONFIG,
      version: rev?.revision ?? 0,
    };
  }

  async bootstrap(
    input: { siteKey: string; hostOrigin: string | null; locale?: string | null },
    req?: { ip: string | null },
  ) {
    const site = await this.resolveSite(input.siteKey);
    await this.assertOrigin(site, input.hostOrigin);
    // IP bans apply before any configuration is disclosed (ch. 24; unban allows a subsequent bootstrap).
    if (req && (await this.bans.isBanned(site.tenantId, site.siteId, null, visitorIpHash(req.ip))))
      throw serviceUnavailable();
    const [{ config, version }, avail, tenant] = await Promise.all([
      this.db.read(site.tenantId, (tx) => this.publishedConfig(tx, site.siteId)),
      this.availability.forSite(site.tenantId, site.siteId),
      this.db.read(site.tenantId, (tx) =>
        tx.tenant.findUniqueOrThrow({ where: { id: site.tenantId }, select: { settings: true, plan: true } }),
      ),
    ]);
    const settings = mergeOrgSettings(tenant.settings);
    if (tenant.plan === 'starter') config.appearance.showBranding = true;
    // Installation evidence: a real bootstrap from an approved origin (ch. 08).
    await this.db.tx(site.tenantId, async (tx) => {
      await tx.site.update({
        where: { id: site.siteId },
        data: { lastVerifiedAt: new Date(), lastVerifiedOrigin: input.hostOrigin },
      });
      await tx.site.updateMany({
        where: { id: site.siteId, installedAt: null },
        data: { installedAt: new Date() },
      });
    });
    return {
      siteId: site.siteId,
      configVersion: version,
      config,
      availability: publicAvailability(avail),
      consent: { analyticsRequired: settings.tracking.analyticsConsentRequired },
      chat: {
        readReceipts: settings.chat.readReceipts,
        reconnectGraceSeconds: settings.chat.reconnectGraceSeconds,
        allowFiles: settings.chat.allowAttachments && config.behavior.attachments.enabled,
        maxFileMb: settings.chat.maxAttachmentMb,
      },
      keyStatus: site.keyStatus,
    };
  }

  // ════════════════════════ Sessions & verified identity ════════════════════════

  /** Validate a customer-backend identity JWT for this site (claims rules in identity-tokens.ts). */
  private async verifyIdentityToken(
    tenantId: string,
    siteId: string,
    token: string,
  ): Promise<VerifiedClaims> {
    const s = await this.db.read(tenantId, (tx) =>
      tx.site.findFirstOrThrow({
        where: { tenantId, id: siteId },
        select: {
          identitySecretCiphertext: true,
          publicKey: true,
          previousPublicKey: true,
          previousKeyExpiresAt: true,
        },
      }),
    );
    if (!s.identitySecretCiphertext)
      throw badRequest('Identity verification is not configured for this site', {
        identity_token: ['Not configured'],
      });
    return this.verifier.verify(token, {
      secret: decrypt(s.identitySecretCiphertext),
      tenantId,
      siteId,
      // A rotated-out key stays a valid issuer only during its overlap window (as for session bootstrap).
      siteKeys: [
        s.publicKey,
        ...(s.previousPublicKey && s.previousKeyExpiresAt && s.previousKeyExpiresAt > new Date()
          ? [s.previousPublicKey]
          : []),
      ],
      audience: IDENTITY_AUDIENCE,
      maxLifetimeS: 300,
    });
  }

  private systemActor(tenantId: string, name: string, requestId = ''): AuditActor {
    return { tenantId, userId: null, tokenId: null, actorName: name, requestId, ipHash: null };
  }

  private async hasOpenChat(tx: Tx, tenantId: string, siteId: string, visitorId: string): Promise<boolean> {
    return !!(await tx.chat.findFirst({
      where: { tenantId, siteId, visitorId, status: { not: 'closed' } },
      select: { id: true },
    }));
  }

  private switchDenied(): AppError {
    return conflict(
      'CONFLICT',
      'Reset the visitor identity before signing in as a different user during an active chat',
    );
  }

  /**
   * Bind verified claims to a visitor. Contact fields become verified only when
   * every stored contact value is vouched for by the token.
   */
  private async applyVerifiedClaims(tx: Tx, visitor: Visitor, claims: VerifiedClaims): Promise<void> {
    const currentEmail = visitor.emailCiphertext ? safeDecrypt(visitor.emailCiphertext) : null;
    const name = claims.name ?? visitor.name;
    const email = claims.email ?? currentEmail;
    const fieldsVerified = (!name || claims.name === name) && (!email || claims.email === email);
    await tx.visitor.update({
      where: { id: visitor.id },
      data: {
        verified: fieldsVerified,
        ...(claims.name ? { name: claims.name } : {}),
        ...(claims.email
          ? { emailCiphertext: encrypt(claims.email), emailLookupHash: emailLookupHash(claims.email) }
          : {}),
        version: { increment: 1 },
      },
    });
  }

  /** Create or resume a visitor + session and issue a short-lived capability. */
  async createSession(
    input: {
      siteKey: string;
      hostOrigin: string | null;
      anonymousToken?: string | null;
      sessionKey?: string | null;
      identityToken?: string | null;
      consent?: ConsentInput;
      page?: PageInput;
      locale?: string | null;
      timezone?: string | null;
      isPreview?: boolean;
    },
    req: RequestInfo,
  ) {
    const site = await this.resolveSite(input.siteKey);
    const origin = await this.assertOrigin(site, input.hostOrigin);
    const ipHash = visitorIpHash(req.ip);
    if (!(await this.rateLimit.hit(`widget-session:${ipHash}`, 120, 60)))
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests', { retryable: true, retryAfter: 30 });
    const tenantId = site.tenantId;
    // Verified identity: validate every claim, then burn the jti before any write (replay protection).
    let claims: VerifiedClaims | null = null;
    if (input.identityToken) {
      claims = await this.verifyIdentityToken(tenantId, site.siteId, input.identityToken);
      await this.verifier.consume(site.siteId, IDENTITY_AUDIENCE, claims);
    }
    const client = this.geo.parseUserAgent(String(req.headers['user-agent'] ?? ''));
    const geo = this.geo.lookup(req.ip, req.headers);
    const address = { ip: this.geo.effectiveIp(req.ip), network: this.geo.network(req.ip) };

    const out = await this.db.tx(tenantId, async (tx) => {
      const settings = mergeOrgSettings(
        (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } })).settings,
      );
      let presented: VisitorCredential | null = null;
      let visitorId: string | null = null;
      if (input.anonymousToken && input.anonymousToken.length >= 20) {
        const cred = await tx.visitorCredential.findUnique({
          where: { tokenHash: sha256(input.anonymousToken) },
        });
        // Credentials are site-bound: cross-origin continuity only through verified identity or handoff (ch. 26).
        if (
          cred &&
          cred.tenantId === tenantId &&
          cred.siteId === site.siteId &&
          !cred.revokedAt &&
          cred.expiresAt > new Date()
        ) {
          const v = await tx.visitor.findFirst({
            where: { tenantId, id: cred.visitorId, erasedAt: null },
            select: { id: true },
          });
          if (v) {
            presented = cred;
            visitorId = cred.visitorId;
          }
        }
      }
      let issueCredential = !visitorId;
      if (claims) {
        const sh = subjectHash(claims.sub);
        let identity = await tx.visitorIdentity.findUnique({
          where: { tenantId_issuerId_subjectHash: { tenantId, issuerId: site.siteId, subjectHash: sh } },
        });
        if (
          identity &&
          (await tx.visitor.count({ where: { tenantId, id: identity.visitorId, erasedAt: { not: null } } }))
        ) {
          // An erased subject is never resurrected: drop the stale binding and start a fresh visitor.
          await tx.visitorIdentity.delete({ where: { id: identity.id } });
          identity = null;
        }
        if (identity) {
          if (visitorId && visitorId !== identity.visitorId) {
            if (await this.hasOpenChat(tx, tenantId, site.siteId, visitorId)) throw this.switchDenied();
            // Same verified subject on another browser: audited association, histories are not merged.
            await this.audit.inTx(tx, this.systemActor(tenantId, 'Visitor identity', req.requestId), {
              action: 'visitor.browser_joined',
              objectType: 'visitor',
              objectId: identity.visitorId,
              safeDiff: { from_visitor_id: visitorId, method: 'jwt_hs256' },
            });
            issueCredential = true;
            presented = null;
          }
          visitorId = identity.visitorId;
        } else {
          if (
            visitorId &&
            (await tx.visitorIdentity.findFirst({ where: { tenantId, visitorId }, select: { id: true } }))
          ) {
            // This browser belongs to a different verified subject: never re-bind it.
            if (await this.hasOpenChat(tx, tenantId, site.siteId, visitorId)) throw this.switchDenied();
            visitorId = null;
            presented = null;
          }
          if (!visitorId) {
            visitorId = (await this.createVisitor(tx, tenantId, site.siteId, client, geo, input)).id;
            issueCredential = true;
          }
          await tx.visitorIdentity.create({
            data: {
              tenantId,
              visitorId,
              issuerId: site.siteId,
              subjectHash: sh,
              verificationMethod: 'jwt_hs256',
            },
          });
          await this.audit.inTx(tx, this.systemActor(tenantId, 'Visitor identity', req.requestId), {
            action: 'visitor.identity_linked',
            objectType: 'visitor',
            objectId: visitorId,
            safeDiff: { issuer_site_id: site.siteId, method: 'jwt_hs256' },
          });
        }
        await this.applyVerifiedClaims(
          tx,
          await tx.visitor.findUniqueOrThrow({ where: { id: visitorId } }),
          claims,
        );
      }
      if (!visitorId) {
        visitorId = (await this.createVisitor(tx, tenantId, site.siteId, client, geo, input)).id;
        issueCredential = true;
      }
      if (await this.bans.isBannedTx(tx, tenantId, site.siteId, visitorId, ipHash))
        throw serviceUnavailable();
      const started = await this.startSession(tx, {
        tenantId,
        siteId: site.siteId,
        visitorId,
        settings,
        sessionKey: input.sessionKey,
        consent: input.consent,
        page: input.page,
        client,
        geo,
        address,
        locale: input.locale,
        timezone: input.timezone,
        isPreview: input.isPreview,
        presentedCredential: presented,
        issueCredential,
        consentSource: 'widget',
      });
      const visitor = await tx.visitor.findUniqueOrThrow({ where: { id: visitorId } });
      const identityVerified = !!(await tx.visitorIdentity.findFirst({
        where: { tenantId, visitorId },
        select: { id: true },
      }));
      return { visitor, identityVerified, ...started };
    });
    await this.monitor.markDirty(tenantId, [out.visitor.id]);
    return this.sessionResponse(tenantId, site.siteId, origin, out);
  }

  private sessionResponse(
    tenantId: string,
    siteId: string,
    origin: string | null,
    out: StartedSession & { visitor: Visitor; identityVerified: boolean },
  ) {
    const cap = signCapability({ t: tenantId, s: siteId, v: out.visitor.id, vs: out.session.id, o: origin });
    return {
      visitor: {
        id: out.visitor.id,
        displayName: out.visitor.name || out.visitor.anonymousLabel,
        verified: out.identityVerified,
        fieldsVerified: out.visitor.verified,
        hasName: !!out.visitor.name,
      },
      sessionId: out.session.id,
      sessionKey: out.sessionKey,
      anonymousToken: out.credential,
      anonymousTokenExpiresAt: out.credentialExpiresAt,
      anonymousTokenPersistence: out.analytics === 'granted' ? 'persistent' : 'session',
      capability: cap.token,
      capabilityExpiresAt: cap.expiresAt,
      consent: { analytics: out.analytics },
      activeChat: out.activeChat,
    };
  }

  /** Session resume/creation, consent records, credential issuance and active chat lookup (shared by sessions, reset, redeem). */
  private async startSession(tx: Tx, a: StartSessionArgs): Promise<StartedSession> {
    const { tenantId, siteId, visitorId, settings } = a;
    const analytics: StartedSession['analytics'] = settings.tracking.analyticsConsentRequired
      ? a.consent?.analytics === true
        ? 'granted'
        : a.consent?.analytics === false
          ? 'denied'
          : 'unknown'
      : 'granted';
    const trackingAllowed = analytics === 'granted';
    let session: VisitorSession | null = null;
    let sessionKey: string | null = null;
    if (a.sessionKey) {
      const s = await tx.visitorSession.findUnique({ where: { sessionKeyHash: sha256(a.sessionKey) } });
      if (
        s &&
        s.tenantId === tenantId &&
        s.siteId === siteId &&
        s.visitorId === visitorId &&
        !s.endedAt &&
        Date.now() - s.lastSeenAt.getTime() < SESSION_IDLE_MS &&
        !(await this.revocations.isRevoked(s.id))
      )
        session = s;
    }
    if (!session) {
      sessionKey = `rdsk_${randomToken(24)}`;
      const landing = trackingAllowed
        ? sanitizeTrackedUrl(a.page?.url, settings.tracking.queryAllowlist)
        : null;
      session = await tx.visitorSession.create({
        data: {
          tenantId,
          visitorId,
          siteId,
          sessionKeyHash: sha256(sessionKey),
          analyticsConsent: analytics,
          currentUrl: landing,
          currentTitle: trackingAllowed ? (a.page?.title ?? '').trim().slice(0, 200) || null : null,
          landingUrl: landing,
          referrerOrigin: trackingAllowed ? originOfUrl(a.page?.referrer) : null,
          deviceCategory: a.client.deviceType,
          browser: a.client.browser,
          os: a.client.os,
          country: trackingAllowed && settings.tracking.locationEnabled ? a.geo.countryCode : null,
          city: trackingAllowed && settings.tracking.locationEnabled ? a.geo.city : null,
          ipAddress:
            trackingAllowed && settings.tracking.retainIp ? (a.address.ip?.slice(0, 45) ?? null) : null,
          network:
            trackingAllowed && settings.tracking.retainIp ? (a.address.network?.slice(0, 160) ?? null) : null,
          isPreview: !!a.isPreview,
        },
      });
      const counted = await tx.visitor.update({
        where: { id: visitorId },
        data: {
          visitCount: { increment: 1 },
          lastSeenAt: new Date(),
          deviceCategory: a.client.deviceType,
          browser: a.client.browser,
          os: a.client.os,
          countryCode: settings.tracking.locationEnabled ? a.geo.countryCode : null,
          region: settings.tracking.locationEnabled ? a.geo.region : null,
          city: settings.tracking.locationEnabled ? a.geo.city : null,
          language: a.locale?.slice(0, 20) ?? undefined,
          timezone: a.timezone?.slice(0, 60) ?? undefined,
        },
      });
      // Internal-only session start signal (trigger engine). Consumers derive a stable event id
      // from the session id (sessionStartedEventId), so redelivery or the socket fallback dedupe.
      await this.outbox.append(tx, tenantId, {
        aggregateType: 'visitor_session',
        aggregateId: session.id,
        aggregateVersion: 1,
        eventType: 'visitor.session.started',
        payload: {
          visitorId,
          sessionId: session.id,
          siteId,
          returning: counted.visitCount > 1,
          pageUrl: session.currentUrl,
          referrerOrigin: session.referrerOrigin,
          startedAt: session.startedAt,
        },
        scopes: [],
      });
    } else {
      const patch: Prisma.VisitorSessionUpdateInput = { lastSeenAt: new Date() };
      // The workspace stopped requiring analytics consent after this session started: it now counts as a new
      // session would (granted). An explicit denial or withdrawal is never overridden.
      if (!settings.tracking.analyticsConsentRequired && session.analyticsConsent === 'unknown')
        patch.analyticsConsent = 'granted';
      // A session that started without a location (tracking not allowed yet, or no database then) gets one once allowed.
      if (
        (patch.analyticsConsent ?? session.analyticsConsent) === 'granted' &&
        settings.tracking.locationEnabled &&
        !session.country &&
        a.geo.countryCode
      )
        Object.assign(patch, { country: a.geo.countryCode, city: a.geo.city });
      // IP address and network: current while the workspace stores them (visitors change networks), gone once it stops.
      if ((patch.analyticsConsent ?? session.analyticsConsent) === 'granted' && settings.tracking.retainIp)
        Object.assign(patch, {
          ipAddress: a.address.ip?.slice(0, 45) ?? null,
          network: a.address.network?.slice(0, 160) ?? null,
        });
      else if (session.ipAddress || session.network) Object.assign(patch, { ipAddress: null, network: null });
      if (a.consent && typeof a.consent.analytics === 'boolean' && session.analyticsConsent !== analytics) {
        patch.analyticsConsent = analytics;
        if (!trackingAllowed)
          Object.assign(patch, {
            currentUrl: null,
            currentTitle: null,
            referrerOrigin: null,
            landingUrl: null,
            utm: Prisma.DbNull,
            country: null,
            city: null,
            ipAddress: null,
            network: null,
          });
      }
      session = await tx.visitorSession.update({ where: { id: session.id }, data: patch });
    }
    const policyVersion = (a.consent?.policyVersion ?? 'unspecified').slice(0, 40);
    if (a.consent && typeof a.consent.analytics === 'boolean') {
      await tx.consentRecord.create({
        data: {
          tenantId,
          visitorId,
          sessionId: session.id,
          purpose: 'analytics',
          state: a.consent.analytics ? 'granted' : 'denied',
          policyVersion,
          source: a.consentSource,
        },
      });
    }
    if (a.consent && typeof a.consent.service === 'boolean') {
      await tx.consentRecord.create({
        data: {
          tenantId,
          visitorId,
          sessionId: session.id,
          purpose: 'service',
          state: a.consent.service ? 'granted' : 'denied',
          policyVersion,
          source: a.consentSource,
        },
      });
    }
    let credential: string | null = null;
    let credentialExpiresAt: Date | null = null;
    const ttl = trackingAllowed ? CREDENTIAL_TTL_MS : SERVICE_CREDENTIAL_TTL_MS;
    if (a.issueCredential) {
      credential = `rdvc_${randomToken(32)}`;
      credentialExpiresAt = new Date(Date.now() + ttl);
      await tx.visitorCredential.create({
        data: { tenantId, visitorId, siteId, tokenHash: sha256(credential), expiresAt: credentialExpiresAt },
      });
    } else if (a.presentedCredential) {
      credentialExpiresAt = a.presentedCredential.expiresAt;
      if (trackingAllowed && a.presentedCredential.expiresAt.getTime() < Date.now() + CREDENTIAL_TTL_MS / 2) {
        credentialExpiresAt = new Date(Date.now() + CREDENTIAL_TTL_MS);
        await tx.visitorCredential.update({
          where: { id: a.presentedCredential.id },
          data: { expiresAt: credentialExpiresAt },
        });
      }
    }
    const activeChat = await tx.chat.findFirst({
      where: {
        tenantId,
        visitorId,
        siteId,
        OR: [{ status: { not: 'closed' } }, { closedAt: { gt: new Date(Date.now() - 24 * 3600_000) } }],
      },
      orderBy: { requestedAt: 'desc' },
      select: { id: true },
    });
    return {
      session,
      sessionKey,
      credential,
      credentialExpiresAt,
      analytics,
      activeChat: activeChat ? await this.store.publicChat(tx, activeChat.id) : null,
    };
  }

  private async createVisitor(
    tx: Tx,
    tenantId: string,
    siteId: string,
    client: ReturnType<GeoService['parseUserAgent']>,
    geo: ReturnType<GeoService['lookup']>,
    input: { locale?: string | null; timezone?: string | null },
  ) {
    const v = await tx.visitor.create({
      data: {
        tenantId,
        siteId,
        anonymousLabel: 'Visitor',
        browser: client.browser,
        os: client.os,
        deviceCategory: client.deviceType,
        language: input.locale?.slice(0, 20) ?? null,
        timezone: input.timezone?.slice(0, 60) ?? null,
        countryCode: geo.countryCode,
        region: geo.region,
        city: geo.city,
      },
    });
    return tx.visitor.update({ where: { id: v.id }, data: { anonymousLabel: generatedVisitorName(v.id) } });
  }

  // ════════════════════════ Identify (unverified prefill or verified token) ════════════════════════

  async identify(
    v: VisitorContext,
    input: { name?: string | null; email?: string | null; verifiedToken?: string | null },
  ) {
    const email = input.email?.trim().toLowerCase() || null;
    if (email && !EMAIL_RE.test(email))
      throw badRequest('Enter a valid email address', { email: ['Enter a valid email address.'] });
    const name = input.name?.trim().slice(0, 100) || null;
    let claims: VerifiedClaims | null = null;
    if (input.verifiedToken) {
      claims = await this.verifyIdentityToken(v.tenantId, v.siteId, input.verifiedToken);
      // Check binding rules before burning the jti.
      await this.db.read(v.tenantId, async (tx) => {
        const identity = await tx.visitorIdentity.findUnique({
          where: {
            tenantId_issuerId_subjectHash: {
              tenantId: v.tenantId,
              issuerId: v.siteId,
              subjectHash: subjectHash(claims!.sub),
            },
          },
        });
        if (identity && identity.visitorId !== v.visitorId) {
          throw conflict(
            'CONFLICT',
            'This identity belongs to another visitor profile; start a new session with the identity token',
            false,
            { action: 'create_session' },
          );
        }
        if (
          !identity &&
          (await tx.visitorIdentity.findFirst({
            where: { tenantId: v.tenantId, visitorId: v.visitorId },
            select: { id: true },
          }))
        )
          throw this.switchDenied();
      });
      await this.verifier.consume(v.siteId, IDENTITY_AUDIENCE, claims);
    }
    const r = await this.db.tx(v.tenantId, async (tx) => {
      let visitor = await tx.visitor.findFirst({ where: { tenantId: v.tenantId, id: v.visitorId } });
      if (!visitor) throw notFound('Visitor');
      if (claims) {
        const sh = subjectHash(claims.sub);
        const existing = await tx.visitorIdentity.findUnique({
          where: {
            tenantId_issuerId_subjectHash: { tenantId: v.tenantId, issuerId: v.siteId, subjectHash: sh },
          },
        });
        if (!existing) {
          await tx.visitorIdentity.create({
            data: {
              tenantId: v.tenantId,
              visitorId: v.visitorId,
              issuerId: v.siteId,
              subjectHash: sh,
              verificationMethod: 'jwt_hs256',
            },
          });
          await this.audit.inTx(tx, this.systemActor(v.tenantId, 'Visitor identity', v.requestId), {
            action: 'visitor.identity_linked',
            objectType: 'visitor',
            objectId: v.visitorId,
            safeDiff: { issuer_site_id: v.siteId, method: 'jwt_hs256' },
          });
        }
        await this.applyVerifiedClaims(tx, visitor, claims);
        visitor = await tx.visitor.findUniqueOrThrow({ where: { id: v.visitorId } });
      }
      // Unverified SDK values only prefill; they never overwrite verified contact fields.
      const ignored: string[] = [];
      const data: Prisma.VisitorUpdateInput = {};
      if (name && name !== visitor.name) {
        if (visitor.verified && visitor.name) ignored.push('name');
        else data.name = name;
      }
      if (email) {
        const current = visitor.emailCiphertext ? safeDecrypt(visitor.emailCiphertext) : null;
        if (email !== current) {
          if (visitor.verified && current) ignored.push('email');
          else
            Object.assign(data, { emailCiphertext: encrypt(email), emailLookupHash: emailLookupHash(email) });
        }
      }
      if (Object.keys(data).length)
        visitor = await tx.visitor.update({
          where: { id: v.visitorId },
          data: { ...data, verified: false, version: { increment: 1 } },
        });
      const identityVerified = !!(await tx.visitorIdentity.findFirst({
        where: { tenantId: v.tenantId, visitorId: v.visitorId },
        select: { id: true },
      }));
      return {
        visitorId: visitor.id,
        verified: identityVerified,
        fieldsVerified: visitor.verified,
        displayName: visitor.name || visitor.anonymousLabel,
        ignored,
      };
    });
    await this.monitor.markDirty(v.tenantId, [v.visitorId]);
    return r;
  }

  // ════════════════════════ Reset (host logout) ════════════════════════

  /**
   * Host app logout: revoke this browser's credential, end every open session
   * of the visitor on this site, revoke their capabilities and sockets, and
   * return a brand-new anonymous context. Server records are kept.
   */
  async resetIdentity(
    v: VisitorContext,
    input: {
      anonymousToken?: string | null;
      consent?: ConsentInput;
      page?: PageInput;
      locale?: string | null;
      timezone?: string | null;
    },
    req: RequestInfo,
  ) {
    const client = this.geo.parseUserAgent(String(req.headers['user-agent'] ?? ''));
    const geo = this.geo.lookup(req.ip, req.headers);
    const address = { ip: this.geo.effectiveIp(req.ip), network: this.geo.network(req.ip) };
    const out = await this.db.tx(v.tenantId, async (tx) => {
      const settings = mergeOrgSettings(
        (await tx.tenant.findUniqueOrThrow({ where: { id: v.tenantId }, select: { settings: true } }))
          .settings,
      );
      let revokedCredentials = 0;
      if (input.anonymousToken) {
        revokedCredentials = (
          await tx.visitorCredential.updateMany({
            where: {
              tenantId: v.tenantId,
              visitorId: v.visitorId,
              tokenHash: sha256(input.anonymousToken),
              revokedAt: null,
            },
            data: { revokedAt: new Date() },
          })
        ).count;
      }
      const ended = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE visitor_sessions SET ended_at = GREATEST(now(), started_at)
        WHERE tenant_id = ${v.tenantId}::uuid AND visitor_id = ${v.visitorId}::uuid AND site_id = ${v.siteId}::uuid AND ended_at IS NULL
        RETURNING id`;
      await this.audit.inTx(tx, this.systemActor(v.tenantId, 'Visitor', v.requestId), {
        action: 'visitor.identity_reset',
        objectType: 'visitor',
        objectId: v.visitorId,
        safeDiff: { sessions_ended: ended.length, credentials_revoked: revokedCredentials },
      });
      const fresh = await this.createVisitor(tx, v.tenantId, v.siteId, client, geo, input);
      const started = await this.startSession(tx, {
        tenantId: v.tenantId,
        siteId: v.siteId,
        visitorId: fresh.id,
        settings,
        consent: input.consent,
        page: input.page,
        client,
        geo,
        address,
        locale: input.locale,
        timezone: input.timezone,
        presentedCredential: null,
        issueCredential: true,
        consentSource: 'widget_reset',
      });
      const visitor = await tx.visitor.findUniqueOrThrow({ where: { id: fresh.id } });
      return { visitor, identityVerified: false, ...started, endedSessionIds: ended.map((e) => e.id) };
    });
    await this.revocations.revokeSessions([...new Set([v.sessionId, ...out.endedSessionIds])]);
    this.realtime.revokeVisitor(v.tenantId, v.visitorId, 'visitor_reset');
    await this.presence.forgetVisitor(v.tenantId, v.visitorId);
    await this.monitor.markDirty(v.tenantId, [v.visitorId, out.visitor.id]);
    return { ok: true, reset: true, ...this.sessionResponse(v.tenantId, v.siteId, v.origin, out) };
  }

  // ════════════════════════ Consent ════════════════════════

  async setConsent(
    v: VisitorContext,
    input: {
      purpose: 'analytics' | 'service';
      state: 'granted' | 'denied' | 'withdrawn';
      policyVersion: string;
    },
  ) {
    const r = await this.db.tx(v.tenantId, async (tx) => {
      const record = await tx.consentRecord.create({
        data: {
          tenantId: v.tenantId,
          visitorId: v.visitorId,
          sessionId: v.sessionId,
          purpose: input.purpose,
          state: input.state,
          policyVersion: input.policyVersion.slice(0, 40),
          source: 'sdk',
        },
      });
      let purgeJobId: string | null = null;
      if (input.purpose === 'analytics') {
        const open = await tx.visitorSession.findMany({
          where: { tenantId: v.tenantId, visitorId: v.visitorId, siteId: v.siteId, endedAt: null },
          select: { id: true, analyticsConsent: true },
        });
        const ids = [...new Set([v.sessionId, ...open.map((s) => s.id)])];
        if (input.state === 'granted') {
          await tx.visitorSession.updateMany({
            where: { tenantId: v.tenantId, id: { in: ids } },
            data: { analyticsConsent: 'granted' },
          });
        } else {
          // Stop optional collection immediately and clear optional session fields.
          await tx.visitorSession.updateMany({
            where: { tenantId: v.tenantId, id: { in: ids } },
            data: {
              analyticsConsent: input.state,
              currentUrl: null,
              currentTitle: null,
              referrerOrigin: null,
              landingUrl: null,
              utm: Prisma.DbNull,
              country: null,
              city: null,
              ipAddress: null,
              network: null,
            },
          });
          const hadGrant = open.some((s) => s.analyticsConsent === 'granted');
          if (input.state === 'withdrawn' || hadGrant)
            purgeJobId = await this.monitor.createConsentPurgeJob(
              tx,
              v.tenantId,
              v.visitorId,
              record.id,
              record.recordedAt,
            );
        }
      }
      return { record, purgeJobId };
    });
    if (input.purpose === 'analytics' && input.state !== 'granted') {
      await this.presence.patchVisitorState(v.tenantId, v.visitorId, {
        currentUrl: '',
        currentTitle: '',
        referrerOrigin: '',
      });
    }
    if (r.purgeJobId) await this.monitor.enqueueConsentPurge(v.tenantId, r.purgeJobId);
    await this.monitor.markDirty(v.tenantId, [v.visitorId]);
    const restricted = input.purpose === 'analytics' && input.state !== 'granted';
    return {
      purpose: input.purpose,
      state: input.state,
      policyVersion: r.record.policyVersion,
      recordedAt: r.record.recordedAt,
      collection:
        input.purpose === 'analytics'
          ? input.state === 'granted'
            ? 'enabled'
            : 'restricted'
          : input.state === 'granted'
            ? 'enabled'
            : 'restricted',
      clientActions: restricted ? ['stop_page_events', 'clear_optional_storage'] : [],
      // Deletion is asynchronous: never reported complete before the durable worker finishes.
      erasure: r.purgeJobId ? { state: 'scheduled', jobId: r.purgeJobId } : null,
    };
  }

  // ════════════════════════ Page events ════════════════════════

  /** Bounded batch of page events; ignored unless analytics consent is granted. Deduplicated by client event id. */
  async ingestEvents(
    v: VisitorContext,
    events: Array<{
      id: string;
      kind: 'entered' | 'left' | 'visible' | 'hidden';
      url?: string | null;
      title?: string | null;
      clientAt?: string | null;
    }>,
  ) {
    if (events.length > 20) throw badRequest('At most 20 events per batch', { events: ['Maximum 20'] });
    if (!(await this.rateLimit.hit(`widget-events:${v.sessionId}`, 120, 60)))
      throw new AppError(429, 'RATE_LIMITED', 'Too many events', { retryable: true, retryAfter: 30 });
    const result = await this.db.tx(v.tenantId, async (tx) => {
      const session = await tx.visitorSession.findFirst({
        where: { tenantId: v.tenantId, id: v.sessionId, visitorId: v.visitorId },
      });
      if (!session) throw notFound('Session');
      if (session.endedAt)
        return {
          accepted: 0,
          duplicates: 0,
          ignored: events.length,
          reason: 'session_ended' as const,
          entered: null,
        };
      const settings = mergeOrgSettings(
        (await tx.tenant.findUniqueOrThrow({ where: { id: v.tenantId }, select: { settings: true } }))
          .settings,
      );
      let consent = session.analyticsConsent;
      if (consent === 'unknown' && !settings.tracking.analyticsConsentRequired) {
        // Consent stopped being required while this tab was open: same as a new session (granted).
        await tx.visitorSession.update({ where: { id: session.id }, data: { analyticsConsent: 'granted' } });
        consent = 'granted';
      }
      if (consent !== 'granted')
        return {
          accepted: 0,
          duplicates: 0,
          ignored: events.length,
          reason: 'consent' as const,
          entered: null,
        };
      const ids = [...new Set(events.map((e) => String(e.id).slice(0, 64)))];
      const seen = new Set(
        (
          await tx.pageEvent.findMany({
            where: { tenantId: v.tenantId, sessionId: v.sessionId, clientEventId: { in: ids } },
            select: { clientEventId: true },
          })
        ).map((e) => e.clientEventId),
      );
      const receivedAt = new Date();
      const rows: Prisma.PageEventCreateManyInput[] = [];
      let lastEntered: { url: string; title: string | null } | null = null;
      let duplicates = 0;
      let currentUrl = session.currentUrl;
      for (const e of events) {
        const clientEventId = String(e.id).slice(0, 64);
        if (seen.has(clientEventId)) {
          duplicates++;
          continue;
        }
        seen.add(clientEventId);
        const url =
          sanitizeTrackedUrl(e.url, settings.tracking.queryAllowlist) ??
          (e.kind === 'entered' ? null : currentUrl);
        if (!url) continue;
        const title = e.title?.trim().slice(0, 200) || null;
        const clientAt = e.clientAt ? new Date(e.clientAt) : null;
        rows.push({
          tenantId: v.tenantId,
          sessionId: v.sessionId,
          clientEventId,
          kind: e.kind,
          sanitizedUrl: url,
          title,
          receivedAt,
          clientAt: clientAt && !Number.isNaN(clientAt.getTime()) ? clientAt : null,
        });
        if (e.kind === 'entered') {
          lastEntered = { url, title };
          currentUrl = url;
        }
      }
      if (rows.length) await tx.pageEvent.createMany({ data: rows, skipDuplicates: true });
      const enteredCount = rows.filter((r) => r.kind === 'entered').length;
      await tx.visitorSession.update({
        where: { id: v.sessionId },
        data: {
          lastSeenAt: receivedAt,
          ...(lastEntered
            ? {
                currentUrl: lastEntered.url,
                currentTitle: lastEntered.title,
                pageViewCount: { increment: enteredCount },
              }
            : {}),
        },
      });
      if (lastEntered) {
        await this.outbox.append(tx, v.tenantId, {
          aggregateType: 'visitor_session',
          aggregateId: v.sessionId,
          aggregateVersion: session.pageViewCount + enteredCount,
          eventType: 'visitor.page.changed',
          payload: {
            visitorId: v.visitorId,
            sessionId: v.sessionId,
            siteId: v.siteId,
            url: lastEntered.url,
            title: lastEntered.title,
            receivedAt,
          },
          scopes: [],
        });
      }
      return {
        accepted: rows.length,
        duplicates,
        ignored: events.length - rows.length - duplicates,
        reason: null,
        entered: lastEntered,
      };
    });
    if (result.accepted) {
      await this.presence.patchVisitorState(v.tenantId, v.visitorId, {
        ...(result.entered
          ? {
              currentUrl: result.entered.url,
              currentTitle: result.entered.title ?? '',
              pageEnteredAt: Date.now(),
              sessionId: v.sessionId,
            }
          : {}),
        lastActivityAt: Date.now(),
      });
      await this.monitor.markDirty(v.tenantId, [v.visitorId]);
    }
    return {
      accepted: result.accepted,
      duplicates: result.duplicates,
      ignored: result.ignored,
      reason: result.reason,
    };
  }

  // ════════════════════════ SDK tags & custom fields ════════════════════════

  /** Public projection of SDK-visible visitor fields (never agent/trigger tags or private custom fields). */
  private async publicVisitorFields(tx: Tx, v: VisitorContext, writtenKeys: string[] = []) {
    const visitor = await tx.visitor.findFirstOrThrow({ where: { tenantId: v.tenantId, id: v.visitorId } });
    const defs = await this.customFields.activeDefinitions(tx, v.tenantId);
    const stored = (visitor.customFields ?? {}) as Record<string, unknown>;
    const fields: Record<string, FieldScalar> = {};
    for (const [k, val] of Object.entries(stored)) {
      const d = defs.get(k);
      if (
        d &&
        (d.visibleToVisitor || (d.publicWritable && writtenKeys.includes(k))) &&
        val !== null &&
        typeof val !== 'object'
      )
        fields[k] = val as FieldScalar;
    }
    const clientTags = await tx.visitorTag.findMany({
      where: { tenantId: v.tenantId, visitorId: v.visitorId, source: 'client' },
      select: { tagId: true },
    });
    const tags = clientTags.length
      ? await tx.tag.findMany({
          where: { tenantId: v.tenantId, id: { in: clientTags.map((t) => t.tagId) }, archivedAt: null },
          select: { slug: true },
          orderBy: { slug: 'asc' },
        })
      : [];
    const identityVerified = !!(await tx.visitorIdentity.findFirst({
      where: { tenantId: v.tenantId, visitorId: v.visitorId },
      select: { id: true },
    }));
    return {
      visitorId: visitor.id,
      displayName: visitor.name || visitor.anonymousLabel,
      verified: identityVerified,
      customFields: fields,
      tags: tags.map((t) => t.slug),
    };
  }

  /** SDK setCustomFields: only `public_writable` definitions; values are client-supplied (unverified) attributes. */
  async setVisitorCustomFields(v: VisitorContext, patch: Record<string, unknown>) {
    const r = await this.db.tx(v.tenantId, async (tx) => {
      const visitor = await tx.visitor.findFirst({ where: { tenantId: v.tenantId, id: v.visitorId } });
      if (!visitor) throw notFound('Visitor');
      const { next, changedKeys } = await this.customFields.applyPatch(
        tx,
        v.tenantId,
        visitor.customFields,
        patch,
        { publicOnly: true },
      );
      if (changedKeys.length) {
        // The page's values are client-supplied: attributed to the visitor (unverified), never to staff.
        const sources = trackSources(visitor.customFieldSources, changedKeys, next, 'visitor', null);
        await tx.visitor.update({
          where: { id: visitor.id },
          data: {
            customFields: next as Prisma.InputJsonValue,
            customFieldSources: sources as unknown as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
        });
      }
      return this.publicVisitorFields(tx, v, Object.keys(patch));
    });
    await this.monitor.markDirty(v.tenantId, [v.visitorId]);
    return r;
  }

  /**
   * SDK setTags: replaces the visitor's client-sourced tags. Only existing,
   * non-archived tags can be referenced (the SDK never creates tags); rows are
   * stored with source `client`, so they never impersonate agent/trigger tags,
   * and agent-applied tags are never removed.
   */
  async setVisitorTags(v: VisitorContext, rawTags: string[]) {
    const errors: Record<string, string[]> = {};
    const slugs: string[] = [];
    rawTags.forEach((t, i) => {
      const slug = t.trim().toLowerCase();
      if (!TAG_SLUG_RE.test(slug))
        errors[`tags.${i}`] = ['Use a lower-case slug (letters, digits, - or _), at most 64 characters'];
      else if (!slugs.includes(slug)) slugs.push(slug);
    });
    if (Object.keys(errors).length) throw badRequest('Some tags are not valid', errors);
    const r = await this.db.tx(v.tenantId, async (tx) => {
      const tags = slugs.length
        ? await tx.tag.findMany({
            where: { tenantId: v.tenantId, slug: { in: slugs }, archivedAt: null },
            select: { id: true, slug: true },
          })
        : [];
      const known = new Set(tags.map((t) => t.slug));
      const unknown = slugs.filter((s) => !known.has(s));
      if (unknown.length) {
        const fe: Record<string, string[]> = {};
        for (const s of unknown)
          fe[`tags.${rawTags.findIndex((t) => t.trim().toLowerCase() === s)}`] = ['Unknown tag'];
        throw badRequest('Some tags are not allowed', fe);
      }
      const existing = await tx.visitorTag.findMany({
        where: { tenantId: v.tenantId, visitorId: v.visitorId },
        select: { tagId: true, source: true },
      });
      const wanted = new Set(tags.map((t) => t.id));
      const removeClient = existing
        .filter((e) => e.source === 'client' && !wanted.has(e.tagId))
        .map((e) => e.tagId);
      if (removeClient.length)
        await tx.visitorTag.deleteMany({
          where: {
            tenantId: v.tenantId,
            visitorId: v.visitorId,
            source: 'client',
            tagId: { in: removeClient },
          },
        });
      const add = [...wanted].filter((id) => !existing.some((e) => e.tagId === id));
      if (add.length)
        await tx.visitorTag.createMany({
          data: add.map((tagId) => ({
            tenantId: v.tenantId,
            visitorId: v.visitorId,
            tagId,
            source: 'client' as const,
          })),
          skipDuplicates: true,
        });
      return this.publicVisitorFields(tx, v);
    });
    await this.monitor.markDirty(v.tenantId, [v.visitorId]);
    return r;
  }

  // ════════════════════════ Cross-domain handoff redemption ════════════════════════

  async redeemHandoff(
    input: {
      handoffCode: string;
      siteKey: string;
      hostOrigin: string | null;
      consent?: ConsentInput;
      page?: PageInput;
      locale?: string | null;
      timezone?: string | null;
    },
    req: RequestInfo,
  ) {
    const site = await this.resolveSite(input.siteKey);
    const origin = await this.assertOrigin(site, input.hostOrigin);
    const ipHash = visitorIpHash(req.ip);
    if (!(await this.rateLimit.hit(`widget-redeem:${ipHash}`, 30, 60)))
      throw new AppError(429, 'RATE_LIMITED', 'Too many requests', { retryable: true, retryAfter: 30 });
    const h = await this.handoffs.consume(
      site.tenantId,
      input.handoffCode,
      { siteId: site.siteId, origin: normalizeOrigin(origin) ?? origin },
      { ipHash, requestId: req.requestId ?? '' },
    );
    const client = this.geo.parseUserAgent(String(req.headers['user-agent'] ?? ''));
    const geo = this.geo.lookup(req.ip, req.headers);
    const address = { ip: this.geo.effectiveIp(req.ip), network: this.geo.network(req.ip) };
    const out = await this.db.tx(site.tenantId, async (tx) => {
      const settings = mergeOrgSettings(
        (await tx.tenant.findUniqueOrThrow({ where: { id: site.tenantId }, select: { settings: true } }))
          .settings,
      );
      const visitor = await tx.visitor.findFirst({
        where: { tenantId: site.tenantId, id: h.visitorId, erasedAt: null },
      });
      if (!visitor) throw new AppError(401, 'TOKEN_EXPIRED', 'This handoff code is invalid or expired');
      if (await this.bans.isBannedTx(tx, site.tenantId, site.siteId, visitor.id, ipHash))
        throw serviceUnavailable();
      // New destination-scoped session; chats stay with their origin site (no ownership transfer).
      const started = await this.startSession(tx, {
        tenantId: site.tenantId,
        siteId: site.siteId,
        visitorId: visitor.id,
        settings,
        consent: input.consent,
        page: input.page,
        client,
        geo,
        address,
        locale: input.locale,
        timezone: input.timezone,
        presentedCredential: null,
        issueCredential: true,
        consentSource: 'handoff',
      });
      const identityVerified = !!(await tx.visitorIdentity.findFirst({
        where: { tenantId: site.tenantId, visitorId: visitor.id },
        select: { id: true },
      }));
      return {
        visitor: await tx.visitor.findUniqueOrThrow({ where: { id: visitor.id } }),
        identityVerified,
        ...started,
      };
    });
    await this.monitor.markDirty(site.tenantId, [out.visitor.id]);
    return {
      ...this.sessionResponse(site.tenantId, site.siteId, origin, out),
      handoff: { sourceSiteId: h.sourceSiteId, purpose: 'resume' },
    };
  }

  // ════════════════════════ Misc ════════════════════════

  async availabilityFor(v: { tenantId: string; siteId: string }) {
    return publicAvailability(await this.availability.forSite(v.tenantId, v.siteId));
  }

  async socketTicket(v: VisitorContext) {
    // A banned visitor cannot reconnect after the ban cut their socket (neutral refusal, ch. 24/76).
    if (await this.bans.isBanned(v.tenantId, v.siteId, v.visitorId, v.ipHash))
      throw new AppError(403, 'SERVICE_UNAVAILABLE', 'Service unavailable', { retryable: false });
    return this.tickets.mint({
      kind: 'visitor',
      tenantId: v.tenantId,
      siteId: v.siteId,
      visitorId: v.visitorId,
      sessionId: v.sessionId,
      origin: v.origin,
      capabilityExpiry: v.capabilityExpiresAt ?? null,
    });
  }

  assertChatOwned(chat: { visitorId: string } | null, v: VisitorContext): void {
    if (!chat || chat.visitorId !== v.visitorId) throw notFound('Chat');
  }

  /** Transcript reads are bound to the capability's site (a handoff never exposes another site's chats). */
  async assertChatOnSite(v: VisitorContext, chatId: string): Promise<void> {
    const chat = await this.db.read(v.tenantId, (tx) =>
      tx.chat.findFirst({
        where: { tenantId: v.tenantId, id: chatId, visitorId: v.visitorId, siteId: v.siteId },
        select: { id: true },
      }),
    );
    if (!chat) throw notFound('Chat');
  }
}

function safeDecrypt(c: string): string | null {
  try {
    return decrypt(c);
  } catch {
    return null;
  }
}
