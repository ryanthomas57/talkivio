import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { DesiredStatus, Prisma, Role } from '@prisma/client';
import { DEFAULT_MEMBER_PREFERENCES, type MemberPreferences } from '@talkivio/contracts';
import { TenantDb } from '../../db/tenant-db';
import { randomToken, sha256 } from '../../common/crypto';
import {
  AppError,
  badRequest,
  conflict,
  denied,
  notFound,
  type AuthContext,
  type UserContext,
} from '../../common/http';
import { AuditService } from '../../common/audit.service';
import { env } from '../../config/env';
import { MailService } from '../../core/mail.service';
import { PresenceService } from '../../core/presence.service';
import { roomFor } from '../../outbox/outbox.service';
import { AGENT_NS, RealtimeService } from '../../realtime/realtime.service';
import { AvailabilityBroadcaster } from '../availability/availability.broadcaster';
import { RoutingService } from '../chats/routing.service';
import { AuthService, securityContext, validatePassword } from '../../auth/auth.service';
import { SessionService } from '../../auth/session.service';
import type { Request, Response } from 'express';
import { EventConsumers } from '../../outbox/event-consumers';
import type { InternalEvent } from '../../outbox/outbox.publisher';
import { lockForUpdate } from '../../db/row-lock';
import { billingOn } from '../billing/plan-gate';

const versionConflict = (current: number) =>
  conflict(
    'VERSION_CONFLICT',
    'A teammate changed this agent after you opened it. Reload to see the latest values.',
    false,
    { currentVersion: current },
  );

/** Events after which an agent's active/collaboration count may differ. */
const LOAD_EVENTS = [
  'assignment.accepted',
  'chat.closed',
  'chat.transferred',
  'participant.joined',
  'participant.left',
] as const;

const INVITE_TTL_MS = 7 * 86_400_000;

export interface AgentResource {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  title: string | null;
  role: Role;
  enabled: boolean;
  desiredStatus: DesiredStatus;
  effectiveStatus: 'online' | 'away' | 'invisible' | 'offline';
  connected: boolean;
  activeChats: number;
  capacity: number;
  departmentIds: string[];
  lastSeenAt: Date | null;
  version: number;
}

/** Agent roster, invitations, roles, capacity and presence (ch. 09). */
/** Stored preferences with a patch applied; `sounds` merges per kind (a patch may change one alert's sound). */
function mergePreferences(stored: unknown, patch: Record<string, unknown>): Prisma.InputJsonObject {
  const prev = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...prev, ...patch };
  if (patch.sounds) next.sounds = { ...((prev.sounds as object) ?? {}), ...(patch.sounds as object) };
  return next as Prisma.InputJsonObject;
}

@Injectable()
export class TeamService implements OnModuleInit {
  private readonly logger = new Logger('Team');

  constructor(
    private readonly db: TenantDb,
    private readonly presence: PresenceService,
    private readonly realtime: RealtimeService,
    private readonly routing: RoutingService,
    private readonly broadcaster: AvailabilityBroadcaster,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly consumers: EventConsumers,
  ) {}

  onModuleInit(): void {
    // Active-chat counts on the roster change with assignment, not only with connection/status.
    for (const type of LOAD_EVENTS)
      this.consumers.on(type, `team.presence.${type}`, (e) => this.onLoadChanged(e));
    this.presence.onAgentConnection(async (tenantId, membershipId, connected) => {
      await this.recordInterval(tenantId, membershipId, connected ? undefined : 'offline', 'connection');
      await this.broadcastPresence(tenantId, membershipId);
      this.broadcaster.schedule(tenantId);
      if (connected) await this.routing.drainQueue(tenantId, 50);
      else await this.routing.withdrawOffersFor(tenantId, membershipId, 'agent_disconnected');
    });
  }

