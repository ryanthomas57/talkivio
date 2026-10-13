import { Injectable } from '@nestjs/common';
import { mergeOrgSettings, type DslEvent } from '@talkivio/contracts';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AvailabilityService } from '../availability/availability.service';

/** Engine input for one DSL event (ids are resolved against the database, never trusted from clients). */
export interface DslEventContext {
  tenantId: string;
  event: DslEvent;
  eventId: string;
  siteId?: string | null;
  visitorId?: string | null;
  sessionId?: string | null;
  chatId?: string | null;
  departmentId?: string | null;
  messageText?: string | null;
  /** visitor.page.changed: the page this event entered (its snapshot describes that page, not a later one). */
  pageUrl?: string | null;
  causationId?: string | null;
}

export interface ResolvedContext {
  siteId: string | null;
  visitorId: string | null;
  sessionId: string | null;
  chatId: string | null;
  departmentId: string | null;
}

export type SnapshotValue = string | number | boolean | string[] | null;

export interface PageDwell {
  anchorId: string;
  enteredAt: Date;
  url: string;
  visibleMs: number;
  hidden: boolean;
  left: boolean;
}

const MAX_TEXT = 8000;
/** Snapshot fields that may hold personal text; redacted in stored run traces (ch. 36). */
export const REDACTED_FIELDS = new Set(['message.text']);

function pathOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url.startsWith('/') ? url.split(/[?#]/)[0] : null;
  }
}

function customType(dataType: string): 'string' | 'number' | 'boolean' {
  const t = dataType.toLowerCase();
  if (t === 'number' || t === 'integer' || t === 'decimal') return 'number';
  if (t === 'boolean' || t === 'bool' || t === 'checkbox') return 'boolean';
  return 'string';
}

/**
 * Builds the single immutable snapshot for one trigger event (ch. 33) from
 * authoritative server state: dwell and time on site come from server receive
 * times, availability from live presence + schedules, never from client values.
 */
@Injectable()
export class TriggerSnapshotService {
  constructor(
    private readonly db: TenantDb,
    private readonly availability: AvailabilityService,
  ) {}

