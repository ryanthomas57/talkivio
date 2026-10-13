import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TenantDb } from '../../db/tenant-db';
import { badRequest, denied, notFound, type AuthContext } from '../../common/http';
import { ROLE_PERMISSIONS } from '../../common/permissions';
import { decodeCursor, encodeCursor } from '../../common/wire';
import { EventConsumers } from '../../outbox/event-consumers';
import type { InternalEvent } from '../../outbox/outbox.publisher';
import { roomFor } from '../../outbox/outbox.service';
import { AGENT_NS, RealtimeService } from '../../realtime/realtime.service';
import { visitorDisplayName } from '../chats/chat.projections';
import { notificationId, notificationText, type NotificationContext, type NotificationKind } from './notification-text';

export interface NotificationResource {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationDraft {
  membershipId: string;
  /** Semantic dedupe key; with the recipient it derives the row id, so redelivery never duplicates. */
  dedupeKey: string;
  kind: NotificationKind;
  context: NotificationContext;
  link: string | null;
}

interface NotificationRow {
  id: string;
  membership_id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}

const PUSH_TTL_MS = 60_000;
const MAX_RECIPIENTS = 500;

function resource(r: NotificationRow): NotificationResource {
  return { id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, read: !!r.read_at, readAt: r.read_at, createdAt: r.created_at };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * In-app agent notifications (ch. 14): rows in `notifications` created by
 * idempotent outbox consumers, read through REST, and pushed as ephemeral
 * `notification.created` frames to the recipient's own agent room. Desktop and
 * sound alerts are decided client-side from these frames and the member's
 * preferences; with `privacyMode` the stored text is generic.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly db: TenantDb,
    private readonly realtime: RealtimeService,
    private readonly consumers: EventConsumers,
  ) {}

  onModuleInit(): void {
    this.consumers.on('assignment.offered', 'notifications:assignment.offered', (e) => this.onOffered(e));
    this.consumers.on('chat.transferred', 'notifications:chat.transferred', (e) => this.onTransferred(e));
    this.consumers.on('offline.submitted', 'notifications:offline.submitted', (e) => this.onOfflineSubmitted(e));
  }

  // ───────── Creation ─────────

  async create(tenantId: string, drafts: NotificationDraft[]): Promise<NotificationResource[]> {
    if (!drafts.length) return [];
    const created = await this.db.tx(tenantId, async (tx) => {
      const members = await tx.membership.findMany({
        where: { tenantId, id: { in: [...new Set(drafts.map((d) => d.membershipId))] }, enabled: true, archivedAt: null },
        select: { id: true, preferences: true },
      });
      const privacy = new Map(members.map((m) => [m.id, (m.preferences as { privacyMode?: unknown } | null)?.privacyMode === true]));
      const rows: NotificationRow[] = [];
      for (const d of drafts) {
        if (!privacy.has(d.membershipId)) continue;
        const text = notificationText(d.kind, d.context, privacy.get(d.membershipId)!);
        const id = notificationId(tenantId, d.dedupeKey, d.membershipId);
        rows.push(
          ...(await tx.$queryRaw<NotificationRow[]>`
            INSERT INTO notifications (id, tenant_id, membership_id, type, title, body, link, created_at)
            VALUES (${id}::uuid, ${tenantId}::uuid, ${d.membershipId}::uuid, ${d.kind}, ${text.title}, ${text.body}, ${d.link}, now())
            ON CONFLICT (id) DO NOTHING
            RETURNING id, membership_id, type, title, body, link, read_at, created_at`),
        );
      }
      return rows;
    });
    for (const row of created) {
      const unreadCount = await this.unreadCount(tenantId, row.membership_id);
      this.realtime.ephemeral(
        AGENT_NS,
        roomFor(tenantId, 'agent', row.membership_id, 'staff'),
        'notification.created',
        { kind: 'agent', id: row.membership_id },
        { notification: resource(row), unreadCount },
        PUSH_TTL_MS,
      );
    }
    return created.map(resource);
  }

