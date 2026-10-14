import { MetricsService } from '../../core/metrics.service';
import { AuditService } from '../../common/audit.service';
import { Injectable, Logger } from '@nestjs/common';
import type { AssignmentOffer, Chat, RoutingMode } from '@prisma/client';
import { selectCandidate, sortQueue, type RoutingCandidate } from '@talkivio/contracts';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AppError, conflict, denied, notFound, type AuthContext } from '../../common/http';
import { ROLE_PERMISSIONS, TENANT_WIDE_ROLES } from '../../common/permissions';
import { PresenceService } from '../../core/presence.service';
import { QueueService, QUEUES } from '../../core/queue.service';
import { deterministicEventId } from '../../outbox/outbox.service';
import { ChatStore, queueScopeId } from './chat.store';
import type { MessageResource, StaffChat } from './chat.projections';

export const OFFER_TTL_MS = 30_000;
const DECLINE_COOLDOWN_MS = 60_000;

const SERVING_ROLES = (Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>).filter((r) =>
  ROLE_PERMISSIONS[r].has('chats.serve'),
);

export interface RouteResult {
  mode: RoutingMode;
  outcome: 'offered' | 'queued' | 'unchanged';
  offerId?: string;
  candidateCount: number;
}

/**
 * Routing transaction and offers (ch. 30/31). All capacity decisions run under
 * row locks: chat first, then agent capacity rows in UUID order.
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger('Routing');

  constructor(
    private readonly db: TenantDb,
    private readonly store: ChatStore,
    private readonly presence: PresenceService,
    private readonly queues: QueueService,
    private readonly metrics: MetricsService,
    private readonly audit: AuditService,
  ) {}

  async modeFor(tx: Tx, chat: Chat): Promise<RoutingMode> {
    if (chat.departmentId) {
      const d = await tx.department.findUnique({
        where: { id: chat.departmentId },
        select: { routingMode: true },
      });
      if (d) return d.routingMode;
    }
    const settings = await this.store.settings(tx, chat.tenantId);
    return settings.routing.mode === 'ASSIGNED' ? 'assigned' : 'broadcast';
  }

  /** Candidates: enabled, serving role, desired online, live connection, department member. */
  async candidates(tx: Tx, chat: Chat, exclude: string[]): Promise<RoutingCandidate[]> {
    const connected = await this.presence.connectedAgentIds(chat.tenantId);
    if (!connected.size) return [];
    const members = await tx.membership.findMany({
      where: {
        tenantId: chat.tenantId,
        enabled: true,
        archivedAt: null,
        desiredStatus: 'online',
        role: { in: SERVING_ROLES },
        id: { in: [...connected].filter((id) => !exclude.includes(id)) },
        ...(chat.departmentId
          ? { departments: { some: { departmentId: chat.departmentId, canServe: true } } }
          : {}),
      },
    });
    const cooled = await tx.assignmentOffer.findMany({
      where: {
        tenantId: chat.tenantId,
        chatId: chat.id,
        status: { in: ['declined', 'expired'] },
        decidedAt: { gt: new Date(Date.now() - DECLINE_COOLDOWN_MS) },
      },
      select: { membershipId: true },
    });
    const cooledIds = new Set(cooled.map((c) => c.membershipId));
    const out: RoutingCandidate[] = [];
    for (const m of members) {
      if (cooledIds.has(m.id)) continue;
      const u = await this.store.usage(tx, chat.tenantId, m.id);
      out.push({
        membershipId: m.id,
        capacity: m.capacity,
        active: u.active,
        collaborations: u.collaborations,
        reserved: u.reserved,
        lastAssignmentAt: m.lastAssignmentAt?.getTime() ?? null,
      });
    }
    return out;
  }

  /** Expire stale offers on a locked chat; returns the agents whose offers expired. */
  private async expireStale(tx: Tx, chat: Chat): Promise<string[]> {
    const stale = await tx.assignmentOffer.findMany({
      where: { tenantId: chat.tenantId, chatId: chat.id, status: 'pending', expiresAt: { lte: new Date() } },
    });
    for (const o of stale) {
      await tx.assignmentOffer.update({
        where: { id: o.id },
        data: {
          status: 'expired',
          decidedAt: new Date(),
          decisionReason: 'timeout',
          version: { increment: 1 },
        },
      });
      if (o.membershipId) await this.emitWithdrawn(tx, chat, o, 'expired');
    }
    return stale.map((o) => o.membershipId).filter((x): x is string => !!x);
  }

  /**
   * Withdraw the pending offers on a locked chat (department transfer, close, forced transfer) and tell each
   * offered agent (assignment.withdrawn), so no offer card outlives the state it was made for.
   */
  async withdrawPendingInTx(tx: Tx, chat: Chat, reason: string, mode?: 'transfer'): Promise<void> {
    const pending = await tx.assignmentOffer.findMany({
      where: { tenantId: chat.tenantId, chatId: chat.id, status: 'pending', ...(mode ? { mode } : {}) },
    });
    for (const o of pending) {
      await tx.assignmentOffer.update({
        where: { id: o.id },
        data: {
          status: 'withdrawn',
          decidedAt: new Date(),
          decisionReason: reason,
          version: { increment: 1 },
        },
      });
      await this.emitWithdrawn(tx, chat, o, reason);
    }
  }

  private async emitWithdrawn(tx: Tx, chat: Chat, o: AssignmentOffer, reason: string): Promise<void> {
    if (!o.membershipId) return;
    await this.store.outboxService().append(tx, chat.tenantId, {
      aggregateType: 'offer',
      aggregateId: o.id,
      aggregateVersion: o.version + 1,
      eventType: 'assignment.withdrawn',
      payload: { offerId: o.id, chatId: chat.id, reason },
      scopes: [{ kind: 'agent', id: o.membershipId, audience: 'staff' }],
    });
  }

  /** Route a queued/offered chat. Safe to call repeatedly (no-op when not routable). */
  async route(
    tenantId: string,
    chatId: string,
    opts: { exclude?: string[]; causationId?: string | null } = {},
  ): Promise<RouteResult> {
    const started = process.hrtime.bigint();
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.db.tx(tenantId, async (tx) => {
        const chat = await this.store.lockChat(tx, tenantId, chatId);
        if (chat.status !== 'queued' && chat.status !== 'offered')
          return { mode: 'manual' as RoutingMode, outcome: 'unchanged' as const, candidateCount: 0 };
        const expiredFor = await this.expireStale(tx, chat);
        const live = await tx.assignmentOffer.findFirst({
          where: { tenantId, chatId, status: 'pending', mode: { in: ['assigned', 'transfer'] } },
        });
        const mode = await this.modeFor(tx, chat);
        if (live) return { mode, outcome: 'unchanged' as const, offerId: live.id, candidateCount: 0 };
        if (mode !== 'assigned') {
          if (chat.status !== 'queued') {
            await this.store.bumpVersion(tx, chat, { status: 'queued' });
            await this.store.emitChatUpdated(tx, chat, opts.causationId ?? null);
          }
          await this.emitQueued(tx, chat, mode, opts.causationId ?? null);
          return { mode, outcome: 'queued' as const, candidateCount: 0 };
        }
        const candidates = await this.candidates(tx, chat, [...(opts.exclude ?? []), ...expiredFor]);
        const pick = selectCandidate(candidates);
        if (!pick) {
          if (chat.status !== 'queued') {
            await this.store.bumpVersion(tx, chat, { status: 'queued' });
            await this.store.emitChatUpdated(tx, chat, opts.causationId ?? null);
          }
          await this.history(tx, chat, null, 'queued_no_candidate', {
            mode,
            candidateCount: candidates.length,
          });
          await this.emitQueued(tx, chat, mode, opts.causationId ?? null);
          return { mode, outcome: 'queued' as const, candidateCount: candidates.length };
        }
        await this.store.lockCapacity(tx, tenantId, [pick.membershipId]);
        const member = await tx.membership.findUniqueOrThrow({ where: { id: pick.membershipId } });
        const u = await this.store.usage(tx, tenantId, pick.membershipId);
        if (u.active + u.collaborations + u.reserved >= member.capacity) return null; // race: retry
        const offer = await tx.assignmentOffer.create({
          data: {
            tenantId,
            chatId,
            membershipId: pick.membershipId,
            mode: 'assigned',
            expiresAt: new Date(Date.now() + OFFER_TTL_MS),
          },
        });
        await this.store.bumpVersion(tx, chat, { status: 'offered' });
        const staff = await this.store.staff(tx, tenantId, chatId);
        await this.store.outboxService().append(tx, tenantId, {
          aggregateType: 'offer',
          aggregateId: offer.id,
          aggregateVersion: 1,
          eventType: 'assignment.offered',
          payload: { offer: offerResource(offer), chatPreview: staff, expiresAt: offer.expiresAt },
          scopes: [{ kind: 'agent', id: pick.membershipId, audience: 'staff' }],
          causationId: opts.causationId ?? null,
        });
        await this.store.emitChatUpdated(tx, chat, opts.causationId ?? null);
        await this.history(tx, chat, null, 'offered', {
          mode,
          offerId: offer.id,
          candidate: pick.membershipId,
          candidateCount: candidates.length,
        });
        return { mode, outcome: 'offered' as const, offerId: offer.id, candidateCount: candidates.length };
      });
      if (result) {
        if (result.outcome === 'offered' && result.offerId) {
          this.metrics.offerSeconds.observe(
            this.metrics.labels({ mode: result.mode }),
            Number(process.hrtime.bigint() - started) / 1e9,
          );
          await this.queues.add(
            QUEUES.timers,
            'offer-expiry',
            { tenantId, offerId: result.offerId },
            { delay: OFFER_TTL_MS + 500, jobId: `offer-${result.offerId}` },
          );
        }
        return result;
      }
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
    }
    return { mode: 'assigned', outcome: 'queued', candidateCount: 0 };
  }

  /**
   * Internal `chat.queued` (trigger DSL event): emitted once per queued chat
   * version, so repeated routing passes over an unchanged chat never refire it.
   */
  private async emitQueued(tx: Tx, chat: Chat, mode: RoutingMode, causationId: string | null): Promise<void> {
    await this.store.outboxService().append(tx, chat.tenantId, {
      aggregateType: 'chat',
      aggregateId: chat.id,
      aggregateVersion: chat.version,
      eventType: 'chat.queued',
      payload: { chatId: chat.id, departmentId: chat.departmentId, mode, requestedAt: chat.requestedAt },
      scopes: [],
      causationId,
      eventId: deterministicEventId(`chat.queued:${chat.id}:${chat.version}`),
    });
  }

  private async history(
    tx: Tx,
    chat: Chat,
    nextOwner: string | null,
    reason: string,
    decision: Record<string, unknown>,
    prevOwner: string | null = null,
    prevDept?: string | null,
    nextDept?: string | null,
  ) {
    await tx.assignmentHistory.create({
      data: {
        tenantId: chat.tenantId,
        chatId: chat.id,
        previousOwnerId: prevOwner,
        nextOwnerId: nextOwner,
        previousDepartmentId: prevDept ?? chat.departmentId,
        nextDepartmentId: nextDept ?? chat.departmentId,
        reason,
        decision: decision as object,
      },
    });
  }

  /** Can this actor serve chats of the chat's department? */
  assertCanServe(auth: AuthContext, chat: Chat): void {
    if (!auth.permissions.has('chats.serve') || !auth.membershipId) throw denied('You cannot accept chats');
    if (
      chat.departmentId &&
      !TENANT_WIDE_ROLES.has(auth.role) &&
      !auth.servedDepartmentIds.includes(chat.departmentId)
    ) {
      throw denied('This chat belongs to a department you do not serve');
    }
  }

  /**
   * Agent-started chat (ChatCommandsService.agentStart): created active and owned by the agent — within their
   * capacity, in the site's default department when they serve it (otherwise their first served department) —
   * with the agent's first message. The visitor's tab gets `chat.opened_by_agent` (the widget opens on it); staff
   * views get the usual participant.joined / chat.updated, and nobody else is alerted.
   */
  async startByAgent(
    auth: AuthContext,
    input: {
      visitorId: string;
      sessionId: string;
      siteId: string;
      pageUrl: string | null;
      body: string;
      clientMessageId: string;
    },
  ): Promise<{ chat: StaffChat; message: MessageResource }> {
    if (!auth.permissions.has('chats.serve') || !auth.membershipId) throw denied('You cannot start chats');
    const me = auth.membershipId;
    const tenantId = auth.tenantId;
    return this.db.tx(tenantId, async (tx) => {
      const settings = await this.store.settings(tx, tenantId);
      const site = await tx.site.findFirstOrThrow({
        where: { tenantId, id: input.siteId },
        select: { defaultDepartmentId: true },
      });
      const tenantWide = TENANT_WIDE_ROLES.has(auth.role);
      const preferred = site.defaultDepartmentId;
      const departmentId =
        preferred && (tenantWide || auth.servedDepartmentIds.includes(preferred))
          ? preferred
          : tenantWide
            ? preferred
            : (auth.servedDepartmentIds[0] ?? null);

      await this.store.lockCapacity(tx, tenantId, [me]);
      const member = await tx.membership.findUniqueOrThrow({ where: { id: me }, include: { user: true } });
      const u = await this.store.usage(tx, tenantId, me);
      if (u.active + u.collaborations + u.reserved >= member.capacity)
        throw conflict('CAPACITY_EXCEEDED', 'Your chat capacity is full.');
      // The visitor may have opened a chat meanwhile: one open chat per visitor and site.
      const open = await tx.chat.findFirst({
        where: { tenantId, visitorId: input.visitorId, siteId: input.siteId, status: { not: 'closed' } },
        select: { id: true },
      });
      if (open)
        throw conflict('CHAT_EXISTS', 'This visitor already has an open chat', false, { chat_id: open.id });

      const [{ chat_counter }] = await tx.$queryRaw<Array<{ chat_counter: number }>>`
        UPDATE tenants SET chat_counter = chat_counter + 1 WHERE id = ${tenantId}::uuid RETURNING chat_counter`;
      await tx.visitor.update({
        where: { id: input.visitorId },
        data: { chatCount: { increment: 1 }, lastSeenAt: new Date() },
      });
      const now = new Date();
      const chat = await tx.chat.create({
        data: {
          tenantId,
          number: Number(chat_counter),
          siteId: input.siteId,
          visitorId: input.visitorId,
          sessionId: input.sessionId,
          departmentId,
          acquisitionDepartmentId: departmentId,
          status: 'active',
          ownerMembershipId: me,
          firstAssignedAt: now,
          startedBy: 'agent',
          routeReason: 'agent_started',
          pageUrl: input.pageUrl?.slice(0, 2000) ?? null,
        },
      });
      await tx.chatParticipant.create({
        data: {
          tenantId,
          chatId: chat.id,
          actorType: 'visitor',
          visitorId: input.visitorId,
          role: 'visitor',
        },
      });
      await tx.chatParticipant.create({
        data: { tenantId, chatId: chat.id, actorType: 'agent', membershipId: me, role: 'primary' },
      });
      await tx.membership.update({ where: { id: me }, data: { lastAssignmentAt: now } });
      await this.history(tx, chat, me, 'agent_started', { by: me });
      await this.audit.inTx(tx, auth, {
        action: 'chat.started_by_agent',
        objectType: 'chat',
        objectId: chat.id,
        safeDiff: { visitor_id: input.visitorId, department_id: departmentId },
      });
      const name = member.displayName || member.user.displayName;
      const first = name.split(' ')[0]!;
      await this.store.systemEvent(
        tx,
        chat,
        'chat.agent_joined',
        `${first} joined the chat`,
        { membershipId: me },
        settings,
        { name: first },
      );
      const { message } = await this.store.appendMessage(
        tx,
        chat,
        {
          senderType: 'agent',
          senderMembershipId: me,
          senderName: name,
          body: input.body,
          clientMessageId: input.clientMessageId,
        },
        settings,
      );
      const joinedAt = await this.participantJoined(tx, chat, me, 'primary');
      const [ownerProfile] = await this.store.agentProfiles(tx, tenantId, [me]);
      await this.store.outboxService().append(tx, tenantId, {
        aggregateType: 'chat',
        aggregateId: chat.id,
        aggregateVersion: chat.version,
        eventType: 'chat.started',
        payload: {
          chatId: chat.id,
          ownerPublicProfile: ownerProfile ?? null,
          startedAt: joinedAt,
          version: chat.version,
        },
        scopes: [{ kind: 'chat', id: chat.id, audience: 'public' }],
      });
      // The visitor has no chat scope yet: their tab learns about the chat on its own session scope.
      const pub = await this.store.publicChat(tx, chat.id);
      await this.store.outboxService().append(tx, tenantId, {
        aggregateType: 'chat',
        aggregateId: chat.id,
        aggregateVersion: chat.version,
        eventType: 'chat.opened_by_agent',
        payload: { chat: pub },
        scopes: [{ kind: 'visitor', id: input.sessionId, audience: 'public', payload: { chat: pub } }],
      });
      await this.store.emitChatUpdated(tx, chat);
      return { chat: await this.store.staff(tx, tenantId, chat.id), message };
    });
  }

  /** Accept a queued chat (broadcast/manual pickup) or a specific offer (assigned/transfer). */
  async accept(
    auth: AuthContext,
    chatId: string,
    input: { offerId?: string | null; expectedVersion?: number | null },
  ): Promise<StaffChat> {
    const me = auth.membershipId!;
    return this.db.tx(auth.tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, auth.tenantId, chatId);
      if (chat.status === 'closed') throw conflict('CHAT_CLOSED', 'This chat has ended');
      const settings = await this.store.settings(tx, auth.tenantId);
      let offer: AssignmentOffer | null = null;
      if (input.offerId) {
        offer = await tx.assignmentOffer.findFirst({
          where: { id: input.offerId, tenantId: auth.tenantId, chatId },
        });
        if (!offer || offer.membershipId !== me)
          throw conflict('OFFER_WITHDRAWN', 'This offer is no longer available to you');
        if (offer.status !== 'pending')
          throw conflict(
            offer.status === 'expired' ? 'OFFER_EXPIRED' : 'OFFER_WITHDRAWN',
            'This offer is no longer available',
          );
        if (offer.expiresAt <= new Date()) throw conflict('OFFER_EXPIRED', 'This offer has expired');
      }
      if (offer?.mode === 'transfer') return this.acceptTransfer(tx, auth, chat, offer, settings);

      if (chat.status === 'active') {
        if (chat.ownerMembershipId === me) return this.store.staff(tx, auth.tenantId, chatId);
        throw conflict('CHAT_ALREADY_ASSIGNED', 'Another agent already accepted this chat', false, {
          owner_membership_id: chat.ownerMembershipId,
        });
      }
      if (input.expectedVersion && input.expectedVersion !== chat.version && !offer) {
        // Stale UI is acceptable for pickup as long as the chat is still queued; the
        // version check matters only when the state changed in a way that conflicts.
      }
      this.assertCanServe(auth, chat);
      const live = await tx.assignmentOffer.findFirst({
        where: {
          tenantId: auth.tenantId,
          chatId,
          status: 'pending',
          mode: { in: ['assigned', 'transfer'] },
          expiresAt: { gt: new Date() },
        },
      });
      if (live && live.membershipId !== me)
        throw conflict('CHAT_ALREADY_ASSIGNED', 'This chat is currently offered to another agent', true);

      await this.store.lockCapacity(tx, auth.tenantId, [me]);
      const member = await tx.membership.findUniqueOrThrow({ where: { id: me } });
      const u = await this.store.usage(tx, auth.tenantId, me, offer?.id ?? live?.id);
      if (u.active + u.collaborations + u.reserved >= member.capacity)
        throw conflict('CAPACITY_EXCEEDED', 'Your chat capacity is full.');

      const others = await tx.assignmentOffer.findMany({
        where: {
          tenantId: auth.tenantId,
          chatId,
          status: 'pending',
          NOT: { id: offer?.id ?? live?.id ?? '00000000-0000-0000-0000-000000000000' },
        },
      });
      for (const o of others) {
        await tx.assignmentOffer.update({
          where: { id: o.id },
          data: {
            status: 'withdrawn',
            decidedAt: new Date(),
            decisionReason: 'accepted_elsewhere',
            version: { increment: 1 },
          },
        });
        await this.emitWithdrawn(tx, chat, o, 'accepted_elsewhere');
      }
      const acceptedOfferId = offer?.id ?? live?.id ?? null;
      if (acceptedOfferId)
        await tx.assignmentOffer.update({
          where: { id: acceptedOfferId },
          data: { status: 'accepted', decidedAt: new Date(), version: { increment: 1 } },
        });

      const now = new Date();
      await this.store.bumpVersion(tx, chat, {
        status: 'active',
        ownerMembershipId: me,
        firstAssignedAt: chat.firstAssignedAt ?? now,
      });
      await tx.chatParticipant.create({
        data: { tenantId: auth.tenantId, chatId, actorType: 'agent', membershipId: me, role: 'primary' },
      });
      await tx.membership.update({ where: { id: me }, data: { lastAssignmentAt: now } });
      await this.history(tx, chat, me, acceptedOfferId ? 'offer_accepted' : 'picked_up', {
        offerId: acceptedOfferId,
      });
      const name =
        member.displayName || (await tx.user.findUniqueOrThrow({ where: { id: member.userId } })).displayName;
      await this.store.systemEvent(
        tx,
        chat,
        'chat.agent_joined',
        `${name.split(' ')[0]} joined the chat`,
        { membershipId: me },
        settings,
        { name: name.split(' ')[0]! },
      );
      await this.store.outboxService().append(tx, auth.tenantId, {
        aggregateType: 'chat',
        aggregateId: chatId,
        aggregateVersion: chat.version,
        eventType: 'assignment.accepted',
        payload: { chatId, offerId: acceptedOfferId, ownerMembershipId: me, version: chat.version },
        scopes: [
          { kind: 'queue', id: queueScopeId(chat.departmentId), audience: 'staff' },
          { kind: 'agent', id: me, audience: 'staff' },
        ],
      });
      const joinedAt = await this.participantJoined(tx, chat, me, 'primary');
      // Visitor-facing projection of the assignment (ch. 48): who joined, never the selection trace.
      const [ownerProfile] = await this.store.agentProfiles(tx, auth.tenantId, [me]);
      await this.store.outboxService().append(tx, auth.tenantId, {
        aggregateType: 'chat',
        aggregateId: chatId,
        aggregateVersion: chat.version,
        eventType: 'chat.started',
        payload: {
          chatId,
          ownerPublicProfile: ownerProfile ?? null,
          startedAt: joinedAt,
          version: chat.version,
        },
        scopes: [{ kind: 'chat', id: chatId, audience: 'public' }],
      });
      await this.store.emitChatUpdated(tx, chat);
      return this.store.staff(tx, auth.tenantId, chatId);
    });
  }

  private async participantJoined(
    tx: Tx,
    chat: Chat,
    membershipId: string,
    role: 'primary' | 'collaborator',
  ): Promise<Date> {
    const [profile] = await this.store.agentProfiles(tx, chat.tenantId, [membershipId]);
    const joinedAt = new Date();
    await this.store.outboxService().append(tx, chat.tenantId, {
      aggregateType: 'chat',
      aggregateId: chat.id,
      aggregateVersion: chat.version,
      eventType: 'participant.joined',
      payload: { chatId: chat.id, participant: { membershipId, ...profile }, role, joinedAt },
      scopes: [
        { kind: 'chat', id: chat.id, audience: 'staff' },
        {
          kind: 'chat',
          id: chat.id,
          audience: 'public',
          payload: { chatId: chat.id, participant: profile, role, joinedAt },
        },
      ],
    });
    return joinedAt;
  }

  private async acceptTransfer(
    tx: Tx,
    auth: AuthContext,
    chat: Chat,
    offer: AssignmentOffer,
    settings: Awaited<ReturnType<ChatStore['settings']>>,
  ): Promise<StaffChat> {
    const me = auth.membershipId!;
    if (chat.status !== 'active') throw conflict('OFFER_WITHDRAWN', 'This chat is no longer active');
    // The offer hands over the chat from the owner it was made for; if ownership moved since, it is void.
    const origin = await tx.assignmentHistory.findFirst({
      where: {
        tenantId: auth.tenantId,
        chatId: chat.id,
        reason: 'transfer_offered',
        decision: { path: ['offerId'], equals: offer.id },
      },
    });
    if (origin && origin.previousOwnerId !== chat.ownerMembershipId)
      throw conflict('OFFER_WITHDRAWN', 'This chat has changed hands since the transfer was offered');
    const previous = chat.ownerMembershipId;
    await this.store.lockCapacity(tx, auth.tenantId, [me, ...(previous ? [previous] : [])]);
    const member = await tx.membership.findUniqueOrThrow({ where: { id: me }, include: { user: true } });
    const u = await this.store.usage(tx, auth.tenantId, me, offer.id);
    const alreadyCollaborator = await tx.chatParticipant.findFirst({
      where: { tenantId: auth.tenantId, chatId: chat.id, membershipId: me, leftAt: null },
    });
    const used = u.active + u.collaborations + u.reserved - (alreadyCollaborator ? 1 : 0);
    if (used >= member.capacity) throw conflict('CAPACITY_EXCEEDED', 'Your chat capacity is full.');
    await tx.assignmentOffer.update({
      where: { id: offer.id },
      data: { status: 'accepted', decidedAt: new Date(), version: { increment: 1 } },
    });
    if (previous)
      await tx.chatParticipant.updateMany({
        where: { tenantId: auth.tenantId, chatId: chat.id, membershipId: previous, leftAt: null },
        data: { leftAt: new Date() },
      });
    if (alreadyCollaborator)
      await tx.chatParticipant.update({
        where: { id: alreadyCollaborator.id },
        data: { leftAt: new Date() },
      });
    await tx.chatParticipant.create({
      data: {
        tenantId: auth.tenantId,
        chatId: chat.id,
        actorType: 'agent',
        membershipId: me,
        role: 'primary',
      },
    });
    await this.store.bumpVersion(tx, chat, { ownerMembershipId: me });
    await tx.membership.update({ where: { id: me }, data: { lastAssignmentAt: new Date() } });
    await this.history(tx, chat, me, 'transfer_accepted', { offerId: offer.id }, previous);
    const name = (member.displayName || member.user.displayName).split(' ')[0];
    await this.store.systemEvent(
      tx,
      chat,
      'chat.transferred',
      `You're now chatting with ${name}`,
      { from: previous, to: me },
      settings,
      { variant: 'agent', name },
    );
    const [profile] = await this.store.agentProfiles(tx, auth.tenantId, [me]);
    await this.store.outboxService().append(tx, auth.tenantId, {
      aggregateType: 'chat',
      aggregateId: chat.id,
      aggregateVersion: chat.version,
      eventType: 'chat.transferred',
      payload: {
        chatId: chat.id,
        previousOwner: previous,
        nextOwner: me,
        departmentId: chat.departmentId,
        version: chat.version,
      },
      scopes: [
        { kind: 'chat', id: chat.id, audience: 'staff' },
        ...(previous ? [{ kind: 'agent' as const, id: previous, audience: 'staff' as const }] : []),
        { kind: 'agent', id: me, audience: 'staff' },
        {
          kind: 'chat',
          id: chat.id,
          audience: 'public',
          payload: { chatId: chat.id, nextOwner: profile, version: chat.version },
        },
      ],
    });
    await this.store.emitChatUpdated(tx, chat, null, previous ? [previous] : []);
    return this.store.staff(tx, auth.tenantId, chat.id);
  }

  async decline(auth: AuthContext, offerId: string, reason?: string): Promise<{ ok: true }> {
    const me = auth.membershipId;
    const offer = await this.db.read(auth.tenantId, (tx) =>
      tx.assignmentOffer.findFirst({ where: { id: offerId, tenantId: auth.tenantId } }),
    );
    // Unknown here (including another workspace's offer, hidden by RLS) is a uniform 404; someone else's offer in this
    // workspace is a conflict, like an offer that was withdrawn.
    if (!offer) throw notFound('Offer');
    if (offer.membershipId !== me)
      throw conflict('OFFER_WITHDRAWN', 'This offer is no longer available to you');
    let reroute = false;
    await this.db.tx(auth.tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, auth.tenantId, offer.chatId);
      const current = await tx.assignmentOffer.findUniqueOrThrow({ where: { id: offerId } });
      if (current.status !== 'pending') return;
      await tx.assignmentOffer.update({
        where: { id: offerId },
        data: {
          status: 'declined',
          decidedAt: new Date(),
          decisionReason: reason?.slice(0, 200) ?? 'declined',
          version: { increment: 1 },
        },
      });
      await this.emitWithdrawn(tx, chat, current, 'declined');
      if (current.mode === 'assigned' && chat.status === 'offered') {
        await this.store.bumpVersion(tx, chat, { status: 'queued' });
        await this.store.emitChatUpdated(tx, chat);
        reroute = true;
      }
      if (current.mode === 'transfer' && current.fromMembershipId) {
        await this.store.outboxService().append(tx, auth.tenantId, {
          aggregateType: 'offer',
          aggregateId: current.id,
          aggregateVersion: current.version + 1,
          eventType: 'transfer.declined',
          payload: { offerId: current.id, chatId: chat.id, reason: reason ?? 'declined' },
          scopes: [{ kind: 'agent', id: current.fromMembershipId, audience: 'staff' }],
        });
      }
    });
    if (reroute) await this.route(auth.tenantId, offer.chatId, { exclude: me ? [me] : [] });
    return { ok: true };
  }

  /** Timer: expire one offer if it is still pending past its deadline, then re-route. */
  async expireOffer(tenantId: string, offerId: string): Promise<void> {
    let chatId: string | null = null;
    let excluded: string | null = null;
    let notifyFrom: string | null = null;
    await this.db.tx(tenantId, async (tx) => {
      const offer = await tx.assignmentOffer.findFirst({ where: { id: offerId, tenantId } });
      if (!offer || offer.status !== 'pending') return;
      const chat = await this.store.lockChat(tx, tenantId, offer.chatId);
      const fresh = await tx.assignmentOffer.findUniqueOrThrow({ where: { id: offerId } });
      if (fresh.status !== 'pending' || fresh.expiresAt > new Date()) return;
      await tx.assignmentOffer.update({
        where: { id: offerId },
        data: {
          status: 'expired',
          decidedAt: new Date(),
          decisionReason: 'timeout',
          version: { increment: 1 },
        },
      });
      await this.emitWithdrawn(tx, chat, fresh, 'expired');
      if (fresh.mode === 'assigned' && chat.status === 'offered') {
        await this.store.bumpVersion(tx, chat, { status: 'queued' });
        await this.store.emitChatUpdated(tx, chat);
        chatId = chat.id;
        excluded = fresh.membershipId;
      }
      if (fresh.mode === 'transfer') notifyFrom = fresh.fromMembershipId;
      if (notifyFrom) {
        await this.store.outboxService().append(tx, tenantId, {
          aggregateType: 'offer',
          aggregateId: fresh.id,
          aggregateVersion: fresh.version + 1,
          eventType: 'transfer.expired',
          payload: { offerId: fresh.id, chatId: chat.id },
          scopes: [{ kind: 'agent', id: notifyFrom, audience: 'staff' }],
        });
      }
    });
    if (chatId) await this.route(tenantId, chatId, { exclude: excluded ? [excluded] : [] });
  }

  /**
   * Re-route queued chats for a tenant (agent came online, capacity freed, timers) in queue order: aged
   * effective priority (min(100, base + 1 per minute waited)) desc, requested_at asc, id asc — the same
   * order the Unassigned list shows (sortQueue), so the limit never skips a chat that has aged past others.
   */
  async drainQueue(tenantId: string, limit = 100): Promise<number> {
    const now = new Date();
    const rows = await this.db.read(
      tenantId,
      (tx) =>
        tx.$queryRaw<Array<{ id: string; priority: number; requested_at: Date }>>`
        SELECT id, priority, requested_at FROM chats
        WHERE tenant_id = ${tenantId}::uuid AND status = 'queued' AND NOT is_preview
        ORDER BY LEAST(100, priority + floor(GREATEST(0, extract(epoch FROM (${now}::timestamptz - requested_at))) / 60)) DESC, requested_at ASC, id ASC
        LIMIT ${limit}`,
    );
    const queued = sortQueue(
      rows.map((r) => ({ id: r.id, priority: r.priority, requestedAt: r.requested_at.getTime() })),
      now.getTime(),
    );
    let offered = 0;
    for (const c of queued) {
      try {
        const r = await this.route(tenantId, c.id);
        if (r.outcome === 'offered') offered++;
      } catch (err) {
        this.logger.warn(`drainQueue route ${c.id} failed: ${(err as Error).message}`);
      }
    }
    return offered;
  }

  /**
   * An agent can no longer serve (suspended): their active chats go back to the same
   * department queue and are re-routed to someone else; collaborations end. Each chat is
   * handled in its own transaction under the chat lock, like a department transfer.
   */
  async releaseAgentChats(
    tenantId: string,
    membershipId: string,
    reason: 'agent_suspended',
    causationId: string | null = null,
  ): Promise<number> {
    const [owned, collaborating] = await this.db.read(tenantId, async (tx) => [
      await tx.chat.findMany({
        where: { tenantId, ownerMembershipId: membershipId, status: 'active' },
        select: { id: true },
      }),
      await tx.chatParticipant.findMany({
        where: { tenantId, membershipId, role: 'collaborator', leftAt: null },
        select: { chatId: true },
      }),
    ]);
    let released = 0;
    for (const { id } of owned) {
      const requeued = await this.db.tx(tenantId, async (tx) => {
        const chat = await this.store.lockChat(tx, tenantId, id);
        if (chat.status !== 'active' || chat.ownerMembershipId !== membershipId) return false;
        const settings = await this.store.settings(tx, tenantId);
        await tx.chatParticipant.updateMany({
          where: { tenantId, chatId: id, membershipId, leftAt: null },
          data: { leftAt: new Date() },
        });
        await this.store.bumpVersion(tx, chat, { ownerMembershipId: null, status: 'queued' });
        await tx.assignmentHistory.create({
          data: {
            tenantId,
            chatId: id,
            previousOwnerId: membershipId,
            nextOwnerId: null,
            previousDepartmentId: chat.departmentId,
            nextDepartmentId: chat.departmentId,
            reason,
            decision: {},
          },
        });
        await this.store.systemEvent(
          tx,
          chat,
          'chat.transferred',
          "You're being connected to another agent",
          { reason },
          settings,
          { variant: 'reconnecting' },
        );
        await this.store.outboxService().append(tx, tenantId, {
          aggregateType: 'chat',
          aggregateId: id,
          aggregateVersion: chat.version,
          eventType: 'chat.transferred',
          payload: {
            chatId: id,
            previousOwner: membershipId,
            nextOwner: null,
            departmentId: chat.departmentId,
            version: chat.version,
            reason,
          },
          scopes: [
            { kind: 'chat', id, audience: 'staff' },
            { kind: 'queue', id: queueScopeId(chat.departmentId), audience: 'staff' },
            { kind: 'agent', id: membershipId, audience: 'staff' },
            {
              kind: 'chat',
              id,
              audience: 'public',
              payload: { chatId: id, nextOwner: null, version: chat.version },
            },
          ],
          causationId,
        });
        await this.store.emitChatUpdated(tx, chat, causationId, [membershipId]);
        return true;
      });
      if (!requeued) continue;
      released++;
      await this.route(tenantId, id, { exclude: [membershipId], causationId }).catch((err) =>
        this.logger.warn(`releaseAgentChats route ${id} failed: ${(err as Error).message}`),
      );
    }
    for (const { chatId } of collaborating) {
      await this.db.tx(tenantId, async (tx) => {
        const chat = await this.store.lockChat(tx, tenantId, chatId);
        const r = await tx.chatParticipant.updateMany({
          where: { tenantId, chatId, membershipId, role: 'collaborator', leftAt: null },
          data: { leftAt: new Date() },
        });
        if (!r.count) return;
        await this.store.bumpVersion(tx, chat, {});
        await this.store.emitChatUpdated(tx, chat, causationId, [membershipId]);
      });
    }
    return released;
  }

  /** Withdraw pending offers for an agent who went away/offline (ch. 09). */
  async withdrawOffersFor(tenantId: string, membershipId: string, reason: string): Promise<void> {
    const offers = await this.db.read(tenantId, (tx) =>
      tx.assignmentOffer.findMany({ where: { tenantId, membershipId, status: 'pending' } }),
    );
    for (const o of offers) {
      await this.db.tx(tenantId, async (tx) => {
        const chat = await this.store.lockChat(tx, tenantId, o.chatId);
        const fresh = await tx.assignmentOffer.findUniqueOrThrow({ where: { id: o.id } });
        if (fresh.status !== 'pending') return;
        await tx.assignmentOffer.update({
          where: { id: o.id },
          data: {
            status: 'withdrawn',
            decidedAt: new Date(),
            decisionReason: reason,
            version: { increment: 1 },
          },
        });
        await this.emitWithdrawn(tx, chat, fresh, reason);
        if (fresh.mode === 'assigned' && chat.status === 'offered') {
          await this.store.bumpVersion(tx, chat, { status: 'queued' });
          await this.store.emitChatUpdated(tx, chat);
        }
      });
      await this.route(tenantId, o.chatId, { exclude: [membershipId] }).catch(() => undefined);
    }
  }
}

export function offerResource(o: AssignmentOffer) {
  return {
    id: o.id,
    chatId: o.chatId,
    mode: o.mode,
    targetMembershipId: o.membershipId,
    fromMembershipId: o.fromMembershipId,
    targetDepartmentId: o.targetDepartmentId,
    note: o.note,
    expiresAt: o.expiresAt,
    status: o.status,
    version: o.version,
  };
}

export class RoutingError extends AppError {}
