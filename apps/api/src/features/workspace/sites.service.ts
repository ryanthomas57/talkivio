import { lockForUpdate } from '../../db/row-lock';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { DEFAULT_WIDGET_CONFIG, mergeWidgetConfig, widgetConfigSchema, type WidgetConfig } from '@talkivio/contracts';
import { TenantDb } from '../../db/tenant-db';
import { encrypt, randomId, randomToken } from '../../common/crypto';
import { badRequest, conflict, notFound, zodError, type AuthContext } from '../../common/http';
import { AuditService } from '../../common/audit.service';
import { env, widgetBaseUrl } from '../../config/env';
import { OutboxService } from '../../outbox/outbox.service';
import { RealtimeService, VISITOR_NS, controlRooms } from '../../realtime/realtime.service';
import { normalizeOrigin, validateOriginRule } from '../widget/origins';
import { AvailabilityBroadcaster } from '../availability/availability.broadcaster';

export function newSiteKey(): string {
  return randomId('rds', 18);
}

export function installSnippet(siteKey: string): string {
  return `<!-- Talkivio chat -->
<script>
  window.Talkivio = window.Talkivio || function () { (window.Talkivio.q = window.Talkivio.q || []).push(arguments); };
</script>
<script async crossorigin="anonymous" src="${widgetBaseUrl()}/loader.js" data-site-key="${siteKey}"></script>`;
}