  private unreadCount(tenantId: string, membershipId: string): Promise<number> {
    return this.db.read(tenantId, (tx) => tx.notification.count({ where: { tenantId, membershipId, readAt: null } }));
  }

  // ───────── Consumers ─────────

  async onOffered(e: InternalEvent): Promise<void> {
    const offer = obj(e.payload['offer']);
    const target = str(offer['target_membership_id']);
    const offerId = str(offer['id']) ?? e.aggregateId;
    const chatId = str(offer['chat_id']);
    if (!target || !chatId) return;
    const preview = obj(e.payload['chat_preview']);
    const visitor = obj(preview['visitor']);
    const mode = str(offer['mode']);
    await this.create(e.tenantId, [
      {
        membershipId: target,
        dedupeKey: `offer:${offerId}`,
        kind: mode === 'transfer' ? 'chat.transfer_offered' : 'chat.assigned',
        context: {
          chatNumber: typeof preview['number'] === 'number' ? (preview['number'] as number) : null,
          visitorName: str(visitor['display_name']),
          preview: str(preview['last_message_preview']),
          from: str(e.payload['from']),
          note: str(offer['note']),
        },
        link: `/inbox/${chatId}`,
      },
    ]);
  }

  async onTransferred(e: InternalEvent): Promise<void> {
    if (e.payload['forced'] !== true) return;
    const chatId = str(e.payload['chat_id']);
    const next = str(e.payload['next_owner']);
    const previous = str(e.payload['previous_owner']);
    if (!chatId || (!next && !previous)) return;
    const ctx = await this.db.read(e.tenantId, async (tx) => {
      const chat = await tx.chat.findFirst({ where: { tenantId: e.tenantId, id: chatId }, select: { number: true, visitorId: true } });
      if (!chat) return null;
      const v = await tx.visitor.findFirst({ where: { tenantId: e.tenantId, id: chat.visitorId }, select: { id: true, name: true, anonymousLabel: true } });
      return { chatNumber: chat.number, visitorName: v ? visitorDisplayName(v) : null };
    });
    if (!ctx) return;
    const drafts: NotificationDraft[] = [];
    if (next) drafts.push({ membershipId: next, dedupeKey: `forced:${e.eventId}`, kind: 'chat.transferred', context: ctx, link: `/inbox/${chatId}` });
    if (previous && previous !== next) drafts.push({ membershipId: previous, dedupeKey: `forced:${e.eventId}`, kind: 'chat.transferred_away', context: ctx, link: null });
    await this.create(e.tenantId, drafts);
  }

  async onOfflineSubmitted(e: InternalEvent): Promise<void> {
    const sub = obj(e.payload['submission']);
    const id = str(e.payload['submission_id']) ?? str(sub['id']) ?? str(e.payload['id']) ?? (e.aggregateType.startsWith('offline') ? e.aggregateId : null);
    if (!id) return;
    const data = await this.db.read(e.tenantId, async (tx) => {
      const s = await tx.offlineSubmission.findFirst({ where: { tenantId: e.tenantId, id }, select: { id: true, reference: true, name: true, message: true, departmentId: true, status: true } });
      if (!s || s.status === 'erased') return null;
      const dept = s.departmentId ? await tx.department.findFirst({ where: { tenantId: e.tenantId, id: s.departmentId }, select: { name: true } }) : null;
      const members = await tx.membership.findMany({
        where: {
          tenantId: e.tenantId,
          enabled: true,
          archivedAt: null,
          ...(s.departmentId ? { departments: { some: { departmentId: s.departmentId, OR: [{ canServe: true }, { canMonitor: true }] } } } : {}),
        },
        select: { id: true, role: true },
        take: MAX_RECIPIENTS * 2,
      });
      return { s, deptName: dept?.name ?? null, recipients: members.filter((m) => ROLE_PERMISSIONS[m.role].has('offline.view')).slice(0, MAX_RECIPIENTS).map((m) => m.id) };
    });
    if (!data) return;
    await this.create(
      e.tenantId,
      data.recipients.map((membershipId) => ({
        membershipId,
        dedupeKey: `offline:${data.s.id}`,
        kind: 'offline.submitted' as const,
        context: { reference: data.s.reference, submitterName: data.s.name, preview: data.s.message, departmentName: data.deptName },
        link: `/offline-messages/${data.s.id}`,
      })),
    );
  }

