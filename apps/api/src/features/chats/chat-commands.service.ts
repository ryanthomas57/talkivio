import { Injectable, Logger } from '@nestjs/common';
import type { Chat } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { encrypt, sha256, emailLookupHash } from '../../common/crypto';
import {
  AppError,
  badRequest,
  conflict,
  denied,
  notFound,
  type AuthContext,
  type VisitorContext,
} from '../../common/http';
import { IdempotencyService } from '../../common/idempotency';
import { AuditService } from '../../common/audit.service';
import { TENANT_WIDE_ROLES } from '../../common/permissions';
import { PresenceService } from '../../core/presence.service';
import { QueueService, QUEUES } from '../../core/queue.service';
import { AvailabilityService } from '../availability/availability.service';
import { PresenceReader } from '../visitors/presence-reader';
import { ipBanFilter } from '../visitors/visitor-common';
import { ChatStore, queueScopeId, assertSameSender } from './chat.store';
import {
  messageInclude,
  messageResource,
  visitorDisplayName,
  type MessageResource,
  type PublicChat,
  type StaffChat,
} from './chat.projections';
import { OFFER_TTL_MS, offerResource, RoutingService } from './routing.service';

export const RATING_WINDOW_MS = 24 * 3600 * 1000;
const COLLABORATION_SLOTS = 1;

export interface AdmissionInput {
  clientRequestId: string;
  message?: string | null;
  departmentId?: string | null;
  fields?: { name?: string; email?: string; phone?: string };
  /** Automated invitation message shown before the visitor's first message (invitations). */
  invitation?: { id: string; message: string; attribution: string } | null;
  pageUrl?: string | null;
}

export interface AgentMessageInput {
  clientMessageId: string;
  visibility: 'public' | 'internal';
  body?: string | null;
  attachmentIds?: string[];
  replyId?: string | null;
  options?: string[];
}

export type CloseActor =
  | { kind: 'agent'; auth: AuthContext }
  | { kind: 'visitor'; visitor: VisitorContext }
  | { kind: 'system'; tenantId: string; causationId?: string | null };

export type AdmissionGuard = (
  v: VisitorContext,
  input: { departmentId: string | null; message: string | null },
) => Promise<{ blocked: boolean; source: string }>;

/** Chat commands (ch. 12–16). Every mutation persists and appends outbox events in one transaction. */
@Injectable()
export class ChatCommandsService {
  private readonly logger = new Logger('ChatCommands');
  /** Synchronous admission policies (e.g. trigger `block_admission`), checked before the chat row exists. */
  private readonly admissionGuards: AdmissionGuard[] = [];

  constructor(
    private readonly db: TenantDb,
    private readonly store: ChatStore,
    private readonly routing: RoutingService,
    private readonly availability: AvailabilityService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
    private readonly presence: PresenceService,
    private readonly queues: QueueService,
    private readonly presenceReader: PresenceReader,
  ) {}

  /** Register a policy evaluated on every new admission (features register in onModuleInit). */
  registerAdmissionGuard(guard: AdmissionGuard): void {
    this.admissionGuards.push(guard);
  }

  // ════════════════════════ Admission (visitor) ════════════════════════

  async admit(
    v: VisitorContext,
    input: AdmissionInput,
  ): Promise<{ status: number; body: { chat: PublicChat; initialMessage: MessageResource | null } }> {
    const run = await this.idempotency.run(
      v.tenantId,
      `visitor:${v.visitorId}`,
      'widget.chats.create',
      input.clientRequestId.length >= 16
        ? input.clientRequestId
        : `req-${input.clientRequestId.padEnd(16, '0')}`,
      input,
      async () => {
        await this.assertNotBanned(v);
        const existing = await this.db.read(v.tenantId, (tx) =>
          tx.chat.findFirst({
            where: {
              tenantId: v.tenantId,
              visitorId: v.visitorId,
              siteId: v.siteId,
              status: { not: 'closed' },
            },
            orderBy: { requestedAt: 'desc' },
          }),
        );
        if (existing) {
          const chat = await this.db.read(v.tenantId, (tx) => this.store.publicChat(tx, existing.id));
          return { status: 200, body: { chat, initialMessage: null } };
        }
        const body = input.message?.trim() ?? '';
        if (!body && !input.invitation)
          throw badRequest('Write a message to start the chat', { message: ['Required'] });
        if (body.length > 8000)
          throw badRequest('Message is too long', { message: ['Maximum 8000 characters'] });
        for (const guard of this.admissionGuards) {
          const verdict = await guard(v, { departmentId: input.departmentId ?? null, message: body || null });
          if (verdict.blocked) {
            this.logger.log(`Admission blocked for visitor ${v.visitorId} by ${verdict.source}`);
            // Neutral wording: the visitor is never told which rule applied (ch. 24/32).
            throw new AppError(403, 'PERMISSION_DENIED', 'Chat is not available right now');
          }
        }

        const avail = await this.availability.forSite(v.tenantId, v.siteId);
        const site = await this.db.read(v.tenantId, (tx) =>
          tx.site.findUniqueOrThrow({ where: { id: v.siteId } }),
        );
        let departmentId = input.departmentId ?? site.defaultDepartmentId ?? null;
        if (departmentId) {
          const dept = avail.departments.find((d) => d.id === departmentId);
          if (!dept)
            throw conflict('DEPARTMENT_UNAVAILABLE', 'That department is not available', false, {
              departments: avail.departments.map((d) => ({ id: d.id, label: d.label, state: d.state })),
            });
          if (dept.state === 'offline' || (dept.state === 'busy' && !dept.acceptsQueue)) {
            throw conflict('DEPARTMENT_UNAVAILABLE', `${dept.label} is not available right now`, false, {
              reason: dept.reason,
              next_open_at: dept.nextOpenAt,
              departments: avail.departments.map((d) => ({ id: d.id, label: d.label, state: d.state })),
              offline_form: true,
            });
          }
        } else if (avail.state === 'offline' || (avail.state === 'busy' && !avail.acceptsQueue)) {
          throw conflict('DEPARTMENT_UNAVAILABLE', 'No one is available right now', false, {
            reason: avail.reason,
            next_open_at: avail.nextOpenAt,
            offline_form: true,
          });
        }

        const result = await this.db.tx(v.tenantId, async (tx) => {
          const settings = await this.store.settings(tx, v.tenantId);
          const [{ chat_counter }] = await tx.$queryRaw<Array<{ chat_counter: number }>>`
          UPDATE tenants SET chat_counter = chat_counter + 1 WHERE id = ${v.tenantId}::uuid RETURNING chat_counter`;
          if (input.fields) await this.applyProfile(tx, v, input.fields);
          const visitor = await tx.visitor.update({
            where: { id: v.visitorId },
            data: { chatCount: { increment: 1 }, lastSeenAt: new Date() },
          });
          const chat = await tx.chat.create({
            data: {
              tenantId: v.tenantId,
              number: Number(chat_counter),
              siteId: v.siteId,
              visitorId: v.visitorId,
              sessionId: v.sessionId,
              departmentId,
              acquisitionDepartmentId: departmentId,
              status: 'queued',
              startedBy: input.invitation ? 'invitation' : 'visitor',
              routeReason: input.invitation
                ? 'invitation_accepted'
                : input.departmentId
                  ? 'department_selected'
                  : departmentId
                    ? 'site_default'
                    : 'default',
              pageUrl: input.pageUrl?.slice(0, 2000) ?? null,
            },
          });
          await tx.chatParticipant.create({
            data: {
              tenantId: v.tenantId,
              chatId: chat.id,
              actorType: 'visitor',
              visitorId: v.visitorId,
              role: 'visitor',
            },
          });
          if (input.invitation) {
            await this.store.appendMessage(
              tx,
              chat,
              {
                senderType: 'system',
                senderName: input.invitation.attribution,
                type: 'text',
                body: input.invitation.message,
                automated: true,
              },
              settings,
            );
          }
          let initial: MessageResource | null = null;
          if (body) {
            initial = (
              await this.store.appendMessage(
                tx,
                chat,
                {
                  senderType: 'visitor',
                  senderVisitorId: v.visitorId,
                  senderName: visitorDisplayName(visitor),
                  body,
                  clientMessageId: input.clientRequestId,
                },
                settings,
              )
            ).message;
          }
          const staff = await this.store.staff(tx, v.tenantId, chat.id);
          const pub = await this.store.publicChat(tx, chat.id);
          await this.store.outboxService().append(tx, v.tenantId, {
            aggregateType: 'chat',
            aggregateId: chat.id,
            aggregateVersion: chat.version,
            eventType: 'chat.requested',
            payload: {
              chat: staff,
              initialMessage: initial,
              routeReason: chat.routeReason,
              invitationId: input.invitation?.id ?? null,
            },
            scopes: [
              { kind: 'queue', id: queueScopeId(departmentId), audience: 'staff' },
              { kind: 'visitor', id: v.sessionId, audience: 'public', payload: { chat: pub } },
            ],
          });
          return { chat, initial };
        });
        await this.routing
          .route(v.tenantId, result.chat.id)
          .catch((err) => this.logger.error(`Initial routing failed: ${(err as Error).message}`));
        const chat = await this.db.read(v.tenantId, (tx) => this.store.publicChat(tx, result.chat.id));
        return { status: 201, body: { chat, initialMessage: result.initial } };
      },
    );
    return { status: run.status, body: run.body };
  }

