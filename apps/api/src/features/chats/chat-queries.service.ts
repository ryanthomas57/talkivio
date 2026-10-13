import { Injectable } from '@nestjs/common';
import { Prisma, type Chat } from '@prisma/client';
import { sortQueue } from '@talkivio/contracts';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { sha256 } from '../../common/crypto';
import { badRequest, denied, notFound, type AuthContext, type VisitorContext } from '../../common/http';
import { decodeCursor, encodeCursor, page, type Page } from '../../common/wire';
import { PresenceService } from '../../core/presence.service';
import { ChatStore } from './chat.store';
import { messageInclude, messageResource, publicMessage, type MessageResource, type PublicChat, type StaffChat } from './chat.projections';

/**
 * ts_headline match markers. Control characters are removed from the body first, so message
 * text can never fake or break a highlight; clients get plain text plus [start, end) offsets.
 */
const HEADLINE_START = '\u0002';
const HEADLINE_STOP = '\u0003';
const HEADLINE_MARKS = HEADLINE_START + HEADLINE_STOP;
const HEADLINE_OPTIONS = `MaxWords=18,MinWords=6,StartSel=${HEADLINE_START},StopSel=${HEADLINE_STOP}`;
/**
 * History search reads matching chats in batches (newest first) before the remaining filters apply; when filters
 * discard most of a full batch the next, larger batch continues behind it, up to SEARCH_ROUNDS per request.
 */
const SEARCH_BATCH = 500;
const SEARCH_ROUNDS = 4;
type Keyset = { t: string; id: string };
const keysetOf = (r: { requestedAt: Date; id: string }): Keyset => ({ t: r.requestedAt.toISOString(), id: r.id });
const newerFirst = (a: Keyset, b: Keyset) => (a.t === b.t ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.t < b.t ? 1 : -1);
interface Headline {
  text: string;
  highlights: Array<[number, number]>;
}
/** Offsets count Unicode code points (what `Array.from(text)` indexes), not UTF-16 units. */
export function splitHeadline(raw: string): Headline {
  let text = '';
  let n = 0;
  let open = -1;
  const highlights: Array<[number, number]> = [];
  for (const ch of raw) {
    if (ch === HEADLINE_START) open = n;
    else if (ch === HEADLINE_STOP) {
      if (open >= 0 && n > open) highlights.push([open, n]);
      open = -1;
    } else {
      text += ch;
      n++;
    }
  }
  return { text, highlights };
}

export type InboxView = 'mine' | 'queue' | 'department' | 'all';

export interface HistoryQuery {
  q?: string;
  from?: string;
  to?: string;
  siteId?: string;
  agentId?: string;
  departmentId?: string;
  rating?: 'good' | 'bad' | 'none';
  tagId?: string;
  status?: 'active' | 'closed' | 'queued';
  cursor?: string;
  limit: number;
}

export interface MessagePage {
  items: MessageResource[];
  throughSeq: number;
  lastSeq: number;
  hasMore: boolean;
}

@Injectable()
export class ChatQueriesService {
  constructor(
    private readonly db: TenantDb,
    private readonly store: ChatStore,
    private readonly presence: PresenceService,
  ) {}

  /** Row-level visibility for staff (ch. 04 department scoping). */
  scopeWhere(auth: AuthContext): Prisma.ChatWhereInput {
    if (auth.departmentScope === 'all') return {};
    return {
      OR: [
        { departmentId: null },
        { departmentId: { in: auth.departmentScope } },
        { ownerMembershipId: auth.membershipId ?? '__none__' },
        { participants: { some: { membershipId: auth.membershipId ?? '__none__' } } },
      ],
    };
  }

  async getVisible(tx: Tx, auth: AuthContext, chatId: string): Promise<Chat> {
    const chat = await tx.chat.findFirst({ where: { AND: [{ tenantId: auth.tenantId, id: chatId }, this.scopeWhere(auth)] } });
    if (!chat) throw notFound('Chat');
    return chat;
  }

