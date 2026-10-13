import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Tx } from '../../db/tenant-db';
import { deriveFact, factViewFromRow, snapshotFields, type FactInput, type FactRow, type FactView } from './facts';

const CHUNK = 1000;

function chunks<T>(xs: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

interface ReplyAggRow {
  chat_id: string;
  n: number;
  first_at: Date | null;
  first_author: string | null;
  authors: string[] | null;
}

/**
 * Loads fact inputs from the source tables (chats, messages, ratings,
 * assignment history, trusted tags, invitations). Used by the fact consumer for
 * one chat and by the raw reconciliation path for a whole range.
 */
@Injectable()
export class FactLoader {
  async inputs(tx: Tx, tenantId: string, chatIds: string[]): Promise<FactInput[]> {
    const out: FactInput[] = [];
    for (const ids of chunks([...new Set(chatIds)])) {
      const chats = await tx.chat.findMany({
        where: { tenantId, id: { in: ids } },
        select: {
          id: true,
          siteId: true,
          departmentId: true,
          acquisitionDepartmentId: true,
          ownerMembershipId: true,
          status: true,
          startedBy: true,
          requestedAt: true,
          firstAssignedAt: true,
          closedAt: true,
          closeReason: true,
          closedByActor: true,
          isPreview: true,
          version: true,
          nextSeq: true,
        },
      });
      if (!chats.length) continue;
      const found = chats.map((c) => c.id);
      const replies = await tx.$queryRaw<ReplyAggRow[]>`
        SELECT chat_id,
               count(*)::int AS n,
               min(sent_at) AS first_at,
               (array_agg(sender_membership_id ORDER BY seq))[1] AS first_author,
               array_agg(DISTINCT sender_membership_id) FILTER (WHERE sender_membership_id IS NOT NULL) AS authors
          FROM messages
         WHERE tenant_id = ${tenantId}::uuid
           AND chat_id = ANY(${found}::uuid[])
           AND sender_type = 'agent' AND visibility = 'public' AND automated = false
         GROUP BY chat_id`;
      const [ratings, history, tags] = await Promise.all([
        tx.chatRating.findMany({ where: { tenantId, chatId: { in: found } }, select: { chatId: true, rating: true, submittedAt: true, revisedAt: true, revisionCount: true } }),
        tx.assignmentHistory.findMany({
          where: { tenantId, chatId: { in: found } },
          select: { chatId: true, reason: true, previousOwnerId: true, nextOwnerId: true, occurredAt: true },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        }),
        tx.chatTag.findMany({ where: { tenantId, chatId: { in: found }, source: { not: 'client' } }, select: { chatId: true, tagId: true } }),
      ]);
      const invited = chats.filter((c) => c.startedBy === 'invitation').map((c) => c.id);
      const invitations = invited.length
        ? await tx.campaignInvitation.findMany({ where: { tenantId, acceptedChatId: { in: invited } }, select: { id: true, acceptedChatId: true }, orderBy: { createdAt: 'asc' } })
        : [];
      const replyBy = new Map(replies.map((r) => [r.chat_id, r]));
      const ratingBy = new Map(ratings.map((r) => [r.chatId, r]));
      const historyBy = new Map<string, typeof history>();
      for (const h of history) historyBy.set(h.chatId, [...(historyBy.get(h.chatId) ?? []), h]);
      const tagsBy = new Map<string, string[]>();
      for (const t of tags) tagsBy.set(t.chatId, [...(tagsBy.get(t.chatId) ?? []), t.tagId]);
      const invitationBy = new Map<string, string>();
      for (const i of invitations) if (i.acceptedChatId && !invitationBy.has(i.acceptedChatId)) invitationBy.set(i.acceptedChatId, i.id);
      for (const c of chats) {
        const r = replyBy.get(c.id);
        const rating = ratingBy.get(c.id);
        out.push({
          chat: { ...c, status: c.status, nextSeq: Number(c.nextSeq) },
          firstHumanReplyAt: r?.first_at ?? null,
          firstHumanReplyAuthorId: r?.first_author ?? null,
          humanReplyCount: r?.n ?? 0,
          replyAuthorIds: r?.authors ?? [],
          rating: rating ? { rating: rating.rating, submittedAt: rating.submittedAt, revisedAt: rating.revisedAt, revisionCount: rating.revisionCount } : null,
          history: historyBy.get(c.id) ?? [],
          tagIds: tagsBy.get(c.id) ?? [],
          invitationId: invitationBy.get(c.id) ?? null,
        });
      }
    }
    return out;
  }

  /** Raw reconciliation: derive facts directly from source rows for chats requested in [from, to). */
  async rawFacts(tx: Tx, tenantId: string, from: Date, to: Date, limit: number): Promise<FactView[]> {
    const ids = await tx.chat.findMany({
      where: { tenantId, isPreview: false, requestedAt: { gte: from, lt: to } },
      select: { id: true },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    if (ids.length > limit) throw new RangeError('too_many_rows');
    const inputs = await this.inputs(
      tx,
      tenantId,
      ids.map((r) => r.id),
    );
    return inputs.filter((i) => !i.chat.isPreview).map((i) => factViewFromRow(deriveFact(i)));
  }

  /** Materialized facts for chats requested in [from, to). */
  async storedFacts(tx: Tx, tenantId: string, from: Date, to: Date, limit: number): Promise<FactView[]> {
    const rows = await tx.metricChatFact.findMany({
      where: { tenantId, requestedAt: { gte: from, lt: to } },
      select: {
        chatId: true,
        siteId: true,
        departmentId: true,
        requestedAt: true,
        firstAssignedAt: true,
        firstResponseAt: true,
        closedAt: true,
        served: true,
        missed: true,
        abandoned: true,
        rating: true,
        ownerMembershipId: true,
        startedBy: true,
        dimensionSnapshot: true,
      },
      take: limit + 1,
    });
    if (rows.length > limit) throw new RangeError('too_many_rows');
    return rows.map((r) => ({
      chatId: r.chatId,
      siteId: r.siteId,
      departmentId: r.departmentId,
      requestedAt: r.requestedAt.getTime(),
      firstAssignedAt: r.firstAssignedAt?.getTime() ?? null,
      firstResponseAt: r.firstResponseAt?.getTime() ?? null,
      closedAt: r.closedAt?.getTime() ?? null,
      served: r.served,
      missed: r.missed,
      abandoned: r.abandoned,
      rating: r.rating,
      ownerMembershipId: r.ownerMembershipId,
      startedBy: r.startedBy,
      ...snapshotFields(r.dimensionSnapshot),
    }));
  }

  /** Conditional upsert: only a strictly greater source version replaces the stored fact. */
  async upsert(tx: Tx, tenantId: string, row: FactRow): Promise<boolean> {
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    const n = await tx.$executeRaw(Prisma.sql`
      INSERT INTO metric_chat_facts (
        tenant_id, chat_id, site_id, department_id, requested_at, first_assigned_at, first_response_at, closed_at,
        close_reason, served, missed, abandoned, rating, owner_membership_id, started_by, dimension_snapshot, source_version, updated_at)
      VALUES (
        ${tenantId}::uuid, ${row.chatId}::uuid, ${row.siteId}::uuid, ${row.departmentId}::uuid,
        ${iso(row.requestedAt)}::timestamptz, ${iso(row.firstAssignedAt)}::timestamptz, ${iso(row.firstResponseAt)}::timestamptz, ${iso(row.closedAt)}::timestamptz,
        ${row.closeReason}, ${row.served}, ${row.missed}, ${row.abandoned}, ${row.rating}::"RatingValue", ${row.ownerMembershipId}::uuid,
        ${row.startedBy}, ${JSON.stringify(row.snapshot)}::jsonb, ${row.sourceVersion}::int, now())
      ON CONFLICT (tenant_id, chat_id) DO UPDATE SET
        site_id = EXCLUDED.site_id,
        department_id = EXCLUDED.department_id,
        requested_at = EXCLUDED.requested_at,
        first_assigned_at = EXCLUDED.first_assigned_at,
        first_response_at = EXCLUDED.first_response_at,
        closed_at = EXCLUDED.closed_at,
        close_reason = EXCLUDED.close_reason,
        served = EXCLUDED.served,
        missed = EXCLUDED.missed,
        abandoned = EXCLUDED.abandoned,
        rating = EXCLUDED.rating,
        owner_membership_id = EXCLUDED.owner_membership_id,
        started_by = EXCLUDED.started_by,
        dimension_snapshot = EXCLUDED.dimension_snapshot,
        source_version = EXCLUDED.source_version,
        updated_at = now()
      WHERE metric_chat_facts.source_version < EXCLUDED.source_version`);
    return n > 0;
  }
}