  // ───────── REST ─────────

  async list(auth: AuthContext, q: { cursor?: string; limit: number; unreadOnly: boolean }) {
    const me = this.member(auth);
    const filterHash = q.unreadOnly ? 'unread' : 'all';
    const after = decodeCursor<{ t: string; i: string }>(q.cursor, filterHash);
    if (q.cursor && !after) throw badRequest('Invalid cursor', { cursor: ['Start again without a cursor'] });
    return this.db.read(auth.tenantId, async (tx) => {
      const rows = await tx.notification.findMany({
        where: {
          tenantId: auth.tenantId,
          membershipId: me,
          ...(q.unreadOnly ? { readAt: null } : {}),
          ...(after ? { OR: [{ createdAt: { lt: new Date(after.t) } }, { createdAt: new Date(after.t), id: { lt: after.i } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const unreadCount = await tx.notification.count({ where: { tenantId: auth.tenantId, membershipId: me, readAt: null } });
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      const nextCursor = rows.length > q.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), i: last.id }, filterHash) : null;
      return {
        items: page.map((r): NotificationResource => ({ id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, read: !!r.readAt, readAt: r.readAt, createdAt: r.createdAt })),
        unreadCount,
        nextCursor,
        hasMore: !!nextCursor,
      };
    });
  }

  async markRead(auth: AuthContext, id: string): Promise<{ id: string; readAt: Date; unreadCount: number }> {
    const me = this.member(auth);
    const out = await this.db.tx(auth.tenantId, async (tx) => {
      const n = await tx.notification.findFirst({ where: { tenantId: auth.tenantId, id, membershipId: me } });
      if (!n) throw notFound('Notification');
      const readAt = n.readAt ?? new Date();
      if (!n.readAt) await tx.notification.update({ where: { id }, data: { readAt } });
      const unreadCount = await tx.notification.count({ where: { tenantId: auth.tenantId, membershipId: me, readAt: null } });
      return { id, readAt, unreadCount, changed: !n.readAt };
    });
    if (out.changed) this.pushRead(auth.tenantId, me, { ids: [id], all: false, unreadCount: out.unreadCount });
    return { id: out.id, readAt: out.readAt, unreadCount: out.unreadCount };
  }

  async markAllRead(auth: AuthContext): Promise<{ updated: number; unreadCount: number }> {
    const me = this.member(auth);
    const r = await this.db.tx(auth.tenantId, (tx) => tx.notification.updateMany({ where: { tenantId: auth.tenantId, membershipId: me, readAt: null }, data: { readAt: new Date() } }));
    if (r.count) this.pushRead(auth.tenantId, me, { ids: null, all: true, unreadCount: 0 });
    return { updated: r.count, unreadCount: 0 };
  }

  /** Keeps other tabs of the same agent in sync (badge counts). */
  private pushRead(tenantId: string, membershipId: string, payload: { ids: string[] | null; all: boolean; unreadCount: number }): void {
    this.realtime.ephemeral(AGENT_NS, roomFor(tenantId, 'agent', membershipId, 'staff'), 'notification.read', { kind: 'agent', id: membershipId }, payload, PUSH_TTL_MS);
  }

  private member(auth: AuthContext): string {
    if (!auth.membershipId) throw denied('Notifications belong to workspace members');
    return auth.membershipId;
  }
}
