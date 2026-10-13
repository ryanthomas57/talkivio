/**
 * Server-side permission model (ch. 04). UI hiding is never the control; every
 * route and socket command checks one of these permissions, and department-scoped
 * permissions are further narrowed by `departmentScope`.
 */
import type { Role } from '@prisma/client';

export const PERMISSIONS = [
  'tenant.read',
  'tenant.manage',
  'tenant.owner',
  'billing.manage',
  'agents.view',
  'agents.manage',
  'departments.view',
  'departments.manage',
  'sites.view',
  'sites.manage',
  'schedules.view',
  'schedules.manage',
  'triggers.view',
  'triggers.manage',
  'shortcuts.view',
  'shortcuts.manage_shared',
  'shortcuts.manage_department',
  'shortcuts.manage_personal',
  'chats.serve',
  'chats.monitor',
  'chats.force_transfer',
  'history.view',
  'notes.view',
  'visitors.view',
  'visitors.edit',
  'bans.manage',
  'exports.create',
  'exports.internal',
  'analytics.view',
  'analytics.agents',
  'monitor.view',
  'audit.view',
  'integrations.manage',
  'privacy.manage',
  'offline.view',
  'tags.create',
  'tags.manage',
  'custom_fields.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const AGENT: Permission[] = [
  'tenant.read',
  'agents.view',
  'departments.view',
  'shortcuts.view',
  'shortcuts.manage_personal',
  'chats.serve',
  'history.view',
  'notes.view',
  'visitors.view',
  'visitors.edit',
  'exports.create',
  'offline.view',
  'tags.create',
];

const SUPERVISOR: Permission[] = [
  ...AGENT,
  'sites.view',
  'schedules.view',
  'triggers.view',
  'shortcuts.manage_department',
  'chats.monitor',
  'chats.force_transfer',
  'bans.manage',
  'exports.internal',
  'analytics.view',
  'analytics.agents',
  'monitor.view',
];

const ADMIN: Permission[] = PERMISSIONS.filter((p) => p !== 'tenant.owner' && p !== 'billing.manage');

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  admin: new Set(ADMIN),
  supervisor: new Set(SUPERVISOR),
  agent: new Set(AGENT),
  analyst: new Set<Permission>(['tenant.read', 'analytics.view', 'analytics.agents', 'departments.view', 'agents.view']),
};

/** Roles whose data scope is the whole tenant; others are limited to their departments. */
export const TENANT_WIDE_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'analyst']);

/** Integration token scopes → permissions (ch. 55). Tokens can never exceed admin permissions. */
export const TOKEN_SCOPE_PERMISSIONS: Record<string, Permission[]> = {
  'chats:read': ['history.view', 'notes.view', 'tenant.read', 'departments.view', 'agents.view'],
  'chats:write': ['chats.serve', 'chats.monitor', 'chats.force_transfer', 'tags.create'],
  'visitors:read': ['visitors.view'],
  'visitors:write': ['visitors.view', 'visitors.edit', 'tags.create'],
  'analytics:read': ['analytics.view', 'analytics.agents', 'monitor.view'],
  'webhooks:manage': ['integrations.manage'],
};
export const TOKEN_SCOPES = Object.keys(TOKEN_SCOPE_PERMISSIONS);

export function permissionsForRole(role: Role): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

export function permissionsForScopes(scopes: string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const s of scopes) for (const p of TOKEN_SCOPE_PERMISSIONS[s] ?? []) if (ROLE_PERMISSIONS.admin.has(p)) out.add(p);
  return out;
}
