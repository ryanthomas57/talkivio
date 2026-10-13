import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { decrypt } from '../../common/crypto';
import { TenantDb } from '../../db/tenant-db';
import { PUBLIC_SYSTEM_EVENTS } from '../chats/chat.projections';
import { privacyConfig } from './config';
import { PrivacyObjectStore } from './object-store';

const MAX_MESSAGES = 50_000;
const MAX_PAGE_EVENTS = 20_000;

function safeDecrypt(v: string | null): string | null {
  if (!v) return null;
  try {
    return decrypt(v);
  } catch {
    return null;
  }
}

export interface AccessExportResult {
  objectKey: string;
  sizeBytes: number;
  sha256: string;
  counts: Record<string, number>;
}

/**
 * Subject access export (ch. 53): identities, sessions, chats (public messages plus
 * the subject's own messages), ratings, custom fields, consent records, offline
 * submissions and page events. Excludes other visitors' messages and staff internal
 * notes (unless TALKIVIO_ACCESS_EXPORT_INCLUDE_NOTES=true). Stored privately in the
 * `exports` area and served only to privacy administrators until it expires.
 */
@Injectable()
export class AccessExportService {
  constructor(
    private readonly db: TenantDb,
    private readonly objects: PrivacyObjectStore,
  ) {}

