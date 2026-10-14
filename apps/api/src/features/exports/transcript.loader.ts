import type { Tx } from '../../db/tenant-db';
import {
  messageInclude,
  messageResource,
  publicMessage,
  visitorDisplayName,
  type MessageRow,
} from '../chats/chat.projections';
import { publicCloseReason } from '../chats/chat.store';
import type {
  TranscriptAttachment,
  TranscriptAudience,
  TranscriptChat,
  TranscriptMessage,
} from './transcript.render';

/**
 * Builds the authorised transcript projection for one chat from the *current*
 * database state (erasure/redaction applied at render time, ch. 20).
 *  - public: exactly what the visitor may see (publicMessage projection) — no internal
 *    notes, internal events, IP addresses, contact details or custom fields.
 *  - staff: public messages and system events; internal notes only when `includeInternal`.
 */
export async function loadTranscriptChat(
  tx: Tx,
  tenantId: string,
  chatId: string,
  opts: { audience: TranscriptAudience; includeInternal: boolean },
): Promise<TranscriptChat | null> {
  const chat = await tx.chat.findFirst({ where: { tenantId, id: chatId }, include: { rating: true } });
  if (!chat) return null;
  const [site, department, visitor, participants, rows] = await Promise.all([
    tx.site.findFirst({ where: { tenantId, id: chat.siteId }, select: { id: true, name: true } }),
    chat.departmentId
      ? tx.department.findFirst({
          where: { tenantId, id: chat.departmentId },
          select: { id: true, name: true, publicLabel: true },
        })
      : null,
    tx.visitor.findFirst({
      where: { tenantId, id: chat.visitorId },
      select: { id: true, name: true, anonymousLabel: true, erasedAt: true },
    }),
    tx.chatParticipant.findMany({
      where: { tenantId, chatId, actorType: 'agent' },
      orderBy: { joinedAt: 'asc' },
      select: { membershipId: true },
    }),
    tx.message.findMany({ where: { tenantId, chatId }, orderBy: { seq: 'asc' }, include: messageInclude }),
  ]);
  const memberIds = [...new Set(participants.map((p) => p.membershipId).filter((x): x is string => !!x))];
  const members = memberIds.length
    ? await tx.membership.findMany({
        where: { tenantId, id: { in: memberIds } },
        include: { user: { select: { displayName: true } } },
      })
    : [];
  const agentNames = memberIds
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => {
      const full = m.displayName || m.user.displayName;
      return opts.audience === 'public' ? (full.split(' ')[0] ?? full) : full;
    });

  const messages: TranscriptMessage[] = [];
  for (const row of rows) {
    const projected = projectMessage(row, opts);
    if (projected) messages.push(projected);
  }
  const visitorName = !visitor || visitor.erasedAt ? 'Visitor' : visitorDisplayName(visitor);
  return {
    id: chat.id,
    number: chat.number,
    site: { id: chat.siteId, name: site?.name ?? 'Unknown site' },
    department: department
      ? {
          id: department.id,
          name: opts.audience === 'public' ? department.publicLabel || department.name : department.name,
        }
      : null,
    status: chat.status,
    startedAt: chat.requestedAt,
    endedAt: chat.closedAt,
    closeReason:
      chat.closeReason && opts.audience === 'public' ? publicCloseReason(chat.closeReason) : chat.closeReason,
    participants: [
      { role: 'visitor', name: visitorName },
      ...[...new Set(agentNames)].map((name) => ({ role: 'agent' as const, name })),
    ],
    rating: chat.rating
      ? { rating: chat.rating.rating, comment: chat.rating.comment, submittedAt: chat.rating.submittedAt }
      : null,
    messages,
  };
}

function projectMessage(
  row: MessageRow,
  opts: { audience: TranscriptAudience; includeInternal: boolean },
): TranscriptMessage | null {
  const base = messageResource(row);
  const m =
    opts.audience === 'public'
      ? publicMessage(base)
      : base.visibility === 'internal' && !opts.includeInternal
        ? null
        : base;
  if (!m) return null;
  const redacted = m.redacted;
  const attachments: TranscriptAttachment[] = redacted
    ? []
    : row.attachments.map(({ attachment: a }) =>
        a.deletedAt
          ? {
              id: a.id,
              name: '[removed]',
              sizeBytes: Number(a.sizeBytes),
              mime: a.detectedMime ?? a.declaredMime,
              state: 'removed',
            }
          : {
              id: a.id,
              name: a.originalName,
              sizeBytes: Number(a.sizeBytes),
              mime: a.detectedMime ?? a.declaredMime,
              state: a.state,
            },
      );
  return {
    id: m.id,
    seq: m.seq,
    sentAt: m.sentAt,
    sender: { type: m.sender.type, name: m.sender.displayName },
    visibility: m.visibility,
    type: m.type,
    body: redacted ? null : m.body,
    redacted,
    systemEvent: m.systemEvent?.kind ?? null,
    attachments,
  };
}
