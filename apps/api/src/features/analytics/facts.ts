/**
 * Chat fact derivation (ch. 50). Pure functions shared by the outbox consumer
 * that maintains `metric_chat_facts` and by the raw reconciliation path, so
 * both read the same definitions:
 *
 *  - served    = at least one human agent public (non-automated) message
 *  - assigned  = first_assigned_at present (≠ served)
 *  - missed    = closed without a human public response after admission
 *  - abandoned = visitor ended / reconnect grace expired before first assignment
 *  - quick cancel = visitor ended within 10 s before assignment (disclosed separately)
 *
 * The fact's source version is `chats.version + chats.next_seq`: both only grow,
 * and every change that affects a fact (assignment, transfer, close, rating,
 * tags, any message) increments one of them.
 */

export const QUICK_CANCEL_MS = 10_000;
export const ABANDON_REASONS = new Set(['visitor_ended', 'visitor_disconnected']);
/** History reasons that release ownership without a new owner. */
export const OWNER_RELEASE_REASONS = new Set(['department_transfer']);

export interface ChatSource {
  id: string;
  siteId: string;
  departmentId: string | null;
  acquisitionDepartmentId: string | null;
  ownerMembershipId: string | null;
  status: string;
  startedBy: string;
  requestedAt: Date;
  firstAssignedAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  closedByActor: string | null;
  isPreview: boolean;
  version: number;
  nextSeq: number;
}

export interface HistorySource {
  reason: string;
  previousOwnerId: string | null;
  nextOwnerId: string | null;
  occurredAt: Date;
}

export interface RatingSource {
  rating: 'good' | 'bad';
  submittedAt: Date;
  revisedAt: Date | null;
  revisionCount: number;
}

export interface FactInput {
  chat: ChatSource;
  firstHumanReplyAt: Date | null;
  firstHumanReplyAuthorId: string | null;
  humanReplyCount: number;
  replyAuthorIds: string[];
  rating: RatingSource | null;
  history: HistorySource[];
  tagIds: string[];
  invitationId: string | null;
}

export interface OwnershipInterval {
  membershipId: string;
  from: number;
  /** Exclusive end; null while the chat is still owned. */
  to: number | null;
}

export interface FactSnapshot {
  v: 1;
  acquisitionDepartmentId: string | null;
  currentDepartmentId: string | null;
  status: string;
  closedByActor: string | null;
  quickCancel: boolean;
  firstResponderId: string | null;
  humanReplyCount: number;
  ownerIds: string[];
  replyAuthorIds: string[];
  agentIds: string[];
  tagIds: string[];
  invitationId: string | null;
  ratingSubmittedAt: string | null;
  ratingRevisedAt: string | null;
  ratingRevisionCount: number;
  ownership: Array<{ m: string; from: string; to: string | null }>;
}

export interface FactRow {
  chatId: string;
  siteId: string;
  departmentId: string | null;
  requestedAt: Date;
  firstAssignedAt: Date | null;
  firstResponseAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  served: boolean;
  missed: boolean;
  abandoned: boolean;
  rating: 'good' | 'bad' | null;
  ownerMembershipId: string | null;
  startedBy: string;
  sourceVersion: number;
  snapshot: FactSnapshot;
}

/** Compact, query-side view of one fact (from metric_chat_facts or the raw path). */
export interface FactView {
  chatId: string;
  siteId: string;
  departmentId: string | null;
  acquisitionDepartmentId: string | null;
  requestedAt: number;
  firstAssignedAt: number | null;
  firstResponseAt: number | null;
  closedAt: number | null;
  served: boolean;
  missed: boolean;
  abandoned: boolean;
  quickCancel: boolean;
  rating: 'good' | 'bad' | null;
  ownerMembershipId: string | null;
  startedBy: string;
  agentIds: string[];
  tagIds: string[];
  invitationId: string | null;
}

export function sourceVersionOf(chat: Pick<ChatSource, 'version' | 'nextSeq'>): number {
  return chat.version + chat.nextSeq;
}

/** Ownership intervals from assignment history (owner = interval owner for attribution). */
export function ownershipIntervals(history: readonly HistorySource[], closedAt: Date | null): OwnershipInterval[] {
  const rows = [...history].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const out: OwnershipInterval[] = [];
  let open: OwnershipInterval | null = null;
  for (const h of rows) {
    const at = h.occurredAt.getTime();
    if (h.nextOwnerId) {
      if (open && open.membershipId === h.nextOwnerId) continue;
      if (open) open.to = at;
      open = { membershipId: h.nextOwnerId, from: at, to: null };
      out.push(open);
    } else if (OWNER_RELEASE_REASONS.has(h.reason) && open) {
      open.to = at;
      open = null;
    }
  }
  if (open && closedAt) open.to = Math.max(open.from, closedAt.getTime());
  return out;
}

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort();

