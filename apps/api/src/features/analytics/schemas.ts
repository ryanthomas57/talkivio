import { z } from 'zod';
import { denied } from '../../common/http';
import type { Permission } from '../../common/permissions';

const uuid = z.string().uuid();
const bound = z.string().trim().min(10).max(40);
const flag = z
  .union([z.boolean(), z.enum(['0', '1', 'true', 'false'])])
  .optional()
  .transform((v) => v === true || v === '1' || v === 'true');

const chatsFilterShape = {
  from: bound,
  to: bound,
  timezone: z.string().trim().min(1).max(64).optional(),
  groupBy: z.enum(['hour', 'day', 'week']).default('day'),
  siteId: uuid.optional(),
  departmentId: uuid.optional(),
  currentDepartmentId: uuid.optional(),
  agentId: uuid.optional(),
  tagId: uuid.optional(),
  compare: z.enum(['previous', 'none', 'custom']).default('previous'),
  compareFrom: bound.optional(),
  compareTo: bound.optional(),
};

/** GET /analytics/chats (query string). */
export const chatsQuerySchema = z.object({ ...chatsFilterShape, reconcile: flag }).strict();
export type ChatsQuery = z.infer<typeof chatsQuerySchema>;
export const chatsFiltersSchema = z.object(chatsFilterShape).strict();

const agentsFilterShape = {
  from: bound,
  to: bound,
  timezone: z.string().trim().min(1).max(64).optional(),
  departmentId: uuid.optional(),
  agentId: uuid.optional(),
  siteId: uuid.optional(),
};
export const agentsQuerySchema = z.object(agentsFilterShape).strict();
export type AgentsQuery = z.infer<typeof agentsQuerySchema>;

const invitationsFilterShape = {
  from: bound,
  to: bound,
  timezone: z.string().trim().min(1).max(64).optional(),
  siteId: uuid.optional(),
  campaignId: uuid.optional(),
  departmentId: uuid.optional(),
};
export const invitationsQuerySchema = z.object(invitationsFilterShape).strict();
export type InvitationsQuery = z.infer<typeof invitationsQuerySchema>;

export const exportRequestSchema = z.discriminatedUnion('report', [
  z.object({ report: z.literal('chats'), format: z.literal('csv').default('csv'), filters: chatsFiltersSchema }).strict(),
  z.object({ report: z.literal('agents'), format: z.literal('csv').default('csv'), filters: agentsQuerySchema }).strict(),
  z.object({ report: z.literal('invitations'), format: z.literal('csv').default('csv'), filters: invitationsQuerySchema }).strict(),
]);
export type ExportRequest = z.infer<typeof exportRequestSchema>;

export const monitorQuerySchema = z.object({ departmentId: uuid.optional(), siteId: uuid.optional() }).strict();
export type MonitorQuery = z.infer<typeof monitorQuerySchema>;

/** Who is asking: tenant, permissions and department scope (from AuthContext or re-derived in the worker). */
export interface AnalyticsActor {
  tenantId: string;
  membershipId: string | null;
  permissions: ReadonlySet<Permission>;
  /** 'all' for tenant-wide roles and integration tokens, otherwise served ∪ monitored department ids. */
  departmentScope: 'all' | string[];
}

/** A department-filter value must be inside the actor's scope (never reveal other departments). */
export function assertDepartmentInScope(actor: AnalyticsActor, departmentId: string | null | undefined): void {
  if (!departmentId || actor.departmentScope === 'all') return;
  if (!actor.departmentScope.includes(departmentId)) throw denied('That department is outside your reporting scope');
}

/**
 * Is a record visible to the actor? Visible when the scope is tenant-wide, when
 * any of its departments (acquisition or current) is in scope, or when it has no
 * department at all (the shared no-department queue, as for chat access).
 */
export function visibleInScope(scope: 'all' | string[], departments: Array<string | null | undefined>): boolean {
  if (scope === 'all') return true;
  const ids = departments.filter((d): d is string => !!d);
  if (!ids.length) return true;
  return ids.some((d) => scope.includes(d));
}

export function scopeKey(scope: 'all' | string[]): string {
  return scope === 'all' ? 'all' : [...scope].sort().join(',');
}