  async list(auth: AuthContext): Promise<AgentResource[]> {
    return this.db.read(auth.tenantId, async (tx) => {
      const [members, connected, owned] = await Promise.all([
        tx.membership.findMany({
          where: { tenantId: auth.tenantId, archivedAt: null },
          include: { user: true, departments: true },
          orderBy: { createdAt: 'asc' },
        }),
        this.presence.connectedAgentIds(auth.tenantId),
        tx.chat.groupBy({
          by: ['ownerMembershipId'],
          where: { tenantId: auth.tenantId, status: 'active' },
          _count: { _all: true },
        }),
      ]);
      const load = new Map(owned.map((o) => [o.ownerMembershipId!, o._count._all]));
      return members.map((m) => {
        const isConnected = connected.has(m.id);
        return {
          id: m.id,
          userId: m.userId,
          displayName: m.displayName || m.user.displayName,
          email: m.user.email,
          avatarUrl: m.user.avatarUrl,
          title: m.title,
          role: m.role,
          enabled: m.enabled,
          desiredStatus: m.desiredStatus,
          effectiveStatus: !m.enabled || !isConnected ? 'offline' : m.desiredStatus,
          connected: isConnected,
          activeChats: load.get(m.id) ?? 0,
          capacity: m.capacity,
          departmentIds: m.departments.filter((d) => d.canServe || d.canMonitor).map((d) => d.departmentId),
          lastSeenAt: m.lastSeenAt,
          version: m.version,
        };
      });
    });
  }

  /**
   * Close availability intervals left open by agents who have no live connection —
   * e.g. after a process crash or Redis restart, when no disconnect event fired.
   * Utilization analytics and the routable-queue gauge depend on these intervals.
   */
  async reconcileIntervals(tenantId: string): Promise<number> {
    const open = await this.db.read(tenantId, (tx) =>
      tx.availabilityInterval.findMany({
        where: { tenantId, endedAt: null, status: { not: 'offline' } },
        select: { membershipId: true },
      }),
    );
    if (!open.length) return 0;
    const connected = await this.presence.connectedAgentIds(tenantId);
    let closed = 0;
    for (const { membershipId } of open) {
      if (connected.has(membershipId)) continue;
      await this.recordInterval(tenantId, membershipId, 'offline', 'reconciliation');
      closed++;
    }
    if (closed) this.logger.log(`Closed ${closed} stale availability interval(s) for tenant ${tenantId}`);
    return closed;
  }