  async build(tenantId: string, visitorId: string, requestId: string): Promise<AccessExportResult> {
    const includeNotes = privacyConfig().accessExportIncludeNotes;
    const doc = await this.db.read(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
      const v = await tx.visitor.findFirstOrThrow({
        where: { tenantId, id: visitorId },
        include: { tags: true },
      });
      const tagRows = v.tags.length
        ? await tx.tag.findMany({
            where: { tenantId, id: { in: v.tags.map((t) => t.tagId) } },
            select: { label: true },
          })
        : [];
      const identities = await tx.visitorIdentity.findMany({
        where: { tenantId, visitorId },
        select: { issuerId: true, verificationMethod: true, linkedAt: true },
      });
      const sessions = await tx.visitorSession.findMany({
        where: { tenantId, visitorId },
        orderBy: { startedAt: 'asc' },
      });
      const sessionIds = sessions.map((s) => s.id);
      const pageEvents = sessionIds.length
        ? await tx.pageEvent.findMany({
            where: { tenantId, sessionId: { in: sessionIds } },
            orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
            take: MAX_PAGE_EVENTS,
          })
        : [];
      const consents = await tx.consentRecord.findMany({
        where: {
          tenantId,
          OR: [{ visitorId }, ...(sessionIds.length ? [{ sessionId: { in: sessionIds } }] : [])],
        },
        orderBy: { recordedAt: 'asc' },
      });
      const chats = await tx.chat.findMany({
        where: { tenantId, visitorId, isPreview: false },
        orderBy: { requestedAt: 'asc' },
        include: { rating: true },
      });
      const chatIds = chats.map((c) => c.id);
      const messages = await tx.message.findMany({
        where: {
          tenantId,
          OR: [{ chatId: { in: chatIds } }, { senderVisitorId: visitorId }],
        },
        orderBy: [{ chatId: 'asc' }, { seq: 'asc' }],
        take: MAX_MESSAGES,
        include: {
          attachments: {
            include: {
              attachment: {
                select: {
                  originalName: true,
                  detectedMime: true,
                  declaredMime: true,
                  sizeBytes: true,
                  state: true,
                },
              },
            },
          },
        },
      });
      const offline = await tx.offlineSubmission.findMany({
        where: {
          tenantId,
          OR: [{ visitorId }, ...(v.emailLookupHash ? [{ emailLookupHash: v.emailLookupHash }] : [])],
          status: { not: 'erased' },
        },
        orderBy: { createdAt: 'asc' },
      });
      const visible = (m: (typeof messages)[number]) => {
        if (m.redactedAt) return false;
        if (m.senderType === 'visitor') return m.senderVisitorId === visitorId; // never another visitor's words
        if (m.visibility === 'internal') return includeNotes;
        if (m.type === 'system')
          return PUBLIC_SYSTEM_EVENTS.has((m.systemEvent as { kind?: string } | null)?.kind ?? '');
        return true;
      };
      const msgOut = (m: (typeof messages)[number]) => ({
        seq: Number(m.seq),
        sent_at: m.sentAt.toISOString(),
        sender: m.senderType === 'visitor' ? 'you' : m.senderType,
        sender_name: m.senderType === 'visitor' ? null : m.senderNameSnapshot,
        visibility: m.visibility,
        body: m.body,
        attachments: m.attachments.map((a) => ({
          name: a.attachment.originalName,
          mime: a.attachment.detectedMime ?? a.attachment.declaredMime,
          size_bytes: Number(a.attachment.sizeBytes),
          state: a.attachment.state,
        })),
      });
      const owned = new Set(chatIds);
      return {
        format: 'talkivio.subject-access.v1',
        generated_at: new Date().toISOString(),
        request_id: requestId,
        controller: { tenant_id: tenantId, name: tenant.name },
        notes: [
          'This export contains the personal data Talkivio holds about the subject in this workspace.',
          'Messages written by other visitors are excluded.',
          includeNotes
            ? 'Staff internal notes are included by workspace policy.'
            : 'Staff internal notes are excluded by workspace policy.',
        ],
        subject: {
          visitor_id: v.id,
          display_name: v.name ?? v.anonymousLabel,
          name: v.name,
          email: safeDecrypt(v.emailCiphertext),
          phone: safeDecrypt(v.phoneCiphertext),
          verified: v.verified,
          custom_fields: v.customFields,
          tags: tagRows.map((t) => t.label),
          location: { country: v.countryCode, region: v.region, city: v.city },
          device: {
            browser: v.browser,
            os: v.os,
            category: v.deviceCategory,
            language: v.language,
            timezone: v.timezone,
          },
          visit_count: v.visitCount,
          chat_count: v.chatCount,
          first_seen_at: v.firstSeenAt.toISOString(),
          last_seen_at: v.lastSeenAt.toISOString(),
        },
        identities: identities.map((i) => ({
          issuer_site_id: i.issuerId,
          verification_method: i.verificationMethod,
          linked_at: i.linkedAt.toISOString(),
        })),
        sessions: sessions.map((s) => ({
          id: s.id,
          site_id: s.siteId,
          started_at: s.startedAt.toISOString(),
          last_seen_at: s.lastSeenAt.toISOString(),
          ended_at: s.endedAt?.toISOString() ?? null,
          landing_url: s.landingUrl,
          last_url: s.currentUrl,
          last_title: s.currentTitle,
          referrer_origin: s.referrerOrigin,
          utm: s.utm,
          analytics_consent: s.analyticsConsent,
          device: { browser: s.browser, os: s.os, category: s.deviceCategory },
          location: { country: s.country, city: s.city },
        })),
        page_events: pageEvents.map((p) => ({
          session_id: p.sessionId,
          kind: p.kind,
          url: p.sanitizedUrl,
          title: p.title,
          received_at: p.receivedAt.toISOString(),
        })),
        consent_records: consents.map((c) => ({
          purpose: c.purpose,
          state: c.state,
          policy_version: c.policyVersion,
          source: c.source,
          recorded_at: c.recordedAt.toISOString(),
        })),
        chats: chats.map((c) => ({
          id: c.id,
          number: c.number,
          site_id: c.siteId,
          status: c.status,
          requested_at: c.requestedAt.toISOString(),
          closed_at: c.closedAt?.toISOString() ?? null,
          page_url: c.pageUrl,
          rating: c.rating
            ? {
                rating: c.rating.rating,
                comment: c.rating.comment,
                submitted_at: c.rating.submittedAt.toISOString(),
              }
            : null,
          messages: messages.filter((m) => m.chatId === c.id && visible(m)).map(msgOut),
        })),
        messages_in_other_chats: messages
          .filter((m) => !owned.has(m.chatId) && m.senderVisitorId === visitorId && !m.redactedAt)
          .map((m) => ({ chat_id: m.chatId, ...msgOut(m) })),
        offline_submissions: offline.map((o) => ({
          reference: o.reference,
          submitted_at: o.createdAt.toISOString(),
          name: o.name,
          email: safeDecrypt(o.emailCiphertext),
          message: o.message,
          custom_fields: o.customFields,
          status: o.status,
        })),
        truncated: {
          messages: messages.length >= MAX_MESSAGES,
          page_events: pageEvents.length >= MAX_PAGE_EVENTS,
        },
      };
    });
    const body = Buffer.from(JSON.stringify(doc, null, 2));
    const objectKey = `privacy/${tenantId}/${requestId}/${randomBytes(12).toString('hex')}.json`;
    await this.objects.write('exports', objectKey, body, 'application/json');
    return {
      objectKey,
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      counts: {
        identities: doc.identities.length,
        sessions: doc.sessions.length,
        page_events: doc.page_events.length,
        consent_records: doc.consent_records.length,
        chats: doc.chats.length,
        messages: doc.chats.reduce((n, c) => n + c.messages.length, 0) + doc.messages_in_other_chats.length,
        offline_submissions: doc.offline_submissions.length,
      },
    };
  }
}
