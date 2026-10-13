import { Injectable, OnModuleInit } from '@nestjs/common';
import type { CampaignInvitation, Prisma } from '@prisma/client';
import type { DslAction } from '@talkivio/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AppError, conflict, notFound, zodError, type VisitorContext } from '../../common/http';
import { IdempotencyService, validateIdempotencyKey } from '../../common/idempotency';
import { OutboxService } from '../../outbox/outbox.service';
import { CommandRegistry } from '../../realtime/command-registry';
import { AvailabilityService } from '../availability/availability.service';
import { ChatCommandsService } from '../chats/chat-commands.service';
import { ChatStore } from '../chats/chat.store';
import type { MessageResource, PublicChat } from '../chats/chat.projections';

type InvitationAction = Extract<DslAction, { type: 'display_invitation' }>;

export interface OfferInput {
  tenantId: string;
  campaignId: string;
  siteId: string | null;
  visitorId: string | null;
  sessionId: string | null;
  action: InvitationAction;
  /** Trigger effect id (causation of the offered event). */
  effectId: string;
}

export interface OfferOutcome {
  status: 'applied' | 'skipped';
  reason?: string;
  invitationId?: string;
}

/** Visitor-facing invitation grant (only public fields). */
export interface InvitationResource {
  id: string;
  state: CampaignInvitation['state'];
  message: string;
  attribution: string;
  expiresAt: Date;
  displayedAt: Date | null;
  dismissedAt: Date | null;
  acceptedChatId: string | null;
  version: number;
}

function resource(i: CampaignInvitation): InvitationResource {
  return {
    id: i.id,
    state: i.state,
    message: i.message,
    attribution: i.attribution,
    expiresAt: i.expiresAt,
    displayedAt: i.displayedAt,
    dismissedAt: i.dismissedAt,
    acceptedChatId: i.acceptedChatId,
    version: i.version,
  };
}

const uuid = z.string().uuid();
const ACCEPT_WAIT_MS = 8000;

/**
 * Proactive invitations (ch. 21): the decision (row in `eligible`) is stored
 * separately from the display acknowledgment; acceptance validates current
 * availability and creates exactly one ordinary chat.
 */
@Injectable()
export class InvitationsService implements OnModuleInit {
  constructor(
    private readonly db: TenantDb,
    private readonly outbox: OutboxService,
    private readonly availability: AvailabilityService,
    private readonly chats: ChatCommandsService,
    private readonly store: ChatStore,
    private readonly idempotency: IdempotencyService,
    private readonly registry: CommandRegistry,
  ) {}

  onModuleInit(): void {
    // Socket parity (ch. 77): same service methods as REST.
    this.registry.registerVisitor('invitation.ack', async (ctx, cmd) => {
      const p = z.object({ invitationId: uuid, displayedAtClient: z.string().max(40).optional() }).strict().safeParse(cmd.payload);
      if (!p.success) throw zodError(p.error);
      return this.markDisplayed(ctx.visitor, p.data.invitationId);
    });
    this.registry.registerVisitor('invitation.dismiss', async (ctx, cmd) => {
      const p = z.object({ invitationId: uuid }).strict().safeParse(cmd.payload);
      if (!p.success) throw zodError(p.error);
      await this.dismiss(ctx.visitor, p.data.invitationId);
      return { ok: true };
    });
  }

  // ───────── Decision (trigger effect, inside the effect transaction) ─────────