/** Sites, allowed origins, key rotation and versioned widget configuration (ch. 08). */
@Injectable()
export class SitesService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
    private readonly broadcaster: AvailabilityBroadcaster,
  ) {}

  private resource(s: Prisma.SiteGetPayload<{ include: { origins: true } }>) {
    return {
      id: s.id,
      name: s.name,
      publicKey: s.publicKey,
      enabled: s.enabled,
      configRevision: s.configRevision,
      defaultDepartmentId: s.defaultDepartmentId,
      scheduleId: s.scheduleId,
      origins: s.origins.map((o) => ({ origin: o.origin, patternType: o.patternType, verifiedAt: o.verifiedAt })),
      identityVerificationEnabled: !!s.identitySecretCiphertext,
      installedAt: s.installedAt,
      lastVerifiedAt: s.lastVerifiedAt,
      lastVerifiedOrigin: s.lastVerifiedOrigin,
      previousKeyExpiresAt: s.previousKeyExpiresAt,
      archivedAt: s.archivedAt,
      version: s.version,
      createdAt: s.createdAt,
    };
  }

  async list(auth: AuthContext) {
    const rows = await this.db.read(auth.tenantId, (tx) => tx.site.findMany({ where: { tenantId: auth.tenantId, archivedAt: null }, include: { origins: true }, orderBy: { createdAt: 'asc' } }));
    return rows.map((s) => this.resource(s));
  }

  async get(auth: AuthContext, id: string) {
    const s = await this.db.read(auth.tenantId, (tx) => tx.site.findFirst({ where: { tenantId: auth.tenantId, id }, include: { origins: true } }));
    if (!s) throw notFound('Site');
    return this.resource(s);
  }

  private validateOrigins(origins: Array<{ origin: string; patternType: 'exact' | 'subdomain' }>) {
    const errors: Record<string, string[]> = {};
    const out: Array<{ origin: string; patternType: 'exact' | 'subdomain' }> = [];
    origins.forEach((o, i) => {
      const err = validateOriginRule(o.origin, o.patternType);
      if (err) errors[`origins.${i}.origin`] = [err];
      else out.push({ origin: normalizeOrigin(o.origin)!, patternType: o.patternType });
    });
    if (Object.keys(errors).length) throw badRequest('Fix the highlighted origins', errors);
    return out;
  }

  async create(auth: AuthContext, input: { name: string; origins: Array<{ origin: string; patternType: 'exact' | 'subdomain' }>; defaultDepartmentId?: string | null }) {
    const origins = this.validateOrigins(input.origins);
    const s = await this.db.tx(auth.tenantId, async (tx) => {
      if (input.defaultDepartmentId && !(await tx.department.findFirst({ where: { tenantId: auth.tenantId, id: input.defaultDepartmentId, archivedAt: null } }))) throw notFound('Department');
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
      const site = await tx.site.create({ data: { tenantId: auth.tenantId, name: input.name, publicKey: newSiteKey(), defaultDepartmentId: input.defaultDepartmentId ?? null } });
      if (origins.length) await tx.siteOrigin.createMany({ data: origins.map((o) => ({ tenantId: auth.tenantId, siteId: site.id, origin: o.origin, patternType: o.patternType })) });
      const config: WidgetConfig = { ...DEFAULT_WIDGET_CONFIG, appearance: { ...DEFAULT_WIDGET_CONFIG.appearance, companyName: tenant.name, primaryColor: '#07778A' } };
      await tx.widgetConfigRevision.create({ data: { tenantId: auth.tenantId, siteId: site.id, revision: 1, config: config as unknown as Prisma.InputJsonValue, configHash: hashConfig(config), publishedAt: new Date(), createdBy: auth.membershipId } });
      await tx.site.update({ where: { id: site.id }, data: { configRevision: 1 } });
      await this.audit.inTx(tx, auth, { action: 'site.created', objectType: 'site', objectId: site.id, safeDiff: { origins: origins.map((o) => o.origin) } });
      return tx.site.findUniqueOrThrow({ where: { id: site.id }, include: { origins: true } });
    });
    this.broadcaster.schedule(auth.tenantId);
    return this.resource(s);
  }

  async update(auth: AuthContext, id: string, input: { name?: string; enabled?: boolean; defaultDepartmentId?: string | null; scheduleId?: string | null; origins?: Array<{ origin: string; patternType: 'exact' | 'subdomain' }>; expectedVersion?: number }) {
    const origins = input.origins ? this.validateOrigins(input.origins) : null;
    const s = await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'sites', auth.tenantId, id);
      const site = await tx.site.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!site) throw notFound('Site');
      if (input.expectedVersion && input.expectedVersion !== site.version) throw conflict('VERSION_CONFLICT', 'This site was changed by someone else. Reload to continue.');
      if (input.scheduleId && !(await tx.schedule.findFirst({ where: { tenantId: auth.tenantId, id: input.scheduleId } }))) throw notFound('Schedule');
      await tx.site.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.defaultDepartmentId !== undefined ? { defaultDepartmentId: input.defaultDepartmentId } : {}),
          ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
          version: { increment: 1 },
        },
      });
      if (origins) {
        await tx.siteOrigin.deleteMany({ where: { tenantId: auth.tenantId, siteId: id } });
        if (origins.length) await tx.siteOrigin.createMany({ data: origins.map((o) => ({ tenantId: auth.tenantId, siteId: id, origin: o.origin, patternType: o.patternType })) });
      }
      await this.audit.inTx(tx, auth, { action: origins ? 'site.origins_updated' : 'site.updated', objectType: 'site', objectId: id, safeDiff: { ...input, origins: origins?.map((o) => o.origin) } });
      return tx.site.findUniqueOrThrow({ where: { id }, include: { origins: true } });
    });
    if (input.enabled === false) this.realtime.revoke(VISITOR_NS, controlRooms.site(auth.tenantId, id), 'site_disabled');
    this.broadcaster.schedule(auth.tenantId);
    return this.resource(s);
  }

  /** New public key; the old key keeps working for `overlapSeconds` (ch. 08). */
  async rotateKey(auth: AuthContext, id: string, overlapSeconds: number) {
    const s = await this.db.tx(auth.tenantId, async (tx) => {
      const site = await tx.site.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!site) throw notFound('Site');
      const u = await tx.site.update({
        where: { id },
        data: { previousPublicKey: site.publicKey, previousKeyExpiresAt: new Date(Date.now() + overlapSeconds * 1000), publicKey: newSiteKey(), version: { increment: 1 } },
        include: { origins: true },
      });
      await this.audit.inTx(tx, auth, { action: 'site.key_rotated', objectType: 'site', objectId: id, safeDiff: { overlap_seconds: overlapSeconds } });
      return u;
    });
    return { ...this.resource(s), snippet: installSnippet(s.publicKey) };
  }

  async archive(auth: AuthContext, id: string) {
    await this.db.tx(auth.tenantId, async (tx) => {
      const r = await tx.site.updateMany({ where: { tenantId: auth.tenantId, id, archivedAt: null }, data: { archivedAt: new Date(), enabled: false } });
      if (!r.count) throw notFound('Site');
      await this.audit.inTx(tx, auth, { action: 'site.archived', objectType: 'site', objectId: id });
    });
    this.realtime.revoke(VISITOR_NS, controlRooms.site(auth.tenantId, id), 'site_archived');
    return { ok: true };
  }

  async widgetConfig(auth: AuthContext, id: string) {
    return this.db.read(auth.tenantId, async (tx) => {
      const site = await tx.site.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!site) throw notFound('Site');
      const latest = await tx.widgetConfigRevision.findFirst({ where: { tenantId: auth.tenantId, siteId: id }, orderBy: { revision: 'desc' } });
      const published = await tx.widgetConfigRevision.findFirst({ where: { tenantId: auth.tenantId, siteId: id, publishedAt: { not: null } }, orderBy: { revision: 'desc' } });
      return {
        draft: latest && !latest.publishedAt ? { revision: latest.revision, config: mergeWidgetConfig(latest.config), etag: latest.configHash, createdAt: latest.createdAt } : null,
        published: published ? { revision: published.revision, config: mergeWidgetConfig(published.config), etag: published.configHash, publishedAt: published.publishedAt } : null,
      };
    });
  }

  /**
   * Save the single unpublished draft. `baseEtag` is the draft etag the editor loaded
   * (`null` = it started from the published config, i.e. expects no draft); a mismatch is
   * VERSION_CONFLICT instead of silently replacing a teammate's draft. Omitted = no check.
   */
  async saveDraft(auth: AuthContext, id: string, config: unknown, baseEtag?: string | null) {
    const parsed = widgetConfigSchema.safeParse(config);
    if (!parsed.success) throw zodError(parsed.error);
    const cfg = parsed.data as WidgetConfig;
    return this.db.tx(auth.tenantId, async (tx) => {
      const site = await tx.site.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!site) throw notFound('Site');
      await lockForUpdate(tx, 'sites', auth.tenantId, id);
      const latest = await tx.widgetConfigRevision.findFirst({ where: { tenantId: auth.tenantId, siteId: id }, orderBy: { revision: 'desc' } });
      if (baseEtag !== undefined) this.assertDraftEtag(latest, baseEtag);
      const row =
        latest && !latest.publishedAt
          ? await tx.widgetConfigRevision.update({ where: { id: latest.id }, data: { config: cfg as unknown as Prisma.InputJsonValue, configHash: hashConfig(cfg), createdBy: auth.membershipId } })
          : await tx.widgetConfigRevision.create({ data: { tenantId: auth.tenantId, siteId: id, revision: (latest?.revision ?? 0) + 1, config: cfg as unknown as Prisma.InputJsonValue, configHash: hashConfig(cfg), createdBy: auth.membershipId } });
      return { revision: row.revision, config: cfg, etag: row.configHash };
    });
  }

  /** Delete the unpublished draft so the editor falls back to the published config. */
  async discardDraft(auth: AuthContext, id: string, etag?: string) {
    return this.db.tx(auth.tenantId, async (tx) => {
      const site = await tx.site.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!site) throw notFound('Site');
      await lockForUpdate(tx, 'sites', auth.tenantId, id);
      const latest = await tx.widgetConfigRevision.findFirst({ where: { tenantId: auth.tenantId, siteId: id }, orderBy: { revision: 'desc' } });
      if (!latest || latest.publishedAt) return { discarded: false, revision: null };
      if (etag !== undefined) this.assertDraftEtag(latest, etag);
      await tx.widgetConfigRevision.delete({ where: { id: latest.id } });
      await this.audit.inTx(tx, auth, { action: 'widget.draft_discarded', objectType: 'site', objectId: id, safeDiff: { revision: latest.revision } });
      return { discarded: true, revision: latest.revision };
    });
  }

  private assertDraftEtag(latest: { publishedAt: Date | null; configHash: string; revision: number } | null, expected: string | null) {
    const current = latest && !latest.publishedAt ? latest : null;
    if ((current?.configHash ?? null) === expected) return;
    throw conflict(
      'VERSION_CONFLICT',
      current ? `A teammate changed draft revision ${current.revision} after you loaded it. Reload to review it.` : 'The draft you were editing was published or discarded by a teammate. Reload to continue.',
      false,
      { currentDraftRevision: current?.revision ?? null, currentEtag: current?.configHash ?? null },
    );
  }

  /** Publish an immutable snapshot; embedded widgets refetch on `config.published`. */
  async publish(auth: AuthContext, id: string, revision: number, etag?: string) {
    const out = await this.db.tx(auth.tenantId, async (tx) => {
      const site = await tx.site.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!site) throw notFound('Site');
      await lockForUpdate(tx, 'sites', auth.tenantId, id);
      const row = await tx.widgetConfigRevision.findUnique({ where: { tenantId_siteId_revision: { tenantId: auth.tenantId, siteId: id, revision } } });
      if (!row) throw notFound('Revision');
      if (etag !== undefined && !row.publishedAt && row.configHash !== etag)
        throw conflict('VERSION_CONFLICT', `A teammate changed draft revision ${revision} after you loaded it. Reload to review it before publishing.`);
      const newest = await tx.widgetConfigRevision.findFirst({ where: { tenantId: auth.tenantId, siteId: id }, orderBy: { revision: 'desc' } });
      if (newest && newest.revision !== revision) throw conflict('VERSION_CONFLICT', 'A newer draft exists. Reload before publishing.');
      if (row.publishedAt) return { revision, alreadyPublished: true };
      await tx.widgetConfigRevision.update({ where: { id: row.id }, data: { publishedAt: new Date() } });
      await tx.site.update({ where: { id }, data: { configRevision: revision, version: { increment: 1 } } });
      await this.outbox.append(tx, auth.tenantId, {
        aggregateType: 'site',
        aggregateId: id,
        aggregateVersion: revision,
        eventType: 'config.published',
        payload: { siteId: id, configVersion: revision, etag: row.configHash },
        scopes: [
          { kind: 'config', id, audience: 'public' },
          { kind: 'config', id, audience: 'staff' },
        ],
      });
      await this.audit.inTx(tx, auth, { action: 'widget.published', objectType: 'site', objectId: id, safeDiff: { revision } });
      return { revision, alreadyPublished: false };
    });
    return out;
  }

  async installation(auth: AuthContext, id: string) {
    const s = await this.get(auth, id);
    const recent = !!s.lastVerifiedAt && Date.now() - s.lastVerifiedAt.getTime() < 15 * 60_000;
    return {
      siteKey: s.publicKey,
      snippet: installSnippet(s.publicKey),
      loaderUrl: `${widgetBaseUrl()}/loader.js`,
      apiOrigin: new URL(env().API_URL).origin,
      installedAt: s.installedAt,
      lastVerifiedAt: s.lastVerifiedAt,
      lastVerifiedOrigin: s.lastVerifiedOrigin,
      status: recent ? 'verified' : s.installedAt ? 'seen_before' : 'not_detected',
      diagnostics: s.origins.length ? [] : ['Add at least one allowed origin so the widget can load on your site.'],
      csp: { scriptSrc: widgetBaseUrl(), frameSrc: new URL(env().API_URL).origin, connectSrc: new URL(env().API_URL).origin },
    };
  }

  async setIdentitySecret(auth: AuthContext, id: string, enable: boolean) {
    return this.db.tx(auth.tenantId, async (tx) => {
      const site = await tx.site.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!site) throw notFound('Site');
      const secret = enable ? `rdid_${randomToken(32)}` : null;
      await tx.site.update({ where: { id }, data: { identitySecretCiphertext: secret ? encrypt(secret) : null, identityKeyVersion: secret ? (site.identityKeyVersion ?? 0) + 1 : null } });
      await this.audit.inTx(tx, auth, { action: enable ? 'site.identity_secret_rotated' : 'site.identity_secret_removed', objectType: 'site', objectId: id });
      return { secret };
    });
  }

}

export function hashConfig(cfg: unknown): string {
  return createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 32);
}