  async snapshot(auth: AuthContext, chatId: string): Promise<StaffChat> {
    if (!auth.permissions.has('chats.serve') && !auth.permissions.has('history.view')) throw denied();
    return this.db.read(auth.tenantId, async (tx) => {
      await this.getVisible(tx, auth, chatId);
      const staff = await this.store.staff(tx, auth.tenantId, chatId);
      const online = await this.presence.isVisitorOnline(auth.tenantId, staff.visitorId);
      return { ...staff, visitor: { ...staff.visitor, online } };
    });
  }

  private async unreadFor(tx: Tx, auth: AuthContext, chatIds: string[]): Promise<Map<string, number>> {
    if (!auth.membershipId || !chatIds.length) return new Map();
    const rows = await tx.$queryRaw<Array<{ chat_id: string; unread: bigint }>>`
      SELECT m.chat_id, COUNT(*)::bigint AS unread
      FROM messages m
      JOIN chat_participants p ON p.chat_id = m.chat_id AND p.tenant_id = m.tenant_id
        AND p.membership_id = ${auth.membershipId}::uuid AND p.left_at IS NULL
      WHERE m.tenant_id = ${auth.tenantId}::uuid
        AND m.chat_id = ANY(${chatIds}::uuid[])
        AND m.seq > p.last_read_seq
        AND m.sender_type <> 'system'
        AND (m.sender_membership_id IS NULL OR m.sender_membership_id <> ${auth.membershipId}::uuid)
      GROUP BY m.chat_id`;
    return new Map(rows.map((r) => [r.chat_id, Number(r.unread)]));
  }

