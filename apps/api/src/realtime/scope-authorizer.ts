import { Injectable } from '@nestjs/common';
import { TenantDb } from '../db/tenant-db';
import type { AuthContext, VisitorContext } from '../common/http';
import type { ScopeKind } from '../outbox/outbox.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authorizes socket subscriptions (ch. 04/47): a principal can never subscribe
 * to arbitrary tenant, visitor or chat ids. Every scope is checked server side.
 */
@Injectable()
export class ScopeAuthorizer {
  constructor(private readonly db: TenantDb) {}

  async canAgentSubscribe(auth: AuthContext, kind: ScopeKind, id: string): Promise<boolean> {
    if (typeof id !== 'string' || id.length > 64) return false;
    switch (kind) {
      case 'agent':
        return id === auth.membershipId;
      case 'team':
        return id === 'all' && auth.permissions.has('agents.view');
      case 'queue':
        if (!auth.permissions.has('chats.serve') && !auth.permissions.has('chats.monitor')) return false;
        if (id === 'none' || auth.departmentScope === 'all') return id === 'none' || (await this.departmentExists(auth.tenantId, id));
        return auth.departmentScope.includes(id);
      case 'chat': {
        if (!UUID.test(id)) return false;
        if (!auth.permissions.has('chats.serve') && !auth.permissions.has('history.view') && !auth.permissions.has('chats.monitor')) return false;
        const chat = await this.db.read(auth.tenantId, (tx) =>
          tx.chat.findFirst({ where: { tenantId: auth.tenantId, id }, select: { departmentId: true, ownerMembershipId: true, participants: { where: { membershipId: auth.membershipId ?? '__none__' }, select: { id: true } } } }),
        );
        if (!chat) return false;
        if (auth.departmentScope === 'all') return true;
        return !chat.departmentId || auth.departmentScope.includes(chat.departmentId) || chat.ownerMembershipId === auth.membershipId || chat.participants.length > 0;
      }
      case 'visitor':
        return auth.permissions.has('visitors.view') && (id === 'all' || (await this.siteExists(auth.tenantId, id)));
      case 'config':
        return auth.permissions.has('sites.view') && (await this.siteExists(auth.tenantId, id));
      case 'tenant':
        return false;
      default:
        return false;
    }
  }

  async canVisitorSubscribe(v: VisitorContext, kind: ScopeKind, id: string): Promise<boolean> {
    if (typeof id !== 'string' || id.length > 64) return false;
    if (kind === 'visitor') return id === v.sessionId;
    if (kind === 'config') return id === v.siteId;
    if (kind === 'chat') {
      if (!UUID.test(id)) return false;
      const chat = await this.db.read(v.tenantId, (tx) => tx.chat.findFirst({ where: { tenantId: v.tenantId, id, visitorId: v.visitorId }, select: { id: true } }));
      return !!chat;
    }
    return false;
  }

  private async departmentExists(tenantId: string, id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    return !!(await this.db.read(tenantId, (tx) => tx.department.findFirst({ where: { tenantId, id }, select: { id: true } })));
  }

  private async siteExists(tenantId: string, id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
    return !!(await this.db.read(tenantId, (tx) => tx.site.findFirst({ where: { tenantId, id }, select: { id: true } })));
  }
}
