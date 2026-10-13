import { lockForUpdate } from '../../db/row-lock';
import { Injectable } from '@nestjs/common';
import type { Prisma, Visitor } from '@prisma/client';
import { mergeOrgSettings } from '@talkivio/contracts';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AuditService } from '../../common/audit.service';
import { decrypt, encrypt, sha256, emailLookupHash } from '../../common/crypto';
import { badRequest, conflict, denied, notFound, type AuthContext } from '../../common/http';
import { decodeCursor, encodeCursor, page } from '../../common/wire';
import { PresenceService } from '../../core/presence.service';
import { staffChat, staffChatInclude, type TagRef } from '../chats/chat.projections';
import { ChatQueriesService } from '../chats/chat-queries.service';
import { CustomFieldsService, trackSources } from './custom-fields.service';
import { buildSessionTimeline, exclusiveVisibleMs, type TimelineEvent } from './page-timeline';
import { PresenceReader } from './presence-reader';
import { displayNameOf, EMAIL_RE, likePattern, normalizeEmail, pageLimit, staleVersion } from './visitor-common';
import { VisitorMonitorService } from './visitor-monitor.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGES_PER_SESSION = 200;

export interface VisitorTagRef extends TagRef {
  source: string;
}

function safeDecrypt(c: string | null): string | null {
  if (!c) return null;
  try {
    return decrypt(c);
  } catch {
    return null;
  }
}

/**
 * Visitor records (ch. 17/43): profile with verified vs unverified fields,
 * staff edits (always unverified; identity proof kept in visitor_identities),
 * session timelines, scoped chat history, tags and merge requests.
 */
