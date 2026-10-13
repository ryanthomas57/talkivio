/** Team: agents, invitations, presence, departments and tags (ch. 42/43). */
import { z } from 'zod';
import { DateTime, DepartmentScopeSchema, RoleSchema, Uuid } from './common.ts';

export const PermissionSchema = z.enum([
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
]);

export const DesiredStatusSchema = z.enum(['online', 'away', 'invisible']);
export const EffectiveStatusSchema = z.enum(['online', 'away', 'invisible', 'offline']);

/** Roster entry (`GET /agents`). */
export const AgentSchema = z.object({
  id: Uuid,
  userId: Uuid,
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  title: z.string().nullable(),
  role: RoleSchema,
  enabled: z.boolean(),
  desiredStatus: DesiredStatusSchema,
  effectiveStatus: EffectiveStatusSchema,
  connected: z.boolean(),
  activeChats: z.number().int(),
  capacity: z.number().int(),
  departmentIds: z.array(Uuid),
  lastSeenAt: DateTime.nullable(),
  version: z.number().int(),
});

/** The signed-in member (`GET /agents/me`). */
export const AgentMeSchema = z.object({
  agent: AgentSchema,
  preferences: z.object({ sendOnEnter: z.boolean(), sound: z.boolean(), desktopNotifications: z.boolean(), theme: z.enum(['system', 'light', 'dark']), privacyMode: z.boolean(), locale: z.enum(['en', 'ar']).nullable() }),
  permissions: z.array(PermissionSchema),
  departmentScope: DepartmentScopeSchema,
});

export const PresenceStateSchema = z.object({ desiredStatus: DesiredStatusSchema, effectiveStatus: EffectiveStatusSchema, connected: z.boolean() });

export const AgentInvitationSchema = z.object({
  id: Uuid,
  email: z.string(),
  role: RoleSchema,
  departmentIds: z.array(Uuid),
  capacity: z.number().int(),
  createdAt: DateTime,
  expiresAt: DateTime,
});
export const AgentInvitationCreatedSchema = z.object({ id: Uuid, email: z.string(), role: RoleSchema, expiresAt: DateTime, mailId: z.string() });
export const InvitationLookupSchema = z.object({ tenantName: z.string(), email: z.string(), role: RoleSchema, hasAccount: z.boolean(), expiresAt: DateTime });

export const DepartmentSchema = z.object({
  id: Uuid,
  name: z.string(),
  publicLabel: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  scheduleId: Uuid.nullable(),
  routingMode: z.enum(['manual', 'broadcast', 'assigned']),
  queueLimit: z.number().int(),
  maxWaitSeconds: z.number().int(),
  fallbackDepartmentId: Uuid.nullable(),
  archivedAt: DateTime.nullable(),
  members: z.array(z.object({ membershipId: Uuid, canServe: z.boolean(), canMonitor: z.boolean() })),
  queued: z.number().int(),
  version: z.number().int(),
});

export const TagSchema = z.object({ id: Uuid, slug: z.string(), label: z.string() });

export type Agent = z.infer<typeof AgentSchema>;
export type AgentMe = z.infer<typeof AgentMeSchema>;
export type Department = z.infer<typeof DepartmentSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type Permission = z.infer<typeof PermissionSchema>;
