import { Injectable, Logger } from '@nestjs/common';
import type { Ban, Prisma } from '@prisma/client';
import { TenantDb, type Tx } from '../../db/tenant-db';
import { AuditService } from '../../common/audit.service';
import { hashIp, sha256 } from '../../common/crypto';
import { AppError, badRequest, conflict, notFound, type AuthContext } from '../../common/http';
import { decodeCursor, encodeCursor, page } from '../../common/wire';
import { ChatCommandsService } from '../chats/chat-commands.service';
import {
  canonicalBanIp,
  displayNameOf,
  ipBanFilter,
  maskIp,
  pageLimit,
  type VisitorIp,
} from './visitor-common';
import { VisitorMonitorService } from './visitor-monitor.service';
import { RealtimeService } from '../../realtime/realtime.service';

const MAX_BAN_DAYS = 3650;
export const IP_COLLATERAL_WARNING =
  'IP bans can block other people who share this network address (offices, mobile carriers, VPNs).';
const IP_RANGE_REFUSED =
  'Ban an exact address or an IPv6 /64; other CIDR ranges are not accepted by this policy';

export interface BanResource {
  id: string;
  target: { kind: 'visitor'; visitorId: string; displayName: string | null } | { kind: 'ip'; masked: string };
  siteId: string | null;
  reason: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  active: boolean;
  createdAt: Date;
  createdBy: string;
  revokedBy: string | null;
  collateralWarning?: string;
  closedChatIds?: string[];
}

/**
 * Bans (ch. 24): tenant (optionally site) scoped visitor, exact-IP or IPv6 /64 bans
 * with optional expiry. IPs are never stored raw: a keyed hash (`hashIp` of the
 * canonical address or of the `ipBucket` /64 text, the hashes the widget guard puts
 * on VisitorContext as ipHash / ipNetHash) matches, a masked string displays.
 * Wider ranges stay refused: hashes only match whole values, and anything broader
 * than one subscriber's /64 blocks bystanders.
 * Enforcement lives in ChatCommandsService.assertNotBanned (new chats, messages,
 * offline submissions) and in the widget bootstrap/session endpoints.
 */