  // ════════════════════════ Agent-started chat (Visitors list → chat window) ════════════════════════

  /**
   * An agent opens a chat with a visitor who is on the site right now (the Visitors list "click a visitor").
   * The chat starts active and owned by the agent, so it never enters the queue or alerts other agents; the
   * visitor's open tab receives `chat.opened_by_agent` and the widget opens with the agent's first message.
   */
  async agentStart(
    auth: AuthContext,
    visitorId: string,
    input: { clientRequestId: string; message: string; sessionId?: string | null },
  ) {
    const me = auth.membershipId;
    if (!me) throw denied('Only workspace members can start chats');
    const body = input.message.trim();
    if (!body) throw badRequest('Write a message to start the chat', { message: ['Required'] });
    if (body.length > 8000) throw badRequest('Message is too long', { message: ['Maximum 8000 characters'] });
    const key =
      input.clientRequestId.length >= 16
        ? input.clientRequestId
        : `req-${input.clientRequestId.padEnd(16, '0')}`;
    const run = await this.idempotency.run(
      auth.tenantId,
      `agent:${me}`,
      'visitors.chats.create',
      key,
      input,
      async () => {
        // Another workspace's visitor does not exist here (404, not an "offline" oracle).
        const known = await this.db.read(auth.tenantId, (tx) =>
          tx.visitor.findFirst({ where: { tenantId: auth.tenantId, id: visitorId }, select: { id: true } }),
        );
        if (!known) throw notFound('Visitor');
        const presence = (await this.presenceReader.read(auth.tenantId, [visitorId])).get(visitorId);
        const live = presence?.connections.map((c) => c.sessionId) ?? [];
        // A live connection is required, as for the Visitors list. A tab caught between two pages (about a second) is
        // refused with VISITOR_OFFLINE; the dashboard retries once.
        const sessionId =
          input.sessionId && live.includes(input.sessionId)
            ? input.sessionId
            : presence?.sessionId && live.includes(presence.sessionId)
              ? presence.sessionId
              : (live[0] ?? null);
        if (!sessionId) throw conflict('VISITOR_OFFLINE', 'This visitor has left the site', false);
        const session = await this.db.read(auth.tenantId, (tx) =>
          tx.visitorSession.findFirst({
            where: { tenantId: auth.tenantId, id: sessionId, visitorId, endedAt: null },
          }),
        );
        if (!session) throw conflict('VISITOR_OFFLINE', 'This visitor has left the site', false);
        const settings = await this.db.read(auth.tenantId, (tx) => this.store.settings(tx, auth.tenantId));
        // Visitors who have not agreed to analytics are not shown to agents while consent is required.
        if (settings.tracking.analyticsConsentRequired && session.analyticsConsent !== 'granted')
          throw conflict('VISITOR_OFFLINE', 'This visitor is not available to contact', false);
        await this.assertNotBanned({
          tenantId: auth.tenantId,
          visitorId,
          ipHash: null,
          ipNetHash: null,
          siteId: session.siteId,
        });
        const existing = await this.db.read(auth.tenantId, (tx) =>
          tx.chat.findFirst({
            where: { tenantId: auth.tenantId, visitorId, siteId: session.siteId, status: { not: 'closed' } },
            select: { id: true },
          }),
        );
        if (existing)
          throw conflict('CHAT_EXISTS', 'This visitor already has an open chat', false, {
            chat_id: existing.id,
          });
        const result = await this.routing.startByAgent(auth, {
          visitorId,
          sessionId,
          siteId: session.siteId,
          pageUrl: session.currentUrl,
          body,
          clientMessageId: key,
        });
        return { status: 201, body: result };
      },
    );
    return { status: run.status, body: run.body };
  }

  private async applyProfile(
    tx: Tx,
    v: VisitorContext,
    fields: { name?: string; email?: string; phone?: string },
  ) {
    const email = fields.email?.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw badRequest('Enter a valid email address', { email: ['Enter a valid email address.'] });
    // Pre-chat values are visitor-provided: they never overwrite identity-verified contact fields (ch. 25).
    const current = await tx.visitor.findUniqueOrThrow({
      where: { id: v.visitorId },
      select: { verified: true },
    });
    const contact = !current.verified;
    await tx.visitor.update({
      where: { id: v.visitorId },
      data: {
        ...(contact && fields.name?.trim() ? { name: fields.name.trim().slice(0, 100) } : {}),
        ...(contact && email
          ? { emailCiphertext: encrypt(email), emailLookupHash: emailLookupHash(email) }
          : {}),
        ...(fields.phone?.trim() ? { phoneCiphertext: encrypt(fields.phone.trim().slice(0, 40)) } : {}),
      },
    });
  }