  /** Latest page entry of a session and its visible dwell, from server-received page events. */
  async pageDwell(tx: Tx, tenantId: string, sessionId: string, now: number): Promise<PageDwell | null> {
    const anchor = await tx.pageEvent.findFirst({
      where: { tenantId, sessionId, kind: 'entered' },
      orderBy: [{ receivedAt: 'desc' }, { clientAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    });
    if (!anchor) return null;
    const after = await tx.pageEvent.findMany({
      where: { tenantId, sessionId, receivedAt: { gte: anchor.receivedAt }, kind: { in: ['hidden', 'visible', 'left'] }, id: { not: anchor.id } },
      orderBy: [{ receivedAt: 'asc' }, { clientAt: { sort: 'asc', nulls: 'first' } }],
      take: 500,
    });
    let visibleMs = 0;
    let visibleSince: number | null = anchor.receivedAt.getTime();
    let left = false;
    for (const e of after) {
      const at = e.receivedAt.getTime();
      if (e.kind === 'hidden' || e.kind === 'left') {
        if (visibleSince !== null) visibleMs += Math.max(0, at - visibleSince);
        visibleSince = null;
        if (e.kind === 'left') {
          left = true;
          break;
        }
      } else if (e.kind === 'visible' && visibleSince === null) {
        visibleSince = at;
      }
    }
    if (!left && visibleSince !== null) visibleMs += Math.max(0, now - visibleSince);
    return { anchorId: anchor.id, enteredAt: anchor.receivedAt, url: anchor.sanitizedUrl, visibleMs, hidden: visibleSince === null, left };
  }

  async build(c: DslEventContext, nowMs: number): Promise<{ snapshot: Record<string, SnapshotValue>; context: ResolvedContext; analyticsConsent: string | null }> {
    const tenantId = c.tenantId;
    return this.db.read(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const settings = mergeOrgSettings(tenant.settings);
      const chat = c.chatId ? await tx.chat.findFirst({ where: { tenantId, id: c.chatId } }) : null;
      const sessionId = c.sessionId ?? chat?.sessionId ?? null;
      const session = sessionId ? await tx.visitorSession.findFirst({ where: { tenantId, id: sessionId } }) : null;
      const visitorId = c.visitorId ?? chat?.visitorId ?? session?.visitorId ?? null;
      const visitor = visitorId ? await tx.visitor.findFirst({ where: { tenantId, id: visitorId, erasedAt: null } }) : null;
      const siteId = chat?.siteId ?? session?.siteId ?? visitor?.siteId ?? c.siteId ?? null;
      const site = siteId ? await tx.site.findFirst({ where: { tenantId, id: siteId } }) : null;
      const departmentId = chat ? chat.departmentId : (c.departmentId ?? site?.defaultDepartmentId ?? null);

      const s: Record<string, SnapshotValue> = {};
      s['site.id'] = siteId;
      s['department.id'] = departmentId;
      if (visitor) {
        s['visitor.verified'] = visitor.verified;
        s['visitor.returning'] = visitor.visitCount > 1;
        const tagRows = await tx.visitorTag.findMany({ where: { tenantId, visitorId: visitor.id }, select: { tagId: true }, take: 200 });
        const tags = tagRows.length ? await tx.tag.findMany({ where: { tenantId, id: { in: tagRows.map((t) => t.tagId) }, archivedAt: null }, select: { slug: true } }) : [];
        s['visitor.tags'] = tags.map((t) => t.slug).sort();
        // Country only when location collection is permitted (ch. 26/32).
        const country = settings.tracking.locationEnabled ? (session?.country ?? visitor.countryCode ?? null) : null;
        s['visitor.country'] = country ? country.toUpperCase() : null;
        const defs = await tx.customFieldDefinition.findMany({ where: { tenantId, archivedAt: null, publicWritable: false } });
        const values = (visitor.customFields ?? {}) as Record<string, unknown>;
        for (const d of defs) {
          const v = values[d.key];
          if (v === undefined || v === null) continue;
          const type = customType(d.dataType);
          if ((type === 'number' && typeof v === 'number' && Number.isFinite(v)) || (type === 'boolean' && typeof v === 'boolean')) s[`custom.${d.key}`] = v;
          else if (type === 'string' && (typeof v === 'string' || typeof v === 'number')) s[`custom.${d.key}`] = String(v).slice(0, MAX_TEXT);
        }
      }
      if (session) {
        const consent = session.analyticsConsent === 'granted';
        s['session.time_on_site_seconds'] = Math.max(0, Math.floor((nowMs - session.startedAt.getTime()) / 1000));
        s['referrer.origin'] = consent ? session.referrerOrigin : null;
        if (consent) {
          const dwell = await this.pageDwell(tx, tenantId, session.id, nowMs);
          // A page.changed event is evaluated on the page it entered, even when it is processed after a later one.
          const later = !!c.pageUrl && dwell?.url !== c.pageUrl;
          s['page.path'] = pathOf(c.pageUrl ?? dwell?.url ?? session.currentUrl);
          s['page.visible_dwell_seconds'] = later ? 0 : dwell && !dwell.left ? Math.floor(dwell.visibleMs / 1000) : null;
        }
      }
      if (chat) {
        s['chat.status'] = chat.status;
        const until = chat.firstAssignedAt ?? chat.closedAt ?? new Date(nowMs);
        s['chat.wait_seconds'] = Math.max(0, Math.floor((until.getTime() - chat.requestedAt.getTime()) / 1000));
        if (!s['page.path'] && chat.pageUrl && session?.analyticsConsent === 'granted') s['page.path'] = pathOf(chat.pageUrl);
      }
      if (c.messageText !== undefined) s['message.text'] = c.messageText ? c.messageText.slice(0, MAX_TEXT) : null;

      if (siteId) {
        const avail = await this.availability.compute(tx, tenantId, siteId, new Date(nowMs));
        const scope = departmentId ? (avail.departments.find((d) => d.id === departmentId) ?? null) : avail;
        if (scope) {
          s['schedule.is_open'] = scope.reason !== 'closed_hours' && scope.reason !== 'emergency_closure';
          s['eligible_agent_count'] = scope.eligibleAgentCount;
        } else {
          s['schedule.is_open'] = false;
          s['eligible_agent_count'] = 0;
        }
      }
      for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
      return {
        snapshot: s,
        context: { siteId, visitorId: visitor?.id ?? visitorId, sessionId: session?.id ?? sessionId, chatId: chat?.id ?? null, departmentId },
        analyticsConsent: session?.analyticsConsent ?? null,
      };
    });
  }
}

/** Compact, privacy-safe copy of a snapshot for trigger_runs (personal free text redacted). */
export function redactSnapshot(s: Record<string, SnapshotValue>): Record<string, SnapshotValue> {
  const out: Record<string, SnapshotValue> = {};
  for (const [k, v] of Object.entries(s)) out[k] = (REDACTED_FIELDS.has(k) || k.startsWith('custom.')) && v !== null ? '[redacted]' : v;
  return out;
}