@Injectable()
export class BansService {
  private readonly logger = new Logger('Bans');

  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly chats: ChatCommandsService,
    private readonly monitor: VisitorMonitorService,
    private readonly realtime: RealtimeService,
  ) {}

  private resource(b: Ban, names: Map<string, string>): BanResource {
    const now = Date.now();
    return {
      id: b.id,
      target: b.visitorId
        ? { kind: 'visitor', visitorId: b.visitorId, displayName: names.get(b.visitorId) ?? null }
        : { kind: 'ip', masked: b.ipMasked ?? 'hidden' },
      siteId: b.siteId,
      reason: b.reason,
      expiresAt: b.expiresAt,
      revokedAt: b.revokedAt,
      active: !b.revokedAt && (!b.expiresAt || b.expiresAt.getTime() > now),
      createdAt: b.createdAt,
      createdBy: b.createdBy,
      revokedBy: b.revokedBy,
    };
  }

  async create(
    auth: AuthContext,
    input: {
      visitorId?: string | null;
      ip?: string | null;
      siteId?: string | null;
      expiresAt?: string | null;
      reason: string;
      closeActiveChat?: boolean;
    },
  ): Promise<BanResource> {
    if (!auth.userId)
      throw new AppError(403, 'PERMISSION_DENIED', 'Bans must be created by a signed-in staff member');
    const targets = [input.visitorId, input.ip].filter((x) => x !== undefined && x !== null && x !== '');
    if (targets.length !== 1)
      throw badRequest('Choose exactly one target: a visitor or an IP address', {
        visitor_id: ['Exactly one target'],
        ip: ['Exactly one target'],
      });
    const reason = input.reason.trim();
    if (!reason) throw badRequest('A reason is required', { reason: ['Required'] });
    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      expiresAt = new Date(input.expiresAt);
      if (Number.isNaN(expiresAt.getTime()))
        throw badRequest('Invalid expiry', { expires_at: ['Use an RFC 3339 timestamp'] });
      if (expiresAt.getTime() <= Date.now())
        throw badRequest('Expiry must be in the future', { expires_at: ['Must be in the future'] });
      if (expiresAt.getTime() > Date.now() + MAX_BAN_DAYS * 86_400_000)
        throw badRequest('Expiry is too far in the future', { expires_at: [`At most ${MAX_BAN_DAYS} days`] });
    }
    let ip: string | null = null;
    if (input.ip) {
      if (input.ip.includes('/') && !/\/(32|64|128)$/.test(input.ip.trim()))
        throw badRequest(IP_RANGE_REFUSED, { ip: ['CIDR ranges are not allowed'] });
      ip = canonicalBanIp(input.ip);
      if (!ip && input.ip.trim().endsWith('/64'))
        throw badRequest(IP_RANGE_REFUSED, { ip: ['Use an IPv6 /64 such as 2001:db8:1:2::/64'] });
      if (!ip) throw badRequest('Enter a valid IPv4 or IPv6 address', { ip: ['Invalid IP address'] });
    }
    const ipHash = ip ? hashIp(ip) : null;

    const result = await this.db.tx(auth.tenantId, async (tx) => {
      if (
        input.siteId &&
        !(await tx.site.findFirst({
          where: { tenantId: auth.tenantId, id: input.siteId },
          select: { id: true },
        }))
      )
        throw notFound('Site');
      let visitorName: string | null = null;
      if (input.visitorId) {
        const v = await tx.visitor.findFirst({
          where: { tenantId: auth.tenantId, id: input.visitorId },
          select: { id: true, name: true, anonymousLabel: true },
        });
        if (!v) throw notFound('Visitor');
        visitorName = displayNameOf(v);
      }
      const activeWhere: Prisma.BanWhereInput = {
        tenantId: auth.tenantId,
        revokedAt: null,
        siteId: input.siteId ?? null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        ...(input.visitorId ? { visitorId: input.visitorId } : { ipMatchHash: ipHash }),
      };
      const dup = await tx.ban.findFirst({ where: activeWhere, select: { id: true } });
      if (dup)
        throw conflict('CONFLICT', 'An active ban for this target already exists', false, { banId: dup.id });
      const ban = await tx.ban.create({
        data: {
          tenantId: auth.tenantId,
          siteId: input.siteId ?? null,
          visitorId: input.visitorId ?? null,
          ipMatchHash: ipHash,
          ipMasked: ip ? maskIp(ip) : null,
          reason: reason.slice(0, 500),
          expiresAt,
          createdBy: auth.userId!,
        },
      });
      await this.audit.inTx(tx, auth, {
        action: 'ban.created',
        objectType: 'ban',
        objectId: ban.id,
        safeDiff: {
          target: input.visitorId ? 'visitor' : 'ip',
          visitor_id: input.visitorId ?? null,
          site_id: input.siteId ?? null,
          expires_at: expiresAt?.toISOString() ?? null,
          close_active_chat: !!input.closeActiveChat,
        },
      });
      const open =
        input.visitorId && input.closeActiveChat
          ? await tx.chat.findMany({
              where: {
                tenantId: auth.tenantId,
                visitorId: input.visitorId,
                status: { not: 'closed' },
                ...(input.siteId ? { siteId: input.siteId } : {}),
              },
              select: { id: true },
            })
          : [];
      return { ban, visitorName, openChatIds: open.map((c) => c.id) };
    });

    // A visitor ban cuts live sockets immediately (not at the next page load). REST sends and
    // admissions already answer the neutral 403 SERVICE_UNAVAILABLE, and so does minting a new
    // socket ticket, so the widget cannot reconnect while banned. (IP bans: next ticket/admission.)
    if (input.visitorId) this.realtime.revokeVisitor(auth.tenantId, input.visitorId, 'banned');

    const closed: string[] = [];
    for (const chatId of result.openChatIds) {
      try {
        await this.chats.close({ kind: 'system', tenantId: auth.tenantId }, chatId, { reason: 'banned' });
        closed.push(chatId);
      } catch (err) {
        this.logger.warn(`Closing chat ${chatId} after ban failed: ${(err as Error).message}`);
      }
    }
    if (input.visitorId) await this.monitor.markDirty(auth.tenantId, [input.visitorId]);
    const names = new Map(
      result.visitorName && input.visitorId ? [[input.visitorId, result.visitorName]] : [],
    );
    return {
      ...this.resource(result.ban, names),
      ...(ip ? { collateralWarning: IP_COLLATERAL_WARNING } : {}),
      ...(input.visitorId ? { closedChatIds: closed } : {}),
    };
  }

  async list(auth: AuthContext, q: { active?: boolean; cursor?: string; limit?: number }) {
    const limit = pageLimit(q.limit);
    const filterHash = sha256(JSON.stringify({ active: q.active ?? null })).slice(0, 16);
    const cur = decodeCursor<{ t: string; id: string }>(q.cursor, filterHash);
    if (q.cursor && !cur)
      throw badRequest('This cursor does not match the current filters', { cursor: ['Invalid cursor'] });
    const now = new Date();
    return this.db.read(auth.tenantId, async (tx) => {
      const and: Prisma.BanWhereInput[] = [{ tenantId: auth.tenantId }];
      if (q.active === true)
        and.push({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
      if (q.active === false) and.push({ OR: [{ revokedAt: { not: null } }, { expiresAt: { lte: now } }] });
      if (cur)
        and.push({
          OR: [{ createdAt: { lt: new Date(cur.t) } }, { createdAt: new Date(cur.t), id: { lt: cur.id } }],
        });
      const rows = await tx.ban.findMany({
        where: { AND: and },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const slice = rows.slice(0, limit);
      const visitorIds = [...new Set(slice.map((b) => b.visitorId).filter((v): v is string => !!v))];
      const visitors = visitorIds.length
        ? await tx.visitor.findMany({
            where: { tenantId: auth.tenantId, id: { in: visitorIds } },
            select: { id: true, name: true, anonymousLabel: true },
          })
        : [];
      const names = new Map(visitors.map((v) => [v.id, displayNameOf(v)]));
      const last = slice[slice.length - 1];
      return page(
        slice.map((b) => this.resource(b, names)),
        rows.length > limit && last
          ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }, filterHash)
          : null,
      );
    });
  }

  /** Idempotent unban: the first revocation is audited; repeats are no-ops. */
  async revoke(auth: AuthContext, id: string): Promise<void> {
    const visitorId = await this.db.tx(auth.tenantId, async (tx) => {
      const ban = await tx.ban.findFirst({ where: { tenantId: auth.tenantId, id } });
      if (!ban) throw notFound('Ban');
      if (ban.revokedAt) return null;
      await tx.ban.update({ where: { id }, data: { revokedAt: new Date(), revokedBy: auth.userId ?? null } });
      await this.audit.inTx(tx, auth, {
        action: 'ban.revoked',
        objectType: 'ban',
        objectId: id,
        safeDiff: { target: ban.visitorId ? 'visitor' : 'ip', site_id: ban.siteId },
      });
      return ban.visitorId;
    });
    if (visitorId) await this.monitor.markDirty(auth.tenantId, [visitorId]);
  }

  /**
   * Public enforcement for widget bootstrap/session: same predicate as
   * ChatCommandsService.assertNotBanned (tenant + site scope, unrevoked,
   * unexpired, visitor, exact-IP hash or IPv6 /64 hash).
   */
  async isBanned(
    tenantId: string,
    siteId: string,
    visitorId: string | null,
    ip: VisitorIp,
  ): Promise<boolean> {
    if (!visitorId && !ipBanFilter(ip).length) return false;
    return this.db.read(tenantId, (tx) => this.isBannedTx(tx, tenantId, siteId, visitorId, ip));
  }

  async isBannedTx(
    tx: Tx,
    tenantId: string,
    siteId: string,
    visitorId: string | null,
    ip: VisitorIp,
  ): Promise<boolean> {
    const ipMatch = ipBanFilter(ip);
    if (!visitorId && !ipMatch.length) return false;
    const n = await tx.ban.count({
      where: {
        tenantId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        AND: [
          { OR: [{ siteId: null }, { siteId }] },
          { OR: [...(visitorId ? [{ visitorId }] : []), ...ipMatch] },
        ],
      },
    });
    return n > 0;
  }
}

/** Neutral public copy (ch. 24): never accuse or reveal internal notes to the visitor. */
export function serviceUnavailable(): AppError {
  return new AppError(403, 'SERVICE_UNAVAILABLE', 'Service unavailable');
}