  async assertNotBanned(
    v: Pick<VisitorContext, 'tenantId' | 'visitorId' | 'ipHash' | 'ipNetHash' | 'siteId'>,
  ): Promise<void> {
    const banned = await this.db.read(v.tenantId, (tx) =>
      tx.ban.count({
        where: {
          tenantId: v.tenantId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          AND: [
            { OR: [{ siteId: null }, { siteId: v.siteId }] },
            { OR: [{ visitorId: v.visitorId }, ...ipBanFilter(v)] },
          ],
        },
      }),
    );
    // Neutral refusal (ch. 24/76): the stable inventory code, not a ban-specific one.
    if (banned) throw new AppError(403, 'SERVICE_UNAVAILABLE', 'Service unavailable', { retryable: false });
  }

  // ════════════════════════ Messages ════════════════════════

  private async assertAttachmentsClean(
    tx: Tx,
    tenantId: string,
    chatId: string,
    ids: string[],
  ): Promise<void> {
    if (!ids.length) return;
    if (ids.length > 5)
      throw badRequest('At most 5 files per message', { attachment_ids: ['Maximum 5 files'] });
    if (new Set(ids).size !== ids.length)
      throw badRequest('Each file can be attached once', { attachment_ids: ['Duplicate file'] });
    const atts = await tx.attachment.findMany({ where: { tenantId, id: { in: ids } } });
    if (atts.length !== ids.length) throw notFound('Attachment');
    const used = await tx.messageAttachment.findMany({
      where: { tenantId, attachmentId: { in: ids } },
      select: { attachmentId: true },
    });
    if (used.length) throw conflict('CONFLICT', 'A file in this message was already sent');
    for (const a of atts) {
      if (a.chatId !== chatId || a.deletedAt) throw notFound('Attachment');
      if (a.state === 'rejected') throw conflict('FILE_REJECTED', `${a.originalName} was blocked`);
      if (a.state !== 'clean')
        throw conflict('FILE_SCAN_PENDING', `${a.originalName} is still being checked`, true);
    }
  }