@Injectable()
export class VisitorRecordsService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly presence: PresenceService,
    private readonly reader: PresenceReader,
    private readonly fields: CustomFieldsService,
    private readonly monitor: VisitorMonitorService,
    private readonly queries: ChatQueriesService,
  ) {}

  private async findVisitor(tx: Tx, tenantId: string, id: string): Promise<Visitor> {
    const v = await tx.visitor.findFirst({ where: { tenantId, id } });
    if (!v) throw notFound('Visitor');
    return v;
  }

  private async tagsFor(tx: Tx, tenantId: string, visitorIds: string[]): Promise<Map<string, VisitorTagRef[]>> {
    const out = new Map<string, VisitorTagRef[]>();
    if (!visitorIds.length) return out;
    const rows = await tx.visitorTag.findMany({ where: { tenantId, visitorId: { in: visitorIds } }, select: { visitorId: true, tagId: true, source: true }, orderBy: { createdAt: 'asc' } });
    const tags = rows.length ? await tx.tag.findMany({ where: { tenantId, id: { in: [...new Set(rows.map((r) => r.tagId))] }, archivedAt: null }, select: { id: true, slug: true, label: true } }) : [];
    const byId = new Map(tags.map((t) => [t.id, t]));
    for (const r of rows) {
      const t = byId.get(r.tagId);
      if (t) out.set(r.visitorId, [...(out.get(r.visitorId) ?? []), { ...t, source: r.source }]);
    }
    return out;
  }

  // ───────── Profile ─────────

  private async profile(tx: Tx, tenantId: string, v: Visitor) {
    const [identities, tags, sessionStats, settingsRow] = await Promise.all([
      tx.visitorIdentity.findMany({ where: { tenantId, visitorId: v.id }, select: { issuerId: true, verificationMethod: true, linkedAt: true }, orderBy: { linkedAt: 'asc' } }),
      this.tagsFor(tx, tenantId, [v.id]),
      tx.$queryRaw<Array<{ total: bigint; open: bigint; last: Date | null }>>`
        SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE ended_at IS NULL)::bigint AS open, MAX(started_at) AS last
        FROM visitor_sessions WHERE tenant_id = ${tenantId}::uuid AND visitor_id = ${v.id}::uuid`,
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } }),
    ]);
    const settings = mergeOrgSettings(settingsRow.settings);
    const erased = !!v.erasedAt;
    const name = erased ? null : v.name;
    const email = erased ? null : safeDecrypt(v.emailCiphertext);
    const phone = erased ? null : safeDecrypt(v.phoneCiphertext);
    const online = await this.presence.isVisitorOnline(tenantId, v.id);
    return {
      id: v.id,
      siteId: v.siteId,
      displayName: erased ? v.anonymousLabel : displayNameOf(v),
      anonymousLabel: v.anonymousLabel,
      verified: v.verified,
      identityVerified: identities.length > 0,
      identities: identities.map((i) => ({ issuerSiteId: i.issuerId, verificationMethod: i.verificationMethod, linkedAt: i.linkedAt })),
      fields: {
        name: { value: name, verified: !!name && v.verified },
        email: { value: email, verified: !!email && v.verified },
        phone: { value: phone, verified: false },
      },
      allowedContactFields: ['name', 'email', 'phone'],
      tags: tags.get(v.id) ?? [],
      customFields: erased ? {} : ((v.customFields ?? {}) as Record<string, unknown>),
      /** Who set each value: visitor (the site's page, unverified), agent (membership id) or trigger (trigger id). */
      customFieldSources: erased ? {} : ((v.customFieldSources ?? {}) as Record<string, unknown>),
      firstSeenAt: v.firstSeenAt,
      lastSeenAt: v.lastSeenAt,
      visitCount: v.visitCount,
      chatCount: v.chatCount,
      location: settings.tracking.locationEnabled && !erased ? { countryCode: v.countryCode, region: v.region, city: v.city, approximate: true } : null,
      device: { category: v.deviceCategory, browser: v.browser, os: v.os },
      language: v.language,
      timezone: v.timezone,
      online,
      sessionSummary: {
        total: Number(sessionStats[0]?.total ?? 0),
        open: Number(sessionStats[0]?.open ?? 0),
        lastStartedAt: sessionStats[0]?.last ?? null,
      },
      erased,
      version: v.version,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    };
  }

  async get(auth: AuthContext, id: string) {
    return this.db.read(auth.tenantId, async (tx) => this.profile(tx, auth.tenantId, await this.findVisitor(tx, auth.tenantId, id)));
  }

  async update(auth: AuthContext, id: string, expectedVersion: number, input: { displayName?: string | null; email?: string | null; customFields?: Record<string, unknown> }) {
    const result = await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'visitors', auth.tenantId, id);
      const v = await this.findVisitor(tx, auth.tenantId, id);
      if (v.erasedAt) throw conflict('CONFLICT', 'This visitor was erased and can no longer be edited');
      if (v.version !== expectedVersion) throw staleVersion();
      const data: Prisma.VisitorUpdateManyMutationInput = {};
      const changed: string[] = [];
      let identityChanged = false;
      if (input.displayName !== undefined) {
        const name = input.displayName?.trim() || null;
        if (name !== v.name) {
          data.name = name;
          changed.push('display_name');
          identityChanged = true;
        }
      }
      if (input.email !== undefined) {
        const email = normalizeEmail(input.email);
        if (email && !EMAIL_RE.test(email)) throw badRequest('Enter a valid email address', { email: ['Enter a valid email address.'] });
        const current = safeDecrypt(v.emailCiphertext);
        if (email !== current) {
          data.emailCiphertext = email ? encrypt(email) : null;
          data.emailLookupHash = email ? emailLookupHash(email) : null;
          changed.push('email');
          identityChanged = true;
        }
      }
      // Manually entered identity is never verified; proof stays in visitor_identities.
      if (identityChanged) data.verified = false;
      if (input.customFields !== undefined) {
        const { next, changedKeys } = await this.fields.applyPatch(tx, auth.tenantId, v.customFields, input.customFields, { publicOnly: false });
        if (changedKeys.length) {
          data.customFields = next as Prisma.InputJsonValue;
          data.customFieldSources = trackSources(v.customFieldSources, changedKeys, next, 'agent', auth.membershipId) as unknown as Prisma.InputJsonValue;
          changed.push(...changedKeys.map((k) => `custom_fields.${k}`));
        }
      }
      if (changed.length) {
        const r = await tx.visitor.updateMany({ where: { tenantId: auth.tenantId, id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
        if (!r.count) throw staleVersion();
        await this.audit.inTx(tx, auth, { action: 'visitor.updated', objectType: 'visitor', objectId: id, safeDiff: { changed, verified_cleared: identityChanged && v.verified } });
      }
      return { profile: await this.profile(tx, auth.tenantId, await this.findVisitor(tx, auth.tenantId, id)), changed: changed.length > 0 };
    });
    if (result.changed) await this.monitor.markDirty(auth.tenantId, [id]);
    return result.profile;
  }

  // ───────── Contacts list ─────────

  async list(auth: AuthContext, q: { q?: string; identified?: boolean; tag?: string; siteId?: string; cursor?: string; limit?: number }) {
    const limit = pageLimit(q.limit);
    const filterHash = sha256(JSON.stringify({ q: q.q ?? null, i: q.identified ?? null, t: q.tag ?? null, s: q.siteId ?? null })).slice(0, 16);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur) throw badRequest('This cursor does not match the current filters', { cursor: ['Invalid cursor'] });
    return this.db.read(auth.tenantId, async (tx) => {
      const and: Prisma.VisitorWhereInput[] = [{ tenantId: auth.tenantId, erasedAt: null }];
      if (q.siteId) and.push({ siteId: q.siteId });
      if (q.identified === true) and.push({ OR: [{ name: { not: null } }, { emailCiphertext: { not: null } }, { verified: true }] });
      if (q.identified === false) and.push({ name: null, emailCiphertext: null, verified: false });
      if (q.tag) {
        const tag = await tx.tag.findFirst({ where: { tenantId: auth.tenantId, ...(UUID_RE.test(q.tag) ? { id: q.tag } : { slug: q.tag.toLowerCase() }) }, select: { id: true } });
        if (!tag) return page([], null);
        and.push({ tags: { some: { tagId: tag.id } } });
      }
      if (q.q?.trim()) {
        const term = q.q.trim().slice(0, 100);
        const email = normalizeEmail(term);
        if (email && EMAIL_RE.test(email)) {
          // Exact email search through the lookup hash (no plaintext scan).
          and.push({ emailLookupHash: emailLookupHash(email) });
        } else {
          const rows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM visitors WHERE tenant_id = ${auth.tenantId}::uuid AND erased_at IS NULL
              AND (name ILIKE ${likePattern(term)} ESCAPE '\\' OR anonymous_label ILIKE ${likePattern(term)} ESCAPE '\\')
            ORDER BY last_seen_at DESC, id DESC LIMIT 2000`;
          and.push({ id: { in: rows.map((r) => r.id) } });
        }
      }
      if (cur) and.push({ OR: [{ lastSeenAt: { lt: new Date(cur.t) } }, { lastSeenAt: new Date(cur.t), id: { lt: cur.id } }] });
      const rows = await tx.visitor.findMany({ where: { AND: and }, orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
      const slice = rows.slice(0, limit);
      const ids = slice.map((v) => v.id);
      const [tags, identities] = await Promise.all([
        this.tagsFor(tx, auth.tenantId, ids),
        ids.length ? tx.visitorIdentity.findMany({ where: { tenantId: auth.tenantId, visitorId: { in: ids } }, select: { visitorId: true }, distinct: ['visitorId'] }) : Promise.resolve([]),
      ]);
      const online = await this.presence.onlineVisitorIds(auth.tenantId, ids);
      const verifiedIds = new Set(identities.map((i) => i.visitorId));
      const last = slice[slice.length - 1];
      return page(
        slice.map((v) => ({
          id: v.id,
          siteId: v.siteId,
          displayName: displayNameOf(v),
          anonymousLabel: v.anonymousLabel,
          verified: v.verified,
          identityVerified: verifiedIds.has(v.id),
          email: safeDecrypt(v.emailCiphertext),
          tags: tags.get(v.id) ?? [],
          firstSeenAt: v.firstSeenAt,
          lastSeenAt: v.lastSeenAt,
          visitCount: v.visitCount,
          chatCount: v.chatCount,
          countryCode: v.countryCode,
          online: online.has(v.id),
        })),
        rows.length > limit && last ? encodeCursor({ t: last.lastSeenAt.toISOString(), id: last.id }, filterHash) : null,
      );
    });
  }

  // ───────── Sessions timeline ─────────

  async sessions(auth: AuthContext, id: string, q: { cursor?: string; limit?: number }) {
    const limit = pageLimit(q.limit, 20, 50);
    const filterHash = sha256(`sessions:${id}`).slice(0, 16);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur) throw badRequest('Invalid cursor', { cursor: ['Invalid cursor'] });
    const now = Date.now();
    const presence = (await this.reader.read(auth.tenantId, [id])).get(id);
    const liveSessions = new Set(this.reader.isOnline(presence) ? presence!.connections.map((c) => c.sessionId) : []);
    return this.db.read(auth.tenantId, async (tx) => {
      const v = await this.findVisitor(tx, auth.tenantId, id);
      const settings = mergeOrgSettings((await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { settings: true } })).settings);
      const and: Prisma.VisitorSessionWhereInput[] = [{ tenantId: auth.tenantId, visitorId: v.id }];
      if (cur) and.push({ OR: [{ startedAt: { lt: new Date(cur.t) } }, { startedAt: new Date(cur.t), id: { lt: cur.id } }] });
      const rows = await tx.visitorSession.findMany({ where: { AND: and }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
      const slice = rows.slice(0, limit);
      if (!slice.length) return page([], null);
      const endOf = (s: { id: string; endedAt: Date | null; lastSeenAt: Date }) => (liveSessions.has(s.id) && !s.endedAt ? now : (s.endedAt ?? s.lastSeenAt).getTime());
      const minStart = new Date(Math.min(...slice.map((s) => s.startedAt.getTime())));
      const maxEnd = new Date(Math.max(...slice.map(endOf)));
      // Concurrent sessions outside this page still count for cross-tab overlap.
      const neighbors = await tx.visitorSession.findMany({
        where: {
          tenantId: auth.tenantId,
          visitorId: v.id,
          id: { notIn: slice.map((s) => s.id) },
          startedAt: { lte: maxEnd },
          OR: [{ endedAt: null, lastSeenAt: { gte: minStart } }, { endedAt: { gte: minStart } }],
        },
        select: { id: true, startedAt: true, lastSeenAt: true, endedAt: true, analyticsConsent: true },
        take: 200,
      });
      const all = [...slice, ...neighbors];
      const events = await tx.pageEvent.findMany({
        where: { tenantId: auth.tenantId, sessionId: { in: all.map((s) => s.id) } },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        take: 20_000,
        select: { sessionId: true, kind: true, receivedAt: true, sanitizedUrl: true, title: true },
      });
      const bySession = new Map<string, TimelineEvent[]>();
      for (const e of events) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), { kind: e.kind, at: e.receivedAt.getTime(), url: e.sanitizedUrl, title: e.title }]);
      const timelines = new Map(all.map((s) => [s.id, buildSessionTimeline(bySession.get(s.id) ?? [], endOf(s))]));
      const exclusive = exclusiveVisibleMs(all.map((s) => ({ id: s.id, startedAt: s.startedAt.getTime(), intervals: timelines.get(s.id)!.intervals })));
      const last = slice[slice.length - 1];
      return page(
        slice.map((s) => {
          const granted = s.analyticsConsent === 'granted';
          const tl = timelines.get(s.id)!;
          const pages = granted ? tl.pages.slice(-MAX_PAGES_PER_SESSION) : [];
          return {
            id: s.id,
            siteId: s.siteId,
            startedAt: s.startedAt,
            lastSeenAt: s.lastSeenAt,
            endedAt: s.endedAt,
            live: liveSessions.has(s.id) && !s.endedAt,
            analyticsConsent: s.analyticsConsent,
            browsingHidden: !granted,
            device: { category: s.deviceCategory, browser: s.browser, os: s.os },
            country: granted && settings.tracking.locationEnabled ? s.country : null,
            referrerOrigin: granted ? s.referrerOrigin : null,
            landingUrl: granted ? s.landingUrl : null,
            pageViewCount: granted ? s.pageViewCount : null,
            pages: pages.map((p) => ({ url: p.url, title: p.title, enteredAt: new Date(p.enteredAt), leftAt: p.leftAt ? new Date(p.leftAt) : null, dwellMs: p.dwellMs })),
            pagesTruncated: granted && tl.pages.length > MAX_PAGES_PER_SESSION,
            visibleMs: granted ? tl.visibleMs : null,
            exclusiveVisibleMs: granted ? (exclusive.get(s.id) ?? 0) : null,
            isPreview: s.isPreview,
          };
        }),
        rows.length > limit && last ? encodeCursor({ t: last.startedAt.toISOString(), id: last.id }, filterHash) : null,
      );
    });
  }

  // ───────── Prior chats (department scoped) ─────────

  async chats(auth: AuthContext, id: string, q: { cursor?: string; limit?: number }) {
    if (!auth.permissions.has('history.view')) throw denied();
    const limit = pageLimit(q.limit, 20, 50);
    const filterHash = sha256(`chats:${id}`).slice(0, 16);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur) throw badRequest('Invalid cursor', { cursor: ['Invalid cursor'] });
    return this.db.read(auth.tenantId, async (tx) => {
      const v = await this.findVisitor(tx, auth.tenantId, id);
      const and: Prisma.ChatWhereInput[] = [{ tenantId: auth.tenantId, visitorId: v.id, isPreview: false }, this.queries.scopeWhere(auth)];
      if (cur) and.push({ OR: [{ requestedAt: { lt: new Date(cur.t) } }, { requestedAt: new Date(cur.t), id: { lt: cur.id } }] });
      const rows = await tx.chat.findMany({ where: { AND: and }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: limit + 1, include: staffChatInclude });
      const slice = rows.slice(0, limit);
      const tagIds = [...new Set(slice.flatMap((c) => c.tags.map((t) => t.tagId)))];
      const tags = tagIds.length ? await tx.tag.findMany({ where: { tenantId: auth.tenantId, id: { in: tagIds } }, select: { id: true, slug: true, label: true } }) : [];
      const tagById = new Map(tags.map((t) => [t.id, t]));
      const last = slice[slice.length - 1];
      return page(
        slice.map((c) => staffChat(c, v, c.tags.map((t) => tagById.get(t.tagId)).filter((t): t is TagRef => !!t))),
        rows.length > limit && last ? encodeCursor({ t: last.requestedAt.toISOString(), id: last.id }, filterHash) : null,
      );
    });
  }

  // ───────── Tags ─────────

  async setTags(auth: AuthContext, id: string, tagIds: string[]) {
    const unique = [...new Set(tagIds)];
    const out = await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'visitors', auth.tenantId, id);
      let version = (await this.findVisitor(tx, auth.tenantId, id)).version;
      const valid = unique.length ? await tx.tag.findMany({ where: { tenantId: auth.tenantId, id: { in: unique }, archivedAt: null }, select: { id: true } }) : [];
      if (valid.length !== unique.length) throw notFound('Tag');
      const before = await tx.visitorTag.findMany({ where: { tenantId: auth.tenantId, visitorId: id }, select: { tagId: true } });
      const removed = before.filter((b) => !unique.includes(b.tagId)).map((b) => b.tagId);
      const added = unique.filter((t) => !before.some((b) => b.tagId === t));
      if (removed.length) await tx.visitorTag.deleteMany({ where: { tenantId: auth.tenantId, visitorId: id, tagId: { in: removed } } });
      if (added.length) {
        await tx.visitorTag.createMany({ data: added.map((tagId) => ({ tenantId: auth.tenantId, visitorId: id, tagId, source: 'agent' as const, addedBy: auth.membershipId })), skipDuplicates: true });
      }
      if (removed.length || added.length) {
        version = (await tx.visitor.update({ where: { id }, data: { version: { increment: 1 } } })).version;
        await this.audit.inTx(tx, auth, { action: 'visitor.tags_set', objectType: 'visitor', objectId: id, safeDiff: { added, removed } });
      }
      return { tags: (await this.tagsFor(tx, auth.tenantId, [id])).get(id) ?? [], version };
    });
    await this.monitor.markDirty(auth.tenantId, [id]);
    // The new version keeps the profile's If-Match token current after a tag change.
    return { visitorId: id, tags: out.tags, version: out.version };
  }

  // ───────── Merge requests ─────────

  /**
   * Queue a reviewed association job. Never merges automatically and never on
   * email text alone: the target must carry verified identity proof and the
   * proof reference must not just be an email address.
   */
  async mergeRequest(auth: AuthContext, input: { sourceId: string; targetId: string; proofReference: string; reason: string }) {
    if (input.sourceId === input.targetId) throw badRequest('Choose two different visitors', { target_id: ['Must differ from source_id'] });
    const proof = input.proofReference.trim();
    if (EMAIL_RE.test(proof.toLowerCase())) throw badRequest('Matching email text is not identity proof', { proof_reference: ['Provide a verified identity proof reference, not an email address'] });
    return this.db.tx(auth.tenantId, async (tx) => {
      const [source, target] = await Promise.all([this.findVisitor(tx, auth.tenantId, input.sourceId), this.findVisitor(tx, auth.tenantId, input.targetId)]);
      if (source.erasedAt || target.erasedAt) throw conflict('CONFLICT', 'Erased visitors cannot be merged');
      const targetProof = await tx.visitorIdentity.count({ where: { tenantId: auth.tenantId, visitorId: target.id } });
      if (!targetProof) throw badRequest('The target visitor has no verified identity; merging requires verified identity proof', { target_id: ['Target must be identity-verified'] });
      const dedupeKey = `${source.id}:${target.id}`;
      const existing = await tx.job.findUnique({ where: { tenantId_kind_dedupeKey: { tenantId: auth.tenantId, kind: 'visitor_merge', dedupeKey } } });
      const job =
        existing && existing.state !== 'failed' && existing.state !== 'cancelled'
          ? existing
          : existing
            ? await tx.job.update({
                where: { id: existing.id },
                data: { state: 'queued', attempts: 0, lastErrorCode: null, requestedBy: auth.userId, payload: this.mergePayload(source.id, target.id, proof, input.reason, auth) },
              })
            : await tx.job.create({
                data: { tenantId: auth.tenantId, kind: 'visitor_merge', dedupeKey, state: 'queued', requestedBy: auth.userId, payload: this.mergePayload(source.id, target.id, proof, input.reason, auth) },
              });
      if (job !== existing) {
        await this.audit.inTx(tx, auth, { action: 'visitor.merge_requested', objectType: 'visitor', objectId: target.id, safeDiff: { source_id: source.id, target_id: target.id, job_id: job.id } });
      }
      const payload = job.payload as Record<string, unknown>;
      return {
        id: job.id,
        kind: job.kind,
        state: job.state,
        reviewState: (payload.reviewState as string) ?? 'pending_review',
        sourceId: source.id,
        targetId: target.id,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        errorCode: job.lastErrorCode,
      };
    });
  }

  private mergePayload(sourceId: string, targetId: string, proof: string, reason: string, auth: AuthContext): Prisma.InputJsonValue {
    return { sourceId, targetId, proofReference: proof.slice(0, 200), reason: reason.trim().slice(0, 500), reviewState: 'pending_review', requestedByMembershipId: auth.membershipId };
  }
}