  async inbox(auth: AuthContext, view: InboxView, opts: { departmentId?: string; limit?: number } = {}): Promise<Page<StaffChat>> {
    if (!auth.permissions.has('chats.serve') && !auth.permissions.has('chats.monitor')) throw denied();
    const limit = Math.min(opts.limit ?? 100, 200);
    return this.db.read(auth.tenantId, async (tx) => {
      const me = auth.membershipId ?? '__none__';
      let where: Prisma.ChatWhereInput;
      switch (view) {
        case 'mine':
          where = { status: { in: ['active', 'offered', 'queued'] }, participants: { some: { membershipId: me, leftAt: null } } };
          break;
        case 'queue':
          where = {
            status: { in: ['queued', 'offered'] },
            ...(auth.departmentScope === 'all' ? {} : { OR: [{ departmentId: null }, { departmentId: { in: auth.servedDepartmentIds } }] }),
          };
          break;
        case 'department':
          if (!opts.departmentId) throw badRequest('department_id is required', { department_id: ['Required'] });
          if (auth.departmentScope !== 'all' && !auth.departmentScope.includes(opts.departmentId)) throw notFound('Department');
          where = { status: { not: 'closed' }, departmentId: opts.departmentId };
          break;
        case 'all':
          where = { AND: [{ status: { not: 'closed' } }, this.scopeWhere(auth)] };
          break;
      }
      const rows = await tx.chat.findMany({
        where: { AND: [{ tenantId: auth.tenantId, isPreview: false }, where] },
        orderBy: view === 'queue' ? [{ priority: 'desc' }, { requestedAt: 'asc' }, { id: 'asc' }] : [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: { id: true, priority: true, requestedAt: true },
      });
      const ordered = view === 'queue' ? sortQueue(rows.map((r) => ({ ...r, requestedAt: r.requestedAt.getTime() })), Date.now()) : rows;
      const items: StaffChat[] = [];
      for (const r of ordered) items.push(await this.store.staff(tx, auth.tenantId, r.id));
      const unread = await this.unreadFor(tx, auth, items.map((i) => i.id));
      const online = await this.presence.onlineVisitorIds(auth.tenantId, items.map((i) => i.visitorId));
      return page(
        items.map((i) => ({ ...i, unreadCount: unread.get(i.id) ?? 0, visitor: { ...i.visitor, online: online.has(i.visitorId) } })),
        null,
      );
    });
  }

  /** Inbox counters for the sidebar. */
  async counts(auth: AuthContext): Promise<Record<string, number>> {
    return this.db.read(auth.tenantId, async (tx) => {
      const me = auth.membershipId ?? '__none__';
      const [mine, queue, all, offers] = await Promise.all([
        tx.chat.count({ where: { tenantId: auth.tenantId, status: 'active', participants: { some: { membershipId: me, leftAt: null } } } }),
        tx.chat.count({
          where: {
            tenantId: auth.tenantId,
            isPreview: false,
            status: { in: ['queued', 'offered'] },
            ...(auth.departmentScope === 'all' ? {} : { OR: [{ departmentId: null }, { departmentId: { in: auth.servedDepartmentIds } }] }),
          },
        }),
        tx.chat.count({ where: { AND: [{ tenantId: auth.tenantId, isPreview: false, status: { not: 'closed' } }, this.scopeWhere(auth)] } }),
        tx.assignmentOffer.count({ where: { tenantId: auth.tenantId, membershipId: me, status: 'pending', expiresAt: { gt: new Date() } } }),
      ]);
      const unreadMine = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n FROM messages m
        JOIN chat_participants p ON p.chat_id = m.chat_id AND p.tenant_id = m.tenant_id AND p.membership_id = ${me}::uuid AND p.left_at IS NULL
        JOIN chats c ON c.id = m.chat_id AND c.status = 'active'
        WHERE m.tenant_id = ${auth.tenantId}::uuid AND m.seq > p.last_read_seq AND m.sender_type = 'visitor'`;
      return { mine, queue, all, pendingOffers: offers, unreadMine: Number(unreadMine[0]?.n ?? 0) };
    });
  }

  async pendingOffers(auth: AuthContext) {
    return this.db.read(auth.tenantId, async (tx) => {
      const offers = await tx.assignmentOffer.findMany({
        where: { tenantId: auth.tenantId, membershipId: auth.membershipId ?? '__none__', status: 'pending', expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'asc' },
      });
      const out = [];
      for (const o of offers) {
        out.push({
          offer: { id: o.id, chatId: o.chatId, mode: o.mode, expiresAt: o.expiresAt, note: o.note, fromMembershipId: o.fromMembershipId, version: o.version },
          chatPreview: await this.store.staff(tx, auth.tenantId, o.chatId),
        });
      }
      return out;
    });
  }

  /** Staff message page (ascending seq). Internal notes require notes permission. */
  async messages(auth: AuthContext, chatId: string, q: { afterSeq?: number; beforeSeq?: number; limit?: number }): Promise<MessagePage> {
    // Same rule as the chat snapshot: transcripts need chat or history access, whatever the member's data scope.
    if (!auth.permissions.has('chats.serve') && !auth.permissions.has('history.view')) throw denied();
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    return this.db.read(auth.tenantId, async (tx) => {
      const chat = await this.getVisible(tx, auth, chatId);
      const notes = auth.permissions.has('notes.view');
      return this.pageMessages(tx, chat, { ...q, limit }, (m) => (m.visibility === 'internal' && !notes ? null : m));
    });
  }

  /** Visitor message page: public projection only; internal seq gaps are covered by through_seq. */
  async visitorMessages(v: VisitorContext, chatId: string, q: { afterSeq?: number; beforeSeq?: number; limit?: number }): Promise<MessagePage> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    return this.db.read(v.tenantId, async (tx) => {
      const chat = await tx.chat.findFirst({ where: { tenantId: v.tenantId, id: chatId, visitorId: v.visitorId, siteId: v.siteId } });
      if (!chat) throw notFound('Chat');
      return this.pageMessages(tx, chat, { ...q, limit }, publicMessage);
    });
  }

  private async pageMessages(
    tx: Tx,
    chat: Chat,
    q: { afterSeq?: number; beforeSeq?: number; limit: number },
    project: (m: MessageResource) => MessageResource | null,
  ): Promise<MessagePage> {
    const lastSeq = Number(chat.nextSeq) - 1;
    const where: Prisma.MessageWhereInput = { tenantId: chat.tenantId, chatId: chat.id };
    let order: 'asc' | 'desc' = 'asc';
    if (q.beforeSeq !== undefined) {
      where.seq = { lt: BigInt(q.beforeSeq) };
      order = 'desc';
    } else if (q.afterSeq !== undefined) {
      where.seq = { gt: BigInt(q.afterSeq) };
    } else {
      order = 'desc'; // latest page by default
    }
    const rows = await tx.message.findMany({ where, orderBy: { seq: order }, take: q.limit + 1, include: messageInclude });
    const hasMore = rows.length > q.limit;
    const slice = rows.slice(0, q.limit);
    const asc = order === 'desc' ? slice.reverse() : slice;
    const throughSeq = order === 'asc' ? (hasMore ? Number(asc[asc.length - 1]?.seq ?? q.afterSeq ?? 0) : lastSeq) : lastSeq;
    const items = asc.map((m) => project(messageResource(m))).filter((m): m is MessageResource => !!m);
    return { items, throughSeq, lastSeq, hasMore };
  }

  async visitorChat(v: VisitorContext, chatId: string): Promise<PublicChat> {
    return this.db.read(v.tenantId, async (tx) => {
      const chat = await tx.chat.findFirst({ where: { tenantId: v.tenantId, id: chatId, visitorId: v.visitorId, siteId: v.siteId } });
      if (!chat) throw notFound('Chat');
      return this.store.publicChat(tx, chatId);
    });
  }

  /** History list with full-text search (permission + department scope applied before ranking). */
  async history(auth: AuthContext, q: HistoryQuery): Promise<Page<StaffChat & { snippet?: string | null; snippetHighlights?: Array<[number, number]> }>> {
    if (!auth.permissions.has('history.view')) throw denied();
    const limit = Math.min(q.limit || 50, 100);
    const filterHash = sha256(JSON.stringify({ ...q, cursor: undefined })).slice(0, 16);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur) throw badRequest('This cursor does not match the current filters', { cursor: ['Invalid cursor'] });
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (to.getTime() - from.getTime() > 365 * 86_400_000) throw badRequest('Date range is limited to 365 days', { from: ['Maximum range is 365 days'] });
    return this.db.read(auth.tenantId, async (tx) => {
      const and: Prisma.ChatWhereInput[] = [
        { tenantId: auth.tenantId, isPreview: false, requestedAt: { gte: from, lt: to } },
        this.scopeWhere(auth),
      ];
      if (q.siteId) and.push({ siteId: q.siteId });
      if (q.departmentId) and.push({ departmentId: q.departmentId });
      if (q.agentId) and.push({ OR: [{ ownerMembershipId: q.agentId }, { participants: { some: { membershipId: q.agentId } } }] });
      if (q.status) and.push(q.status === 'queued' ? { status: { in: ['queued', 'offered'] } } : { status: q.status });
      if (q.rating) and.push(q.rating === 'none' ? { rating: null } : { rating: { rating: q.rating } });
      if (q.tagId) and.push({ tags: { some: { tagId: q.tagId } } });
      const select = { id: true, requestedAt: true } as const;
      const orderBy: Prisma.ChatOrderByWithRelationInput[] = [{ requestedAt: 'desc' }, { id: 'desc' }];
      const after = (k: Keyset | null): Prisma.ChatWhereInput[] => (k ? [{ OR: [{ requestedAt: { lt: new Date(k.t) } }, { requestedAt: new Date(k.t), id: { lt: k.id } }] }] : []);
      let rows: Array<{ id: string; requestedAt: Date }>;
      let search: { term: string; includeNotes: boolean } | null = null;
      // Keyset of the last candidate read when the candidates were cut off: the next page resumes behind it.
      let resumeAt: Keyset | null = null;
      if (q.q && q.q.trim().length >= 2) {
        search = { term: q.q.trim().slice(0, 256), includeNotes: auth.permissions.has('notes.view') };
        const num = Number(search.term.replace(/^#/, ''));
        const byNumber = Number.isInteger(num) && num > 0 ? [{ number: num }] : [];
        const found = new Map<string, { id: string; requestedAt: Date }>();
        let position = cur;
        for (let round = 0, batch = SEARCH_BATCH; round < SEARCH_ROUNDS; round++, batch *= 2) {
          // Matching chats through the SECURITY DEFINER entry point (tenant from the transaction context). Under RLS
          // PostgreSQL never uses the body index for @@ (the operator is not leakproof), so a policy-scoped query
          // read every message of the tenant.
          const candidates = await tx.$queryRaw<Array<{ chat_id: string; requested_at: Date }>>`
            SELECT chat_id, requested_at
              FROM rd_search_chat_ids(${search.term}, ${from}, ${to}, ${search.includeNotes},
                                      ${position ? new Date(position.t) : null}::timestamptz, ${position?.id ?? null}::uuid, ${batch}::int)`;
          const ids = candidates.map((c) => c.chat_id);
          const hits = await tx.chat.findMany({ where: { AND: [...and, { OR: [{ id: { in: ids } }, ...byNumber] }, ...after(position)] }, orderBy, take: limit + 1, select });
          for (const h of hits) found.set(h.id, h);
          const last = candidates[candidates.length - 1];
          resumeAt = candidates.length === batch && last ? { t: last.requested_at.toISOString(), id: last.chat_id } : null;
          if (!resumeAt || found.size > limit) break;
          position = resumeAt;
        }
        rows = [...found.values()].sort((a, b) => newerFirst(keysetOf(a), keysetOf(b)));
        // Only rows ahead of the resume point are complete; anything behind it is fetched again by the next page.
        if (resumeAt) rows = rows.filter((r) => newerFirst(keysetOf(r), resumeAt!) <= 0);
      } else {
        rows = await tx.chat.findMany({ where: { AND: [...and, ...after(cur)] }, orderBy, take: limit + 1, select });
      }
      const slice = rows.slice(0, limit);
      const snippets = search && slice.length ? await this.headlines(tx, auth.tenantId, slice.map((r) => r.id), search.term, search.includeNotes) : new Map<string, Headline>();
      const items = [];
      for (const r of slice) {
        const h = snippets.get(r.id);
        items.push({ ...(await this.store.staff(tx, auth.tenantId, r.id)), snippet: h?.text ?? null, snippetHighlights: h?.highlights ?? [] });
      }
      const last = slice[slice.length - 1];
      const next = rows.length > limit && last ? keysetOf(last) : resumeAt;
      return page(items, next ? encodeCursor(next, filterHash) : null);
    });
  }

  /** Snippet from the first matching message of each chat on the page (ts_headline is the expensive part). */
  private async headlines(tx: Tx, tenantId: string, chatIds: string[], term: string, includeNotes: boolean): Promise<Map<string, Headline>> {
    const hits = await tx.$queryRaw<Array<{ chat_id: string; snippet: string }>>`
      SELECT h.chat_id,
             ts_headline('simple', translate(h.body, ${HEADLINE_MARKS}, ''), websearch_to_tsquery('simple', ${term}), ${HEADLINE_OPTIONS}) AS snippet
        FROM (SELECT DISTINCT ON (m.chat_id) m.chat_id, m.body
                FROM messages m
               WHERE m.tenant_id = ${tenantId}::uuid AND m.chat_id = ANY(${chatIds}::uuid[])
                 AND (${includeNotes} OR m.visibility = 'public')
                 AND m.redacted_at IS NULL
                 AND to_tsvector('simple', coalesce(m.body, '')) @@ websearch_to_tsquery('simple', ${term})
               ORDER BY m.chat_id, m.seq) h`;
    return new Map(hits.map((h) => [h.chat_id, splitHeadline(h.snippet)]));
  }
}