  async visitorSend(
    v: VisitorContext,
    chatId: string,
    input: { clientMessageId: string; body?: string | null; attachmentIds?: string[] },
  ): Promise<MessageResource> {
    const body = input.body?.trim() ?? '';
    if (!body && !input.attachmentIds?.length) throw badRequest('Message is empty', { body: ['Required'] });
    await this.assertNotBanned(v);
    return this.db.tx(v.tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, v.tenantId, chatId);
      if (chat.visitorId !== v.visitorId || chat.siteId !== v.siteId) throw notFound('Chat');
      if (chat.status === 'closed') {
        const dup = await tx.message.findUnique({
          where: {
            tenantId_chatId_clientMessageId: {
              tenantId: v.tenantId,
              chatId,
              clientMessageId: input.clientMessageId,
            },
          },
          include: messageInclude,
        });
        if (dup) {
          assertSameSender(dup, { senderType: 'visitor', senderVisitorId: v.visitorId });
          return messageResource(dup);
        }
        throw conflict('CHAT_CLOSED', 'This chat has ended');
      }
      await this.assertAttachmentsClean(tx, v.tenantId, chatId, input.attachmentIds ?? []);
      const settings = await this.store.settings(tx, v.tenantId);
      const visitor = await tx.visitor.findUniqueOrThrow({ where: { id: v.visitorId } });
      if (chat.visitorDisconnectedAt)
        await tx.chat.update({ where: { id: chat.id }, data: { visitorDisconnectedAt: null } });
      const { message } = await this.store.appendMessage(
        tx,
        chat,
        {
          senderType: 'visitor',
          senderVisitorId: v.visitorId,
          senderName: visitorDisplayName(visitor),
          body: body || null,
          clientMessageId: input.clientMessageId,
          attachmentIds: input.attachmentIds,
        },
        settings,
      );
      return message;
    });
  }

  /** Is the agent an active participant, or allowed to act by supervision scope? */
  private async agentAccess(
    tx: Tx,
    auth: AuthContext,
    chat: Chat,
  ): Promise<{ participant: boolean; supervise: boolean; visible: boolean }> {
    const participant = !!(
      auth.membershipId &&
      (await tx.chatParticipant.findFirst({
        where: { tenantId: auth.tenantId, chatId: chat.id, membershipId: auth.membershipId, leftAt: null },
      }))
    );
    const inScope =
      auth.departmentScope === 'all' ||
      (chat.departmentId ? auth.departmentScope.includes(chat.departmentId) : true);
    const supervise = auth.permissions.has('chats.monitor') && inScope;
    // Same visibility as GET /chats/{id}: department scope, ownership or participation.
    return {
      participant,
      supervise,
      visible: inScope || participant || chat.ownerMembershipId === auth.membershipId,
    };
  }

  async agentSend(auth: AuthContext, chatId: string, input: AgentMessageInput): Promise<MessageResource> {
    if (!auth.membershipId) throw denied('Only agents can send messages');
    const body = input.body?.trim() ?? '';
    if (!body && !input.attachmentIds?.length) throw badRequest('Message is empty', { body: ['Required'] });
    if (body.length > 8000) throw badRequest('Message is too long', { body: ['Maximum 8000 characters'] });
    return this.db.tx(auth.tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, auth.tenantId, chatId);
      const access = await this.agentAccess(tx, auth, chat);
      const dup = await tx.message.findUnique({
        where: {
          tenantId_chatId_clientMessageId: {
            tenantId: auth.tenantId,
            chatId,
            clientMessageId: input.clientMessageId,
          },
        },
        include: messageInclude,
      });
      const ownRetry = dup && dup.senderType === 'agent' && dup.senderMembershipId === auth.membershipId;
      // Retry of the agent's own send (even after the chat closed or they left) replays the original.
      if (dup && ownRetry) return messageResource(dup);
      // Outside the agent's scope the chat does not exist for them — not even as an id oracle.
      if (!access.visible) throw notFound('Chat');
      if (dup) assertSameSender(dup, { senderType: 'agent', senderMembershipId: auth.membershipId });
      if (chat.status === 'closed') throw conflict('CHAT_CLOSED', 'This chat has ended');
      if (input.visibility === 'internal') {
        if (!auth.permissions.has('notes.view') || (!access.participant && !access.supervise))
          throw denied('You cannot add notes to this chat');
      } else if (!access.participant) {
        throw denied('Accept or join the chat before replying');
      }
      await this.assertAttachmentsClean(tx, auth.tenantId, chatId, input.attachmentIds ?? []);
      const settings = await this.store.settings(tx, auth.tenantId);
      const member = await tx.membership.findUniqueOrThrow({
        where: { id: auth.membershipId! },
        include: { user: { select: { displayName: true } } },
      });
      if (input.replyId) {
        await tx.cannedReply.updateMany({
          where: { tenantId: auth.tenantId, id: input.replyId },
          data: { usageCount: { increment: 1 } },
        });
      }
      const { message } = await this.store.appendMessage(
        tx,
        chat,
        {
          senderType: 'agent',
          senderMembershipId: auth.membershipId,
          senderName: member.displayName || member.user.displayName,
          visibility: input.visibility,
          body: body || null,
          clientMessageId: input.clientMessageId,
          attachmentIds: input.attachmentIds,
          replyId: input.replyId ?? null,
          options: input.visibility === 'public' ? (input.options ?? []).slice(0, 8) : [],
        },
        settings,
      );
      if (input.visibility === 'public') await this.store.emitChatUpdated(tx, chat);
      return message;
    });
  }

  /** System/automated public message (triggers). Never emits a visitor message event. */
  async automatedMessage(
    tenantId: string,
    chatId: string,
    text: string,
    attribution: string,
    causationId: string | null,
  ): Promise<MessageResource | null> {
    return this.db.tx(tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, tenantId, chatId);
      if (chat.status === 'closed') return null;
      const settings = await this.store.settings(tx, tenantId);
      const { message } = await this.store.appendMessage(
        tx,
        chat,
        {
          senderType: 'system',
          senderName: attribution,
          type: 'text',
          body: text,
          automated: true,
          causationId,
        },
        settings,
      );
      return message;
    });
  }

  /**
   * Delivery cursor (ch. 13): the recipient's transport received messages through
   * `seq`. Monotonic, bounded by the chat's last sequence, never moves a read cursor.
   * Returns whether it advanced so the caller can push an ephemeral receipt.
   */
  async deliveredCursor(
    actor: { auth?: AuthContext; visitor?: VisitorContext },
    chatId: string,
    seq: number,
  ): Promise<{ advanced: boolean; throughSeq: number; actorType: 'agent' | 'visitor' }> {
    const tenantId = actor.auth?.tenantId ?? actor.visitor!.tenantId;
    return this.db.tx(tenantId, async (tx) => {
      const chat = await tx.chat.findFirst({
        where: {
          tenantId,
          id: chatId,
          ...(actor.visitor ? { visitorId: actor.visitor.visitorId, siteId: actor.visitor.siteId } : {}),
        },
        select: { nextSeq: true },
      });
      if (!chat) throw notFound('Chat');
      const through = Math.max(0, Math.min(seq, Number(chat.nextSeq) - 1));
      const who = actor.visitor
        ? { visitorId: actor.visitor.visitorId }
        : { membershipId: actor.auth!.membershipId ?? '__none__' };
      const r = await tx.chatParticipant.updateMany({
        where: { tenantId, chatId, leftAt: null, ...who, lastDeliveredSeq: { lt: BigInt(through) } },
        data: { lastDeliveredSeq: BigInt(through) },
      });
      // The cursor never moves backwards: acknowledge what is stored, not what was asked for.
      const stored = await tx.chatParticipant.aggregate({
        where: { tenantId, chatId, leftAt: null, ...who },
        _max: { lastDeliveredSeq: true },
      });
      const throughSeq =
        stored._max.lastDeliveredSeq === null ? through : Number(stored._max.lastDeliveredSeq);
      return { advanced: r.count > 0, throughSeq, actorType: actor.visitor ? 'visitor' : 'agent' };
    });
  }

  async readCursor(
    actor: { auth?: AuthContext; visitor?: VisitorContext },
    chatId: string,
    lastReadSeq: number,
  ): Promise<{ lastReadSeq: number }> {
    const tenantId = actor.auth?.tenantId ?? actor.visitor!.tenantId;
    return this.db.tx(tenantId, async (tx) => {
      const chat = await tx.chat.findFirst({ where: { tenantId, id: chatId } });
      if (!chat) throw notFound('Chat');
      const lastSeq = Number(chat.nextSeq) - 1;
      if (lastReadSeq > lastSeq)
        throw badRequest('Read cursor is beyond the last message', { last_read_seq: [`Maximum ${lastSeq}`] });
      const where = actor.visitor
        ? { tenantId, chatId, visitorId: actor.visitor.visitorId, leftAt: null }
        : { tenantId, chatId, membershipId: actor.auth!.membershipId ?? '__none__', leftAt: null };
      if (
        actor.visitor &&
        (chat.visitorId !== actor.visitor.visitorId || chat.siteId !== actor.visitor.siteId)
      )
        throw notFound('Chat');
      const p = await tx.chatParticipant.findFirst({ where });
      if (!p) {
        // Supervisors viewing without participation do not move read cursors.
        return { lastReadSeq };
      }
      const next = BigInt(Math.max(Number(p.lastReadSeq), lastReadSeq));
      if (next === p.lastReadSeq) return { lastReadSeq: Number(next) };
      await tx.chatParticipant.update({
        where: { id: p.id },
        data: { lastReadSeq: next, lastDeliveredSeq: next > p.lastDeliveredSeq ? next : p.lastDeliveredSeq },
      });
      const settings = await this.store.settings(tx, tenantId);
      if (settings.chat.readReceipts !== false) {
        const payload = {
          chatId,
          participantId: p.id,
          actorType: p.actorType,
          throughSeq: Number(next),
          at: new Date(),
        };
        await this.store.outboxService().append(tx, tenantId, {
          aggregateType: 'chat',
          aggregateId: chatId,
          aggregateVersion: chat.version,
          eventType: 'message.read',
          payload,
          scopes: [
            { kind: 'chat', id: chatId, audience: 'staff' },
            {
              kind: 'chat',
              id: chatId,
              audience: 'public',
              payload: { chatId, actorType: p.actorType, throughSeq: Number(next), at: payload.at },
            },
          ],
        });
      }
      return { lastReadSeq: Number(next) };
    });
  }

  // ════════════════════════ Transfers & collaboration ════════════════════════

  async transfer(
    auth: AuthContext,
    chatId: string,
    input: {
      targetAgentId?: string | null;
      targetDepartmentId?: string | null;
      note?: string | null;
      force?: boolean;
      reason?: string | null;
    },
  ): Promise<{ offer?: ReturnType<typeof offerResource>; chat: StaffChat }> {
    if (!!input.targetAgentId === !!input.targetDepartmentId)
      throw badRequest('Choose exactly one destination', {
        target_agent_id: ['Choose an agent or a department'],
      });
    let reroute = false;
    let offerId: string | null = null;
    const out = await this.db.tx(auth.tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, auth.tenantId, chatId);
      if (chat.status === 'closed') throw conflict('CHAT_CLOSED', 'This chat has ended');
      const access = await this.agentAccess(tx, auth, chat);
      const isOwner = chat.ownerMembershipId === auth.membershipId;
      const supervisor = access.supervise && auth.permissions.has('chats.force_transfer');
      if (!isOwner && !supervisor) throw denied('Only the chat owner or a supervisor can transfer this chat');
      const settings = await this.store.settings(tx, auth.tenantId);

      if (input.targetDepartmentId) {
        const dept = await tx.department.findFirst({
          where: { tenantId: auth.tenantId, id: input.targetDepartmentId, enabled: true, archivedAt: null },
        });
        if (!dept) throw notFound('Department');
        const previous = chat.ownerMembershipId;
        await this.routing.withdrawPendingInTx(tx, chat, 'department_transfer');
        if (previous)
          await tx.chatParticipant.updateMany({
            where: { tenantId: auth.tenantId, chatId, membershipId: previous, leftAt: null },
            data: { leftAt: new Date() },
          });
        await this.store.bumpVersion(tx, chat, {
          departmentId: dept.id,
          ownerMembershipId: null,
          status: 'queued',
        });
        await tx.assignmentHistory.create({
          data: {
            tenantId: auth.tenantId,
            chatId,
            previousOwnerId: previous,
            nextOwnerId: null,
            previousDepartmentId: chat.departmentId,
            nextDepartmentId: dept.id,
            reason: 'department_transfer',
            decision: { by: auth.membershipId },
          },
        });
        await this.store.systemEvent(
          tx,
          chat,
          'chat.transferred',
          `You're being transferred to ${dept.publicLabel || dept.name}`,
          { departmentId: dept.id },
          settings,
          { variant: 'department', department: dept.publicLabel || dept.name },
        );
        if (input.note) {
          await this.store.appendMessage(
            tx,
            chat,
            {
              senderType: 'agent',
              senderMembershipId: auth.membershipId,
              senderName: auth.actorName,
              visibility: 'internal',
              body: `Handoff note: ${input.note.slice(0, 2000)}`,
            },
            settings,
          );
        }
        await this.store.outboxService().append(tx, auth.tenantId, {
          aggregateType: 'chat',
          aggregateId: chatId,
          aggregateVersion: chat.version,
          eventType: 'chat.transferred',
          payload: {
            chatId,
            previousOwner: previous,
            nextOwner: null,
            departmentId: dept.id,
            version: chat.version,
          },
          scopes: [
            { kind: 'chat', id: chatId, audience: 'staff' },
            { kind: 'queue', id: queueScopeId(dept.id), audience: 'staff' },
            ...(previous ? [{ kind: 'agent' as const, id: previous, audience: 'staff' as const }] : []),
            {
              kind: 'chat',
              id: chatId,
              audience: 'public',
              payload: { chatId, nextOwner: null, version: chat.version },
            },
          ],
        });
        await this.store.emitChatUpdated(tx, chat, null, previous ? [previous] : []);
        await this.audit.inTx(tx, auth, {
          action: 'chat.transferred',
          objectType: 'chat',
          objectId: chatId,
          safeDiff: { to_department: dept.id, forced: !isOwner },
        });
        reroute = true;
        return { chat: await this.store.staff(tx, auth.tenantId, chatId) };
      }

      // Agent destination.
      if (chat.status !== 'active')
        throw conflict('VERSION_CONFLICT', 'Only active chats can be transferred to an agent', true);
      const target = await tx.membership.findFirst({
        where: { tenantId: auth.tenantId, id: input.targetAgentId!, enabled: true, archivedAt: null },
      });
      if (!target) throw notFound('Agent');
      if (target.id === chat.ownerMembershipId) throw badRequest('This agent already owns the chat');
      const connected = await this.presence.connectedAgentIds(auth.tenantId);
      if (!connected.has(target.id) || target.desiredStatus !== 'online')
        throw conflict('CAPACITY_EXCEEDED', 'That agent is not available right now', true, {
          reason: 'agent_unavailable',
        });
      if (chat.departmentId && !TENANT_WIDE_ROLES.has(target.role)) {
        const member = await tx.departmentMember.findFirst({
          where: {
            tenantId: auth.tenantId,
            departmentId: chat.departmentId,
            membershipId: target.id,
            canServe: true,
          },
        });
        if (!member) throw denied('That agent does not serve this department');
      }
      await this.store.lockCapacity(tx, auth.tenantId, [
        target.id,
        ...(chat.ownerMembershipId ? [chat.ownerMembershipId] : []),
      ]);
      const u = await this.store.usage(tx, auth.tenantId, target.id);
      if (u.active + u.collaborations + u.reserved >= target.capacity)
        throw conflict('CAPACITY_EXCEEDED', 'That agent has no free capacity', true, {
          reason: 'no_capacity',
        });

      if (input.force) {
        if (!supervisor) throw denied('Only supervisors can force a transfer');
        if (!input.reason?.trim())
          throw badRequest('A reason is required for a forced transfer', { reason: ['Required'] });
        const previous = chat.ownerMembershipId;
        // A pending transfer offer from the previous owner is void once a supervisor reassigns the chat.
        await this.routing.withdrawPendingInTx(tx, chat, 'forced_transfer', 'transfer');
        if (previous)
          await tx.chatParticipant.updateMany({
            where: { tenantId: auth.tenantId, chatId, membershipId: previous, leftAt: null },
            data: { leftAt: new Date() },
          });
        await tx.chatParticipant.updateMany({
          where: { tenantId: auth.tenantId, chatId, membershipId: target.id, leftAt: null },
          data: { leftAt: new Date() },
        });
        await tx.chatParticipant.create({
          data: {
            tenantId: auth.tenantId,
            chatId,
            actorType: 'agent',
            membershipId: target.id,
            role: 'primary',
          },
        });
        await this.store.bumpVersion(tx, chat, { ownerMembershipId: target.id });
        await tx.assignmentHistory.create({
          data: {
            tenantId: auth.tenantId,
            chatId,
            previousOwnerId: previous,
            nextOwnerId: target.id,
            reason: 'forced_transfer',
            decision: { by: auth.membershipId, reason: input.reason },
          },
        });
        const [profile] = await this.store.agentProfiles(tx, auth.tenantId, [target.id]);
        await this.store.systemEvent(
          tx,
          chat,
          'chat.transferred',
          `You're now chatting with ${profile?.displayName ?? 'another agent'}`,
          { to: target.id },
          settings,
          { variant: 'agent', name: profile?.displayName ?? '' },
        );
        await this.store.outboxService().append(tx, auth.tenantId, {
          aggregateType: 'chat',
          aggregateId: chatId,
          aggregateVersion: chat.version,
          eventType: 'chat.transferred',
          payload: {
            chatId,
            previousOwner: previous,
            nextOwner: target.id,
            departmentId: chat.departmentId,
            version: chat.version,
            forced: true,
          },
          scopes: [
            { kind: 'chat', id: chatId, audience: 'staff' },
            { kind: 'agent', id: target.id, audience: 'staff' },
            ...(previous ? [{ kind: 'agent' as const, id: previous, audience: 'staff' as const }] : []),
            {
              kind: 'chat',
              id: chatId,
              audience: 'public',
              payload: { chatId, nextOwner: profile, version: chat.version },
            },
          ],
        });
        await this.store.emitChatUpdated(tx, chat, null, previous ? [previous] : []);
        await this.audit.inTx(tx, auth, {
          action: 'chat.force_transferred',
          objectType: 'chat',
          objectId: chatId,
          safeDiff: { from: previous, to: target.id, reason: input.reason },
        });
        return { chat: await this.store.staff(tx, auth.tenantId, chatId) };
      }

      const existing = await tx.assignmentOffer.findFirst({
        where: { tenantId: auth.tenantId, chatId, status: 'pending', mode: 'transfer' },
      });
      if (existing) throw conflict('VERSION_CONFLICT', 'A transfer is already pending for this chat', true);
      const offer = await tx.assignmentOffer.create({
        data: {
          tenantId: auth.tenantId,
          chatId,
          membershipId: target.id,
          fromMembershipId: auth.membershipId,
          mode: 'transfer',
          note: input.note?.slice(0, 2000) ?? null,
          expiresAt: new Date(Date.now() + OFFER_TTL_MS),
        },
      });
      offerId = offer.id;
      const staff = await this.store.staff(tx, auth.tenantId, chatId);
      await this.store.outboxService().append(tx, auth.tenantId, {
        aggregateType: 'offer',
        aggregateId: offer.id,
        aggregateVersion: 1,
        eventType: 'assignment.offered',
        payload: {
          offer: offerResource(offer),
          chatPreview: staff,
          expiresAt: offer.expiresAt,
          from: auth.actorName,
        },
        scopes: [{ kind: 'agent', id: target.id, audience: 'staff' }],
      });
      await tx.assignmentHistory.create({
        data: {
          tenantId: auth.tenantId,
          chatId,
          previousOwnerId: chat.ownerMembershipId,
          nextOwnerId: null,
          reason: 'transfer_offered',
          decision: { offerId: offer.id, to: target.id },
        },
      });
      return { offer: offerResource(offer), chat: staff };
    });
    if (offerId)
      await this.queues.add(
        QUEUES.timers,
        'offer-expiry',
        { tenantId: auth.tenantId, offerId },
        { delay: OFFER_TTL_MS + 500, jobId: `offer-${offerId}` },
      );
    if (reroute) await this.routing.route(auth.tenantId, chatId);
    return out;
  }

  async addCollaborator(auth: AuthContext, chatId: string, membershipId: string): Promise<StaffChat> {
    return this.db.tx(auth.tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, auth.tenantId, chatId);
      if (chat.status !== 'active')
        throw conflict('VERSION_CONFLICT', 'Only active chats can have collaborators', true);
      const access = await this.agentAccess(tx, auth, chat);
      const isOwner = chat.ownerMembershipId === auth.membershipId;
      const selfJoin = membershipId === auth.membershipId && access.supervise;
      if (!isOwner && !access.supervise && !selfJoin)
        throw denied('Only the owner or a supervisor can invite collaborators');
      if (membershipId === chat.ownerMembershipId) throw badRequest('This agent already owns the chat');
      const target = await tx.membership.findFirst({
        where: { tenantId: auth.tenantId, id: membershipId, enabled: true, archivedAt: null },
      });
      if (!target) throw notFound('Agent');
      const already = await tx.chatParticipant.findFirst({
        where: { tenantId: auth.tenantId, chatId, membershipId, leftAt: null },
      });
      if (already) return this.store.staff(tx, auth.tenantId, chatId);
      await this.store.lockCapacity(tx, auth.tenantId, [membershipId]);
      const u = await this.store.usage(tx, auth.tenantId, membershipId);
      if (u.active + u.collaborations + u.reserved + COLLABORATION_SLOTS > target.capacity)
        throw conflict('CAPACITY_EXCEEDED', 'That agent has no free capacity');
      await tx.chatParticipant.create({
        data: { tenantId: auth.tenantId, chatId, actorType: 'agent', membershipId, role: 'collaborator' },
      });
      await this.store.bumpVersion(tx, chat, {});
      const settings = await this.store.settings(tx, auth.tenantId);
      const [profile] = await this.store.agentProfiles(tx, auth.tenantId, [membershipId]);
      await this.store.systemEvent(
        tx,
        chat,
        'chat.agent_joined',
        `${profile?.displayName ?? 'An agent'} joined the chat`,
        { membershipId, role: 'collaborator' },
        settings,
        { name: profile?.displayName ?? '' },
      );
      const joinedAt = new Date();
      await this.store.outboxService().append(tx, auth.tenantId, {
        aggregateType: 'chat',
        aggregateId: chatId,
        aggregateVersion: chat.version,
        eventType: 'participant.joined',
        payload: { chatId, participant: { membershipId, ...profile }, role: 'collaborator', joinedAt },
        scopes: [
          { kind: 'chat', id: chatId, audience: 'staff' },
          { kind: 'agent', id: membershipId, audience: 'staff' },
          {
            kind: 'chat',
            id: chatId,
            audience: 'public',
            payload: { chatId, participant: profile, role: 'collaborator', joinedAt },
          },
        ],
      });
      await this.store.emitChatUpdated(tx, chat, null, [membershipId]);
      return this.store.staff(tx, auth.tenantId, chatId);
    });
  }

  async removeCollaborator(auth: AuthContext, chatId: string, membershipId: string): Promise<void> {
    await this.db.tx(auth.tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, auth.tenantId, chatId);
      if (membershipId === chat.ownerMembershipId)
        throw conflict(
          'VERSION_CONFLICT',
          'The primary owner must transfer or end the chat instead of leaving',
        );
      const access = await this.agentAccess(tx, auth, chat);
      const allowed =
        membershipId === auth.membershipId ||
        chat.ownerMembershipId === auth.membershipId ||
        access.supervise;
      if (!allowed) throw denied();
      const p = await tx.chatParticipant.findFirst({
        where: { tenantId: auth.tenantId, chatId, membershipId, leftAt: null, role: 'collaborator' },
      });
      if (!p) return;
      await tx.chatParticipant.update({ where: { id: p.id }, data: { leftAt: new Date() } });
      await this.store.bumpVersion(tx, chat, {});
      const settings = await this.store.settings(tx, auth.tenantId);
      const [profile] = await this.store.agentProfiles(tx, auth.tenantId, [membershipId]);
      await this.store.systemEvent(
        tx,
        chat,
        'chat.agent_left',
        `${profile?.displayName ?? 'An agent'} left the chat`,
        { membershipId },
        settings,
        { name: profile?.displayName ?? '' },
      );
      await this.store.outboxService().append(tx, auth.tenantId, {
        aggregateType: 'chat',
        aggregateId: chatId,
        aggregateVersion: chat.version,
        eventType: 'participant.left',
        payload: { chatId, participantId: p.id, membershipId, leftAt: new Date(), reason: 'left' },
        scopes: [
          { kind: 'chat', id: chatId, audience: 'staff' },
          { kind: 'agent', id: membershipId, audience: 'staff' },
          {
            kind: 'chat',
            id: chatId,
            audience: 'public',
            payload: { chatId, participantId: p.id, leftAt: new Date() },
          },
        ],
      });
      await this.store.emitChatUpdated(tx, chat, null, [membershipId]);
    });
  }

  // ════════════════════════ Ending & rating ════════════════════════

  async close(
    actor: CloseActor,
    chatId: string,
    input: { reason: string; expectedVersion?: number | null },
  ): Promise<{ chat: StaffChat | PublicChat; alreadyClosed: boolean }> {
    const tenantId =
      actor.kind === 'agent'
        ? actor.auth.tenantId
        : actor.kind === 'visitor'
          ? actor.visitor.tenantId
          : actor.tenantId;
    return this.db
      .tx(tenantId, async (tx) => {
        const chat = await this.store.lockChat(tx, tenantId, chatId);
        if (
          actor.kind === 'visitor' &&
          (chat.visitorId !== actor.visitor.visitorId || chat.siteId !== actor.visitor.siteId)
        )
          throw notFound('Chat');
        if (actor.kind === 'agent') {
          const access = await this.agentAccess(tx, actor.auth, chat);
          const isOwner = chat.ownerMembershipId === actor.auth.membershipId;
          if (
            !isOwner &&
            !access.participant &&
            !access.supervise &&
            !(chat.status !== 'active' && actor.auth.permissions.has('chats.serve'))
          )
            throw denied('You cannot end this chat');
        }
        if (chat.status === 'closed') {
          const view =
            actor.kind === 'visitor'
              ? await this.store.publicChat(tx, chatId)
              : await this.store.staff(tx, tenantId, chatId);
          return { chat: view, alreadyClosed: true };
        }
        if (
          actor.kind === 'agent' &&
          input.expectedVersion &&
          input.expectedVersion !== chat.version &&
          input.expectedVersion > chat.version
        ) {
          throw conflict('VERSION_CONFLICT', 'The chat changed; refresh and try again', true);
        }
        const { staff, pub } = await this.closeInTx(tx, chat, input.reason, actor);
        return { chat: actor.kind === 'visitor' ? pub : staff, alreadyClosed: false };
      })
      .then(async (r) => {
        if (!r.alreadyClosed) await this.routing.drainQueue(tenantId, 20).catch(() => undefined);
        return r;
      });
  }

  /**
   * Terminal close of a chat whose row the caller already locked in `tx` (status
   * must not be `closed`; authorization is the caller's job). Withdraws pending
   * offers, records the system event, releases participants and appends
   * `chat.closed` — all inside the caller's transaction, so another aggregate
   * (e.g. an offline submission converted from the queue) can commit atomically
   * with the close. The caller should drain the queue after commit.
   */
  async closeInTx(
    tx: Tx,
    chat: Chat,
    reason: string,
    actor: CloseActor,
  ): Promise<{ staff: StaffChat; pub: PublicChat }> {
    const tenantId = chat.tenantId;
    const chatId = chat.id;
    if (chat.status === 'closed') throw conflict('CHAT_CLOSED', 'This chat has ended');
    const settings = await this.store.settings(tx, tenantId);
    await this.routing.withdrawPendingInTx(tx, chat, 'chat_closed');
    const now = new Date();
    const closedByActor = actor.kind;
    const closedById =
      actor.kind === 'agent'
        ? actor.auth.membershipId
        : actor.kind === 'visitor'
          ? actor.visitor.visitorId
          : null;
    const agentIds = (
      await tx.chatParticipant.findMany({ where: { tenantId, chatId, leftAt: null, actorType: 'agent' } })
    )
      .map((p) => p.membershipId!)
      .filter(Boolean);
    const who =
      actor.kind === 'visitor'
        ? 'The visitor'
        : actor.kind === 'agent'
          ? actor.auth.actorName.split(' ')[0]
          : 'Talkivio';
    await this.store.systemEvent(
      tx,
      chat,
      'chat.closed',
      `${who} ended the chat`,
      { reason, by: closedByActor },
      settings,
      { by: closedByActor, ...(actor.kind === 'agent' ? { name: who } : {}) },
    );
    await tx.chatParticipant.updateMany({ where: { tenantId, chatId, leftAt: null }, data: { leftAt: now } });
    await this.store.bumpVersion(tx, chat, {
      status: 'closed',
      closedAt: now,
      closeReason: reason.slice(0, 100),
      closedByActor,
      closedById,
    });
    const staff = await this.store.staff(tx, tenantId, chatId);
    const pub = await this.store.publicChat(tx, chatId);
    await this.store.outboxService().append(tx, tenantId, {
      aggregateType: 'chat',
      aggregateId: chatId,
      aggregateVersion: chat.version,
      eventType: 'chat.closed',
      payload: { chatId, closedAt: now, reason, closedBy: closedByActor, version: chat.version, chat: staff },
      scopes: [
        { kind: 'chat', id: chatId, audience: 'staff' },
        { kind: 'queue', id: queueScopeId(chat.departmentId), audience: 'staff' },
        ...agentIds.map((id) => ({ kind: 'agent' as const, id, audience: 'staff' as const })),
        {
          kind: 'chat',
          id: chatId,
          audience: 'public',
          payload: { chatId, closedAt: now, publicReason: pub.closeReason, version: chat.version, chat: pub },
        },
      ],
      causationId: actor.kind === 'system' ? (actor.causationId ?? null) : null,
    });
    return { staff, pub };
  }

  async rate(
    v: VisitorContext,
    chatId: string,
    input: { rating: 'good' | 'bad'; comment?: string | null },
  ): Promise<{ rating: string; comment: string | null; revisionCount: number }> {
    if (input.comment && input.comment.length > 2000)
      throw badRequest('Comment is too long', { comment: ['Maximum 2000 characters'] });
    return this.db.tx(v.tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, v.tenantId, chatId);
      if (chat.visitorId !== v.visitorId || chat.siteId !== v.siteId) throw notFound('Chat');
      if (
        chat.status === 'closed' &&
        chat.closedAt &&
        Date.now() - chat.closedAt.getTime() > RATING_WINDOW_MS
      ) {
        throw conflict('TOKEN_EXPIRED', 'The rating window for this chat has closed');
      }
      const existing = await tx.chatRating.findUnique({
        where: { tenantId_chatId: { tenantId: v.tenantId, chatId } },
      });
      const comment = input.comment?.trim() || null;
      const row = existing
        ? await tx.chatRating.update({
            where: { id: existing.id },
            data: {
              rating: input.rating,
              comment: comment ?? existing.comment,
              revisedAt: new Date(),
              revisionCount: { increment: 1 },
            },
          })
        : await tx.chatRating.create({
            data: { tenantId: v.tenantId, chatId, visitorId: v.visitorId, rating: input.rating, comment },
          });
      await this.store.bumpVersion(tx, chat, {});
      await this.store.outboxService().append(tx, v.tenantId, {
        aggregateType: 'chat',
        aggregateId: chatId,
        aggregateVersion: chat.version,
        eventType: 'rating.updated',
        payload: {
          chatId,
          rating: row.rating,
          comment: row.comment,
          submittedAt: row.submittedAt,
          revisedAt: row.revisedAt,
        },
        scopes: [
          { kind: 'chat', id: chatId, audience: 'staff' },
          ...(chat.ownerMembershipId
            ? [{ kind: 'agent' as const, id: chat.ownerMembershipId, audience: 'staff' as const }]
            : []),
          {
            kind: 'chat',
            id: chatId,
            audience: 'public',
            payload: { chatId, rating: row.rating, comment: row.comment },
          },
        ],
      });
      return { rating: row.rating, comment: row.comment, revisionCount: row.revisionCount };
    });
  }

  async requestRating(auth: AuthContext, chatId: string): Promise<void> {
    await this.db.tx(auth.tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, auth.tenantId, chatId);
      const access = await this.agentAccess(tx, auth, chat);
      if (!access.participant) throw denied();
      const settings = await this.store.settings(tx, auth.tenantId);
      await this.store.systemEvent(
        tx,
        chat,
        'chat.rating_requested',
        'How did we do? Rate this chat.',
        {},
        settings,
      );
    });
  }

  // ════════════════════════ Metadata ════════════════════════

  async setTags(auth: AuthContext, chatId: string, tagIds: string[]): Promise<StaffChat> {
    return this.db.tx(auth.tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, auth.tenantId, chatId);
      const access = await this.agentAccess(tx, auth, chat);
      // Tenant-wide scope alone is not a write permission (analysts are tenant-wide): it also needs serving or tag rights.
      const tagsAnyChat =
        auth.departmentScope === 'all' &&
        (auth.permissions.has('chats.serve') || auth.permissions.has('tags.manage'));
      if (!access.participant && !access.supervise && !tagsAnyChat) throw denied();
      const valid = await tx.tag.findMany({
        where: { tenantId: auth.tenantId, id: { in: tagIds }, archivedAt: null },
      });
      if (valid.length !== new Set(tagIds).size) throw notFound('Tag');
      await tx.chatTag.deleteMany({ where: { tenantId: auth.tenantId, chatId, tagId: { notIn: tagIds } } });
      for (const t of valid) {
        await tx.chatTag.upsert({
          where: { tenantId_chatId_tagId: { tenantId: auth.tenantId, chatId, tagId: t.id } },
          create: { tenantId: auth.tenantId, chatId, tagId: t.id, source: 'agent' },
          update: {},
        });
      }
      await this.store.bumpVersion(tx, chat, {});
      await this.store.emitChatUpdated(tx, chat);
      await this.audit.inTx(tx, auth, {
        action: 'chat.tags_set',
        objectType: 'chat',
        objectId: chatId,
        safeDiff: { tag_ids: tagIds },
      });
      return this.store.staff(tx, auth.tenantId, chatId);
    });
  }

  /** Trigger/system: add a tag by slug (creating it if needed). */
  async addTagBySlug(
    tenantId: string,
    chatId: string,
    slug: string,
    source: 'trigger' | 'integration',
    causationId: string | null = null,
  ): Promise<void> {
    const clean =
      slug
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, 64) || 'tag';
    await this.db.tx(tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, tenantId, chatId);
      const tag = await tx.tag.upsert({
        where: { tenantId_slug: { tenantId, slug: clean } },
        create: { tenantId, slug: clean, label: slug.slice(0, 80) },
        update: {},
      });
      await tx.chatTag.upsert({
        where: { tenantId_chatId_tagId: { tenantId, chatId, tagId: tag.id } },
        create: { tenantId, chatId, tagId: tag.id, source },
        update: {},
      });
      await this.store.bumpVersion(tx, chat, {});
      await this.store.emitChatUpdated(tx, chat, causationId);
    });
  }

  async removeTagBySlug(
    tenantId: string,
    chatId: string,
    slug: string,
    causationId: string | null = null,
  ): Promise<void> {
    await this.db.tx(tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, tenantId, chatId);
      const tag = await tx.tag.findUnique({ where: { tenantId_slug: { tenantId, slug } } });
      if (!tag) return;
      await tx.chatTag.deleteMany({ where: { tenantId, chatId, tagId: tag.id } });
      await this.store.bumpVersion(tx, chat, {});
      await this.store.emitChatUpdated(tx, chat, causationId);
    });
  }

  /** Trigger-only pre-assignment overrides (ch. 32: set_department/set_priority only before assignment). */
  async setRoutingFields(
    tenantId: string,
    chatId: string,
    patch: { departmentId?: string; priority?: number },
    causationId: string | null = null,
  ): Promise<'applied' | 'skipped_assigned'> {
    const r = await this.db.tx(tenantId, async (tx) => {
      const chat = await this.store.lockChat(tx, tenantId, chatId);
      if (chat.status !== 'queued' && chat.status !== 'offered') return 'skipped_assigned' as const;
      if (patch.departmentId) {
        const d = await tx.department.findFirst({
          where: { tenantId, id: patch.departmentId, enabled: true, archivedAt: null },
        });
        if (!d) return 'skipped_assigned' as const;
      }
      await this.store.bumpVersion(tx, chat, {
        ...(patch.departmentId ? { departmentId: patch.departmentId, routeReason: 'trigger_override' } : {}),
        ...(patch.priority !== undefined
          ? { priority: Math.max(0, Math.min(100, Math.round(patch.priority))) }
          : {}),
      });
      await tx.assignmentHistory.create({
        data: {
          tenantId,
          chatId,
          reason: 'trigger_override',
          decision: patch,
          previousDepartmentId: chat.departmentId,
          nextDepartmentId: patch.departmentId ?? chat.departmentId,
        },
      });
      await this.store.emitChatUpdated(tx, chat, causationId);
      return 'applied' as const;
    });
    if (r === 'applied') await this.routing.route(tenantId, chatId, { causationId });
    return r;
  }

  // ════════════════════════ Visitor connection lifecycle ════════════════════════

  async visitorDisconnected(tenantId: string, visitorId: string): Promise<void> {
    const settings = await this.db.read(tenantId, async (tx) => this.store.settings(tx, tenantId));
    const graceSeconds = Math.max(
      60,
      Math.min(
        1800,
        (settings.chat as unknown as { reconnectGraceSeconds?: number }).reconnectGraceSeconds ?? 300,
      ),
    );
    const open = await this.db.tx(tenantId, async (tx) => {
      const chats = await tx.chat.findMany({
        where: { tenantId, visitorId, status: { not: 'closed' }, visitorDisconnectedAt: null },
      });
      for (const c of chats)
        await tx.chat.update({ where: { id: c.id }, data: { visitorDisconnectedAt: new Date() } });
      return chats;
    });
    for (const c of open) {
      await this.queues.add(
        QUEUES.timers,
        'visitor-grace',
        { tenantId, chatId: c.id },
        { delay: graceSeconds * 1000, jobId: `grace-${c.id}-${Date.now()}` },
      );
    }
  }

  async visitorReconnected(tenantId: string, visitorId: string): Promise<void> {
    await this.db.tx(tenantId, (tx) =>
      tx.chat.updateMany({
        where: { tenantId, visitorId, status: { not: 'closed' }, visitorDisconnectedAt: { not: null } },
        data: { visitorDisconnectedAt: null },
      }),
    );
  }

  /** Timer: close the chat if the visitor never came back within the grace window. */
  async graceExpired(tenantId: string, chatId: string): Promise<void> {
    const chat = await this.db.read(tenantId, (tx) => tx.chat.findFirst({ where: { tenantId, id: chatId } }));
    if (!chat || chat.status === 'closed' || !chat.visitorDisconnectedAt) return;
    const settings = await this.db.read(tenantId, async (tx) => this.store.settings(tx, tenantId));
    const graceSeconds = Math.max(
      60,
      Math.min(
        1800,
        (settings.chat as unknown as { reconnectGraceSeconds?: number }).reconnectGraceSeconds ?? 300,
      ),
    );
    if (Date.now() - chat.visitorDisconnectedAt.getTime() < graceSeconds * 1000 - 1000) return;
    await this.close({ kind: 'system', tenantId }, chatId, { reason: 'visitor_disconnected' });
  }

  newClientId(): string {
    return randomUUID();
  }
}