export function deriveFact(input: FactInput): FactRow {
  const c = input.chat;
  const served = input.humanReplyCount > 0;
  const closed = c.status === 'closed' && !!c.closedAt;
  const unassigned = !c.firstAssignedAt || (!!c.closedAt && c.firstAssignedAt.getTime() > c.closedAt.getTime());
  const visitorEnded = !!c.closeReason && (ABANDON_REASONS.has(c.closeReason) || (c.closedByActor === 'visitor' && c.closeReason !== 'converted_offline'));
  const abandoned = closed && unassigned && visitorEnded;
  const quickCancel = abandoned && c.closedByActor === 'visitor' && !!c.closedAt && c.closedAt.getTime() - c.requestedAt.getTime() <= QUICK_CANCEL_MS;
  const ownership = ownershipIntervals(input.history, c.closedAt);
  const ownerIds = uniq([...ownership.map((o) => o.membershipId), c.ownerMembershipId]);
  const replyAuthorIds = uniq(input.replyAuthorIds);
  return {
    chatId: c.id,
    siteId: c.siteId,
    departmentId: c.departmentId,
    requestedAt: c.requestedAt,
    firstAssignedAt: c.firstAssignedAt,
    firstResponseAt: input.firstHumanReplyAt,
    closedAt: c.closedAt,
    closeReason: c.closeReason,
    served,
    missed: closed && !served,
    abandoned,
    rating: input.rating?.rating ?? null,
    ownerMembershipId: c.ownerMembershipId,
    startedBy: c.startedBy,
    sourceVersion: sourceVersionOf(c),
    snapshot: {
      v: 1,
      acquisitionDepartmentId: c.acquisitionDepartmentId,
      currentDepartmentId: c.departmentId,
      status: c.status,
      closedByActor: c.closedByActor,
      quickCancel,
      firstResponderId: input.firstHumanReplyAuthorId,
      humanReplyCount: input.humanReplyCount,
      ownerIds,
      replyAuthorIds,
      agentIds: uniq([...ownerIds, ...replyAuthorIds]),
      tagIds: uniq(input.tagIds),
      invitationId: input.invitationId,
      ratingSubmittedAt: input.rating?.submittedAt.toISOString() ?? null,
      ratingRevisedAt: input.rating?.revisedAt?.toISOString() ?? null,
      ratingRevisionCount: input.rating?.revisionCount ?? 0,
      ownership: ownership.map((o) => ({ m: o.membershipId, from: new Date(o.from).toISOString(), to: o.to === null ? null : new Date(o.to).toISOString() })),
    },
  };
}

export function factViewFromRow(row: FactRow): FactView {
  return {
    chatId: row.chatId,
    siteId: row.siteId,
    departmentId: row.departmentId,
    acquisitionDepartmentId: row.snapshot.acquisitionDepartmentId,
    requestedAt: row.requestedAt.getTime(),
    firstAssignedAt: row.firstAssignedAt?.getTime() ?? null,
    firstResponseAt: row.firstResponseAt?.getTime() ?? null,
    closedAt: row.closedAt?.getTime() ?? null,
    served: row.served,
    missed: row.missed,
    abandoned: row.abandoned,
    quickCancel: row.snapshot.quickCancel,
    rating: row.rating,
    ownerMembershipId: row.ownerMembershipId,
    startedBy: row.startedBy,
    agentIds: row.snapshot.agentIds,
    tagIds: row.snapshot.tagIds,
    invitationId: row.snapshot.invitationId,
  };
}

/** Parse a stored dimension snapshot defensively (older/partial rows never crash a report). */
export function snapshotFields(raw: unknown): Pick<FactView, 'acquisitionDepartmentId' | 'quickCancel' | 'agentIds' | 'tagIds' | 'invitationId'> {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<FactSnapshot>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    acquisitionDepartmentId: typeof s.acquisitionDepartmentId === 'string' ? s.acquisitionDepartmentId : null,
    quickCancel: s.quickCancel === true,
    agentIds: strings(s.agentIds),
    tagIds: strings(s.tagIds),
    invitationId: typeof s.invitationId === 'string' ? s.invitationId : null,
  };
}

export interface TurnMessage {
  at: number;
  kind: 'visitor' | 'human';
  authorId: string | null;
}

export interface ResponseTurn {
  /** First visitor message of a contiguous visitor burst. */
  start: number;
  /** Next human public reply. */
  end: number;
  authorId: string | null;
}

/**
 * Response time between turns (ch. 50): starts at the first visitor message in a
 * contiguous visitor burst and ends at the next human public reply. Automated
 * greetings and private notes must not be passed in (they never stop the timer).
 * An unanswered final burst yields no turn (null duration, not zero).
 */
export function responseTurns(messages: readonly TurnMessage[]): ResponseTurn[] {
  const sorted = [...messages].sort((a, b) => a.at - b.at);
  const out: ResponseTurn[] = [];
  let burstStart: number | null = null;
  for (const m of sorted) {
    if (m.kind === 'visitor') {
      if (burstStart === null) burstStart = m.at;
    } else if (burstStart !== null) {
      out.push({ start: burstStart, end: m.at, authorId: m.authorId });
      burstStart = null;
    }
  }
  return out;
}

/** Total overlap (ms) of an interval with a set of intervals and a clamp window. */
export function overlapMs(a: { from: number; to: number }, windows: ReadonlyArray<{ from: number; to: number }>): number {
  let total = 0;
  for (const w of windows) {
    const s = Math.max(a.from, w.from);
    const e = Math.min(a.to, w.to);
    if (e > s) total += e - s;
  }
  return total;
}