  async offer(tx: Tx, input: OfferInput): Promise<OfferOutcome> {
    const { tenantId, campaignId, action } = input;
    if (!input.sessionId || !input.visitorId || !input.siteId) return { status: 'skipped', reason: 'no_visitor_session' };
    const now = new Date();
    const session = await tx.visitorSession.findFirst({ where: { tenantId, id: input.sessionId } });
    if (!session || session.endedAt) return { status: 'skipped', reason: 'session_ended' };
    // Behaviour-targeted campaigns require analytics consent (ch. 21/26).
    if (session.analyticsConsent !== 'granted') return { status: 'skipped', reason: 'consent_required' };
    const chatting = await tx.chat.count({ where: { tenantId, visitorId: input.visitorId, status: { not: 'closed' } } });
    if (chatting) return { status: 'skipped', reason: 'visitor_chatting' };
    if (action.dismiss_cooldown_hours > 0) {
      const since = new Date(now.getTime() - action.dismiss_cooldown_hours * 3600_000);
      const dismissed = await tx.campaignInvitation.count({ where: { tenantId, visitorId: input.visitorId, campaignId, dismissedAt: { gt: since } } });
      if (dismissed) return { status: 'skipped', reason: 'dismissed_recently' };
    }
    const sent = await tx.campaignInvitation.count({ where: { tenantId, sessionId: session.id, campaignId } });
    if (sent >= action.max_per_session) return { status: 'skipped', reason: 'session_cap' };
    const open = await tx.campaignInvitation.count({ where: { tenantId, sessionId: session.id, state: { in: ['eligible', 'displayed'] }, expiresAt: { gt: now } } });
    if (open) return { status: 'skipped', reason: 'invitation_open' };

    // Availability guard: never invite into an offline or full department.
    const site = await tx.site.findFirst({ where: { tenantId, id: input.siteId }, select: { defaultDepartmentId: true } });
    const avail = await this.availability.compute(tx, tenantId, input.siteId, now);
    const deptId = action.department_id ?? site?.defaultDepartmentId ?? null;
    const scope = deptId ? avail.departments.find((d) => d.id === deptId) : avail;
    if (!scope || scope.state === 'offline' || (scope.state === 'busy' && !scope.acceptsQueue)) return { status: 'skipped', reason: 'unavailable' };

    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + action.expires_in_seconds * 1000);
    // Unique (tenant, session, occurrence_key) caps concurrent decisions at the database.
    const created = await tx.campaignInvitation.createMany({
      data: [
        {
          id,
          tenantId,
          campaignId,
          sessionId: session.id,
          visitorId: input.visitorId,
          occurrenceKey: `${campaignId}:${sent + 1}`,
          state: 'eligible',
          message: action.message,
          attribution: action.attribution,
          departmentId: action.department_id,
          expiresAt,
        },
      ],
      skipDuplicates: true,
    });
    if (!created.count) return { status: 'skipped', reason: 'duplicate' };
    const grant = { invitationId: id, message: action.message, attribution: action.attribution, expiresAt, version: 1 };
    await this.outbox.append(tx, tenantId, {
      aggregateType: 'invitation',
      aggregateId: id,
      aggregateVersion: 1,
      eventType: 'invitation.offered',
      payload: { ...grant, campaignId, sessionId: session.id, visitorId: input.visitorId, siteId: input.siteId, departmentId: action.department_id, stage: 'eligible' },
      scopes: [{ kind: 'visitor', id: session.id, audience: 'public', payload: grant }],
      causationId: input.effectId,
    });
    return { status: 'applied', invitationId: id };
  }

  // ───────── Visitor commands ─────────

  private async lockOwn(tx: Tx, v: VisitorContext, id: string): Promise<CampaignInvitation> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM invitations WHERE tenant_id = ${v.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw notFound('Invitation');
    const inv = await tx.campaignInvitation.findUniqueOrThrow({ where: { id } });
    if (inv.visitorId !== v.visitorId) throw notFound('Invitation');
    return inv;
  }

  private async stage(tx: Tx, inv: CampaignInvitation, eventType: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.outbox.append(tx, inv.tenantId, {
      aggregateType: 'invitation',
      aggregateId: inv.id,
      aggregateVersion: inv.version,
      eventType,
      payload: { invitationId: inv.id, campaignId: inv.campaignId, sessionId: inv.sessionId, state: inv.state, ...extra },
      scopes: [],
    });
  }

  private expired(inv: CampaignInvitation, now: Date): boolean {
    return inv.state === 'expired' || ((inv.state === 'eligible' || inv.state === 'displayed') && inv.expiresAt <= now);
  }

  /** Explicit display acknowledgment using server receipt time (eligibility alone never counts). */
  async markDisplayed(v: VisitorContext, id: string): Promise<InvitationResource> {
    return this.db.tx(v.tenantId, async (tx) => {
      let inv = await this.lockOwn(tx, v, id);
      const now = new Date();
      if (this.expired(inv, now)) {
        if (inv.state !== 'expired') inv = await tx.campaignInvitation.update({ where: { id }, data: { state: 'expired', version: { increment: 1 } } });
        return resource(inv);
      }
      if (inv.state === 'eligible') {
        inv = await tx.campaignInvitation.update({ where: { id }, data: { state: 'displayed', displayedAt: now, version: { increment: 1 } } });
        await this.stage(tx, inv, 'invitation.displayed', { displayedAt: now });
      }
      return resource(inv);
    });
  }

  /** Durable dismissal (drives the per-visitor dismissal cap). */
  async dismiss(v: VisitorContext, id: string): Promise<void> {
    await this.db.tx(v.tenantId, async (tx) => {
      const inv = await this.lockOwn(tx, v, id);
      if (inv.state !== 'eligible' && inv.state !== 'displayed') return;
      const now = new Date();
      const next = await tx.campaignInvitation.update({ where: { id }, data: { state: 'dismissed', dismissedAt: now, version: { increment: 1 } } });
      await this.stage(tx, next, 'invitation.dismissed', { dismissedAt: now });
    });
  }

  /**
   * Accept → one ordinary chat, even under double clicks: the admission runs under
   * an idempotency key derived from the invitation id, so concurrent or repeated
   * accepts replay the same admission. Expired grants and availability changes → 409.
   */
  async accept(v: VisitorContext, id: string, clientRequestId: string | null): Promise<{ status: number; body: { chat: PublicChat; initialMessage: MessageResource | null } }> {
    const key = validateIdempotencyKey(clientRequestId);
    const run = await this.idempotency.run(v.tenantId, `visitor:${v.visitorId}`, `widget.invitations.accept:${id}`, key, { id }, () => this.acceptOnce(v, id));
    return { status: run.status, body: run.body };
  }

  private async acceptOnce(v: VisitorContext, id: string): Promise<{ status: number; body: { chat: PublicChat; initialMessage: MessageResource | null } }> {
    const inv = await this.db.tx(v.tenantId, async (tx) => {
      const row = await this.lockOwn(tx, v, id);
      const now = new Date();
      if (row.state === 'accepted') return row;
      if (row.state === 'dismissed') throw conflict('OFFER_EXPIRED', 'This invitation was dismissed');
      if (this.expired(row, now)) {
        if (row.state !== 'expired') await tx.campaignInvitation.update({ where: { id }, data: { state: 'expired', version: { increment: 1 } } });
        throw conflict('OFFER_EXPIRED', 'This invitation has expired');
      }
      return row;
    });
    if (inv.state === 'accepted' && inv.acceptedChatId) {
      // Already accepted (double click / retry): return the same chat, never a second admission.
      const chat = await this.db.read(v.tenantId, (tx) => this.store.publicChat(tx, inv.acceptedChatId!));
      return { status: 200, body: { chat, initialMessage: null } };
    }
    const result = await this.admit(v, inv);
    await this.db.tx(v.tenantId, async (tx) => {
      const row = await this.lockOwn(tx, v, id);
      if (row.state === 'accepted') return;
      const next = await tx.campaignInvitation.update({
        where: { id },
        data: { state: 'accepted', acceptedChatId: result.body.chat.id, displayedAt: row.displayedAt ?? new Date(), version: { increment: 1 } },
      });
      await this.stage(tx, next, 'invitation.accepted', { chatId: result.body.chat.id });
    });
    return result;
  }

  private async admit(v: VisitorContext, inv: CampaignInvitation) {
    const input = {
      clientRequestId: `invitation:${inv.id}`,
      departmentId: inv.departmentId,
      invitation: { id: inv.id, message: inv.message, attribution: inv.attribution },
    };
    const deadline = Date.now() + ACCEPT_WAIT_MS;
    for (;;) {
      try {
        return await this.chats.admit(v, input);
      } catch (err) {
        // A concurrent accept holds the admission key: wait for its result.
        if (err instanceof AppError && err.code === 'IDEMPOTENCY_IN_PROGRESS' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 120));
          continue;
        }
        throw err;
      }
    }
  }

  // ───────── Funnel (ch. 21/45: eligible → displayed → accepted → served, distinct by invitation id) ─────────

  async funnel(tenantId: string, campaignId: string, range: { from?: Date; to?: Date }) {
    return this.db.read(tenantId, async (tx) => {
      const where: Prisma.CampaignInvitationWhereInput = {
        tenantId,
        campaignId,
        ...(range.from || range.to ? { createdAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lt: range.to } : {}) } } : {}),
      };
      const [eligible, displayed, dismissed, expired, acceptedRows] = await Promise.all([
        tx.campaignInvitation.count({ where }),
        tx.campaignInvitation.count({ where: { ...where, displayedAt: { not: null } } }),
        tx.campaignInvitation.count({ where: { ...where, dismissedAt: { not: null } } }),
        tx.campaignInvitation.count({ where: { ...where, state: 'expired' } }),
        tx.campaignInvitation.findMany({ where: { ...where, acceptedChatId: { not: null } }, select: { acceptedChatId: true } }),
      ]);
      const chatIds = acceptedRows.map((r) => r.acceptedChatId!);
      // Same definitions as analytics (ch. 61): assigned = first_assigned_at set; served = at least one human
      // agent public message (automated messages and internal notes excluded). Assigned is not served.
      const [assigned, served] = chatIds.length
        ? await Promise.all([
            tx.chat.count({ where: { tenantId, id: { in: chatIds }, firstAssignedAt: { not: null } } }),
            tx.chat.count({ where: { tenantId, id: { in: chatIds }, messages: { some: { senderType: 'agent', visibility: 'public', automated: false } } } }),
          ])
        : [0, 0];
      return { campaignId, from: range.from ?? null, to: range.to ?? null, eligible, displayed, accepted: chatIds.length, assigned, served, dismissed, expired };
    });
  }
}