  private async recordInterval(
    tenantId: string,
    membershipId: string,
    forced: string | undefined,
    source: string,
  ) {
    await this.db.tx(tenantId, async (tx) => {
      const m = await tx.membership.findFirst({ where: { tenantId, id: membershipId } });
      if (!m) return;
      const connected = (await this.presence.connectedAgentIds(tenantId)).has(membershipId);
      const status = forced ?? (connected ? m.desiredStatus : 'offline');
      const open = await tx.availabilityInterval.findFirst({
        where: { tenantId, membershipId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (open?.status === status) return;
      const now = new Date();
      if (open) await tx.availabilityInterval.update({ where: { id: open.id }, data: { endedAt: now } });
      await tx.availabilityInterval.create({
        data: { tenantId, membershipId, status, startedAt: now, source },
      });
      await tx.membership.update({ where: { id: membershipId }, data: { lastSeenAt: now } });
    });
  }

  private async onLoadChanged(e: InternalEvent): Promise<void> {
    const p = e.payload;
    const chat = (p.chat ?? {}) as Record<string, unknown>;
    const participant = (p.participant ?? {}) as Record<string, unknown>;
    const ids = new Set(
      [
        p.owner_membership_id,
        p.previous_owner,
        p.next_owner,
        p.membership_id,
        participant.membership_id,
        chat.owner_membership_id,
      ].filter((x): x is string => typeof x === 'string' && x.length > 0),
    );
    for (const id of ids) await this.broadcastPresence(e.tenantId, id);
  }

  async broadcastPresence(tenantId: string, membershipId: string): Promise<void> {
    const m = await this.db.read(tenantId, (tx) =>
      tx.membership.findFirst({ where: { tenantId, id: membershipId } }),
    );
    if (!m) return;
    const connected = (await this.presence.connectedAgentIds(tenantId)).has(membershipId);
    const active = await this.db.read(tenantId, (tx) =>
      tx.chat.count({ where: { tenantId, ownerMembershipId: membershipId, status: 'active' } }),
    );
    this.realtime.ephemeral(
      AGENT_NS,
      roomFor(tenantId, 'team', 'all', 'staff'),
      'presence.updated',
      { kind: 'team', id: 'all' },
      {
        membershipId,
        effectiveStatus: !m.enabled || !connected ? 'offline' : m.desiredStatus,
        desiredStatus: m.desiredStatus,
        connected,
        activeCount: active,
        capacity: m.capacity,
        asOf: new Date(),
      },
      60_000,
    );
  }

  async setPresence(auth: AuthContext, status: DesiredStatus) {
    if (!auth.membershipId) throw denied();
    await this.db.tx(auth.tenantId, (tx) =>
      tx.membership.update({
        where: { id: auth.membershipId! },
        data: { desiredStatus: status, statusChangedAt: new Date() },
      }),
    );
    await this.recordInterval(auth.tenantId, auth.membershipId, undefined, 'manual');
    await this.broadcastPresence(auth.tenantId, auth.membershipId);
    this.broadcaster.schedule(auth.tenantId);
    if (status === 'online') await this.routing.drainQueue(auth.tenantId, 50);
    else await this.routing.withdrawOffersFor(auth.tenantId, auth.membershipId, `agent_${status}`);
    const connected = (await this.presence.connectedAgentIds(auth.tenantId)).has(auth.membershipId);
    return { desiredStatus: status, effectiveStatus: connected ? status : 'offline', connected };
  }

  async me(auth: AuthContext) {
    if (!auth.membershipId) throw denied();
    const agent = (await this.list(auth)).find((a) => a.id === auth.membershipId)!;
    const m = await this.db.read(auth.tenantId, (tx) =>
      tx.membership.findUniqueOrThrow({ where: { id: auth.membershipId! } }),
    );
    const stored = (m.preferences as Partial<MemberPreferences>) ?? {};
    return {
      agent,
      preferences: {
        ...DEFAULT_MEMBER_PREFERENCES,
        ...stored,
        // Per kind, so a kind added later starts on its default sound.
        sounds: { ...DEFAULT_MEMBER_PREFERENCES.sounds, ...(stored.sounds ?? {}) },
      },
      permissions: [...auth.permissions],
      departmentScope: auth.departmentScope,
    };
  }

  async updatePreferences(
    auth: AuthContext,
    patch: Omit<Partial<MemberPreferences>, 'sounds'> & {
      sounds?: Partial<MemberPreferences['sounds']>;
      displayName?: string | null;
      title?: string | null;
    },
  ) {
    if (!auth.membershipId) throw denied();
    const { displayName, title, ...prefs } = patch;
    await this.db.tx(auth.tenantId, async (tx) => {
      const m = await tx.membership.findUniqueOrThrow({ where: { id: auth.membershipId! } });
      await tx.membership.update({
        where: { id: m.id },
        data: {
          preferences: mergePreferences(m.preferences, prefs),
          ...(displayName !== undefined ? { displayName } : {}),
          ...(title !== undefined ? { title } : {}),
        },
      });
    });
    return this.me(auth);
  }

  // ───────── Invitations ─────────

  async invite(
    auth: AuthContext,
    input: { email: string; role: Role; departmentIds: string[]; capacity: number },
  ) {
    if (input.role === 'owner')
      throw badRequest('Ownership is transferred, not invited', {
        role: ['Choose admin, supervisor, agent or analyst'],
      });
    const user = auth.userId
      ? await this.db.root.user.findUniqueOrThrow({ where: { id: auth.userId } })
      : null;
    if (user && !user.emailVerifiedAt)
      throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address before inviting teammates');
    const email = input.email.trim().toLowerCase();
    const token = randomToken(32);
    const inv = await this.db.tx(auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
      const seats = await tx.membership.count({
        where: { tenantId: auth.tenantId, enabled: true, archivedAt: null },
      });
      const pending = await tx.agentInvitation.count({
        where: { tenantId: auth.tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      // With billing on, the paid agents are the limit (raise it in Settings, Billing); otherwise the entitlement.
      const billing = billingOn()
        ? await tx.billingAccount.findUnique({ where: { tenantId: auth.tenantId }, select: { seats: true } })
        : null;
      const limit = billing
        ? billing.seats
        : ((tenant.settings as { entitlements?: { agentSeats?: number } })?.entitlements?.agentSeats ?? 10);
      if (seats + pending >= limit)
        throw new AppError(
          409,
          'PLAN_LIMIT',
          billing
            ? `Your subscription includes ${limit} agent${limit === 1 ? '' : 's'}, counting pending invitations. Add agents in Settings, Billing first.`
            : `Your plan allows ${limit} enabled agents`,
        );
      const existing = await tx.membership.findFirst({
        where: { tenantId: auth.tenantId, user: { email }, archivedAt: null },
      });
      if (existing) throw conflict('CONFLICT', 'This person is already on the team');
      const valid = await tx.department.findMany({
        where: { tenantId: auth.tenantId, id: { in: input.departmentIds }, archivedAt: null },
        select: { id: true },
      });
      if (valid.length !== new Set(input.departmentIds).size) throw notFound('Department');
      await tx.agentInvitation.updateMany({
        where: { tenantId: auth.tenantId, email, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const row = await tx.agentInvitation.create({
        data: {
          tenantId: auth.tenantId,
          email,
          role: input.role,
          departmentIds: input.departmentIds,
          capacity: input.capacity,
          tokenHash: sha256(token),
          invitedById: auth.membershipId,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      await this.audit.inTx(tx, auth, {
        action: 'agent.invited',
        objectType: 'invitation',
        objectId: row.id,
        safeDiff: { role: input.role, departments: input.departmentIds.length },
      });
      return { row, tenantName: tenant.name };
    });
    const mail = await this.mail.sendTemplate(
      'agent_invitation',
      email,
      {
        inviter: auth.actorName,
        tenant: inv.tenantName,
        role: input.role,
        url: `${env().APP_URL}/invite/${encodeURIComponent(token)}`,
      },
      `invite:${inv.row.id}`,
      auth.tenantId,
    );
    return { id: inv.row.id, email, role: input.role, expiresAt: inv.row.expiresAt, mailId: mail.id };
  }

  async invitations(auth: AuthContext) {
    return this.db
      .read(auth.tenantId, (tx) =>
        tx.agentInvitation.findMany({
          where: {
            tenantId: auth.tenantId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          orderBy: { createdAt: 'desc' },
        }),
      )
      .then((rows) =>
        rows.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          departmentIds: r.departmentIds,
          capacity: r.capacity,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
        })),
      );
  }

  async revokeInvitation(auth: AuthContext, id: string) {
    await this.db.tx(auth.tenantId, async (tx) => {
      const r = await tx.agentInvitation.updateMany({
        where: { tenantId: auth.tenantId, id, acceptedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!r.count) throw notFound('Invitation');
      await this.audit.inTx(tx, auth, {
        action: 'agent.invitation_revoked',
        objectType: 'invitation',
        objectId: id,
      });
    });
  }

  async lookupInvitation(token: string) {
    const rows = await this.db.root.$queryRaw<
      Array<{
        id: string;
        tenant_id: string;
        email: string;
        role: string;
        expires_at: Date;
        accepted_at: Date | null;
        revoked_at: Date | null;
        tenant_name: string;
      }>
    >`
      SELECT * FROM rd_resolve_agent_invitation(${sha256(token)})`;
    const inv = rows[0];
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at < new Date())
      throw notFound('Invitation');
    const existing = await this.db.root.user.findUnique({
      where: { email: inv.email },
      select: { id: true },
    });
    return {
      tenantName: inv.tenant_name,
      email: inv.email,
      role: inv.role,
      hasAccount: !!existing,
      expiresAt: inv.expires_at,
    };
  }

  /** Accept an invitation: new users set a password; existing users must be signed in as the invited email. */
  async acceptInvitation(
    input: { token: string; displayName?: string; password?: string },
    user: UserContext | undefined,
    req: Request,
    res: Response,
  ) {
    const rows = await this.db.root.$queryRaw<
      Array<{
        id: string;
        tenant_id: string;
        email: string;
        role: Role;
        expires_at: Date;
        accepted_at: Date | null;
        revoked_at: Date | null;
        tenant_name: string;
      }>
    >`
      SELECT * FROM rd_resolve_agent_invitation(${sha256(input.token)})`;
    const inv = rows[0];
    const ctx = securityContext(req);
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at < new Date())
      throw new AppError(422, 'TOKEN_EXPIRED', 'This invitation is invalid or has expired');
    let userId: string;
    if (user) {
      const u = await this.db.root.user.findUniqueOrThrow({ where: { id: user.userId } });
      if (u.email !== inv.email)
        throw denied(`This invitation was sent to ${inv.email}. Sign in with that account.`);
      userId = u.id;
    } else {
      const existing = await this.db.root.user.findUnique({ where: { email: inv.email } });
      if (existing) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to accept this invitation');
      if (!input.password) throw badRequest('Choose a password', { password: ['Required'] });
      validatePassword(input.password);
      const created = await this.db.root.user.create({
        data: {
          email: inv.email,
          displayName: (input.displayName?.trim() || inv.email.split('@')[0]).slice(0, 120),
          passwordHash: await this.auth.hashPassword(input.password),
          emailVerifiedAt: new Date(),
        },
      });
      userId = created.id;
    }
    await this.db.tx(inv.tenant_id, async (tx) => {
      const row = await tx.agentInvitation.findUniqueOrThrow({ where: { id: inv.id } });
      if (row.acceptedAt) throw new AppError(422, 'TOKEN_USED', 'This invitation has already been used');
      const m = await tx.membership.upsert({
        where: { tenantId_userId: { tenantId: inv.tenant_id, userId } },
        create: {
          tenantId: inv.tenant_id,
          userId,
          role: row.role,
          capacity: row.capacity,
          displayName: input.displayName?.trim() || null,
        },
        update: { archivedAt: null, enabled: true, role: row.role, capacity: row.capacity },
      });
      await tx.$executeRaw`INSERT INTO agent_capacity (tenant_id, membership_id) VALUES (${inv.tenant_id}::uuid, ${m.id}::uuid) ON CONFLICT DO NOTHING`;
      for (const d of row.departmentIds) {
        await tx.departmentMember.upsert({
          where: {
            tenantId_departmentId_membershipId: {
              tenantId: inv.tenant_id,
              departmentId: d,
              membershipId: m.id,
            },
          },
          create: {
            tenantId: inv.tenant_id,
            departmentId: d,
            membershipId: m.id,
            canServe: true,
            canMonitor: row.role === 'supervisor',
          },
          update: {},
        });
      }
      await tx.agentInvitation.update({ where: { id: row.id }, data: { acceptedAt: new Date() } });
      await tx.auditEvent.create({
        data: {
          tenantId: inv.tenant_id,
          actorType: 'user',
          actorId: userId,
          action: 'agent.joined',
          objectType: 'membership',
          objectId: m.id,
          safeDiff: { role: row.role },
          requestId: ctx.requestId || null,
          ipHash: ctx.ipHash ?? null,
        },
      });
    });
    if (user) {
      await this.sessions.setActiveTenant(user.sessionId, inv.tenant_id);
      await this.sessions.rotate(user.sessionId, res);
      return this.auth.me(userId, inv.tenant_id);
    }
    await this.sessions.create({ id: userId }, req, res, inv.tenant_id);
    return this.auth.me(userId, inv.tenant_id);
  }

  // ───────── Membership administration ─────────

  async update(
    auth: AuthContext,
    id: string,
    input: {
      displayName?: string | null;
      title?: string | null;
      role?: Role;
      enabled?: boolean;
      capacity?: number;
      expectedVersion?: number;
    },
  ) {
    const { expectedVersion, ...patch } = input;
    const revoke = await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'memberships', auth.tenantId, id);
      const m = await tx.membership.findFirst({ where: { tenantId: auth.tenantId, id, archivedAt: null } });
      if (!m) throw notFound('Agent');
      if (expectedVersion !== undefined && m.version !== expectedVersion) throw versionConflict(m.version);
      const self = id === auth.membershipId;
      const adminAction =
        patch.role !== undefined || patch.enabled !== undefined || patch.capacity !== undefined;
      if (adminAction && !auth.permissions.has('agents.manage')) throw denied();
      if (!adminAction && !self && !auth.permissions.has('agents.manage')) throw denied();
      if (
        (patch.role as string) === 'owner' ||
        (m.role === 'owner' && patch.role && (patch.role as string) !== 'owner')
      ) {
        throw conflict('CONFLICT', 'Use ownership transfer to change the owner');
      }
      if (m.role === 'owner' && patch.enabled === false)
        throw conflict('CONFLICT', 'The owner cannot be suspended. Transfer ownership first.');
      if (patch.enabled === true && !m.enabled && billingOn()) {
        // Re-enabling someone uses a paid agent like an invitation does.
        const billing = await tx.billingAccount.findUnique({
          where: { tenantId: auth.tenantId },
          select: { seats: true },
        });
        const used = await tx.membership.count({
          where: { tenantId: auth.tenantId, enabled: true, archivedAt: null },
        });
        if (billing && used >= billing.seats)
          throw new AppError(
            409,
            'PLAN_LIMIT',
            `Your subscription includes ${billing.seats} agent${billing.seats === 1 ? '' : 's'}. Add agents in Settings, Billing first.`,
          );
      }
      if (patch.role && patch.role !== m.role && m.role === 'admin' && auth.role !== 'owner')
        throw denied('Only the owner can change an admin');
      const u = await tx.membership.update({ where: { id }, data: { ...patch, version: { increment: 1 } } });
      await this.audit.inTx(tx, auth, {
        action:
          patch.enabled === false ? 'agent.suspended' : patch.role ? 'agent.role_changed' : 'agent.updated',
        objectType: 'membership',
        objectId: id,
        safeDiff: { before: { role: m.role, enabled: m.enabled, capacity: m.capacity }, after: patch },
      });
      return patch.enabled === false || (patch.role && patch.role !== m.role) ? u : null;
    });
    if (revoke) {
      // Revocation reaches live sockets immediately; sessions re-check membership on every request.
      this.realtime.revokeMembership(
        auth.tenantId,
        id,
        revoke.enabled ? 'role_changed' : 'membership_suspended',
      );
      if (!revoke.enabled) {
        await this.routing.withdrawOffersFor(auth.tenantId, id, 'agent_suspended');
        const released = await this.routing.releaseAgentChats(auth.tenantId, id, 'agent_suspended');
        if (released) this.logger.log(`Requeued ${released} chat(s) of suspended agent ${id}`);
      }
      this.broadcaster.schedule(auth.tenantId);
    }
    return (await this.list(auth)).find((a) => a.id === id);
  }

  async setDepartments(
    auth: AuthContext,
    id: string,
    input: Array<{ departmentId: string; canServe: boolean; canMonitor: boolean }>,
    expectedVersion?: number,
  ) {
    await this.db.tx(auth.tenantId, async (tx) => {
      await lockForUpdate(tx, 'memberships', auth.tenantId, id);
      const m = await tx.membership.findFirst({ where: { tenantId: auth.tenantId, id, archivedAt: null } });
      if (!m) throw notFound('Agent');
      if (expectedVersion !== undefined && m.version !== expectedVersion) throw versionConflict(m.version);
      const ids = input.map((d) => d.departmentId);
      const valid = await tx.department.findMany({
        where: { tenantId: auth.tenantId, id: { in: ids } },
        select: { id: true },
      });
      if (valid.length !== new Set(ids).size) throw notFound('Department');
      await tx.departmentMember.deleteMany({ where: { tenantId: auth.tenantId, membershipId: id } });
      if (input.length)
        await tx.departmentMember.createMany({
          data: input.map((d) => ({
            tenantId: auth.tenantId,
            membershipId: id,
            departmentId: d.departmentId,
            canServe: d.canServe,
            canMonitor: d.canMonitor,
          })),
        });
      await tx.membership.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.audit.inTx(tx, auth, {
        action: 'agent.departments_set',
        objectType: 'membership',
        objectId: id,
        safeDiff: { departments: ids },
      });
    });
    this.realtime.revokeMembership(auth.tenantId, id, 'scope_changed');
    this.broadcaster.schedule(auth.tenantId);
    return (await this.list(auth)).find((a) => a.id === id);
  }

  async transferOwnership(auth: AuthContext, targetMembershipId: string, reason: string) {
    if (auth.role !== 'owner') throw denied('Only the owner can transfer ownership');
    await this.db.tx(auth.tenantId, async (tx) => {
      const target = await tx.membership.findFirst({
        where: { tenantId: auth.tenantId, id: targetMembershipId, enabled: true, archivedAt: null },
        include: { user: true },
      });
      if (!target) throw notFound('Agent');
      if (!target.user.emailVerifiedAt)
        throw conflict('CONFLICT', 'The new owner must have a verified email address');
      await tx.membership.update({ where: { id: auth.membershipId! }, data: { role: 'admin' } });
      await tx.membership.update({ where: { id: target.id }, data: { role: 'owner' } });
      await tx.tenant.update({ where: { id: auth.tenantId }, data: { ownerUserId: target.userId } });
      await this.audit.inTx(tx, auth, {
        action: 'tenant.ownership_transferred',
        objectType: 'tenant',
        objectId: auth.tenantId,
        safeDiff: { from: auth.membershipId, to: target.id, reason },
      });
    });
    this.realtime.revokeMembership(auth.tenantId, auth.membershipId!, 'role_changed');
    this.realtime.revokeMembership(auth.tenantId, targetMembershipId, 'role_changed');
    return { ok: true };
  }
}
