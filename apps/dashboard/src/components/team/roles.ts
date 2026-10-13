import type { MessageKey } from '@/i18n';
import type { Role } from '@/lib/types';

/** Roles that can be granted through invitations and role changes (owner is transferred, never assigned). */
export const ASSIGNABLE_ROLES: Exclude<Role, 'owner'>[] = ['admin', 'supervisor', 'agent', 'analyst'];
export const ALL_ROLES: Role[] = ['owner', 'admin', 'supervisor', 'agent', 'analyst'];

/** Message keys: render with t(ROLE_LABEL[role]). */
export const ROLE_LABEL: Record<Role, MessageKey> = {
  owner: 'team.role.owner',
  admin: 'team.role.admin',
  supervisor: 'team.role.supervisor',
  agent: 'team.role.agent',
  analyst: 'team.role.analyst',
};

/**
 * Plain-language permission summary per role (ch. 04), mirroring the server's
 * ROLE_PERMISSIONS map. The API remains the authority for every action. Values are message keys.
 */
export const ROLE_SUMMARY: Record<Role, { summary: MessageKey; can: MessageKey[]; cannot: MessageKey[] }> = {
  owner: {
    summary: 'team.roleSummary.owner.summary',
    can: ['team.roleSummary.owner.everythingAdmin', 'team.roleSummary.transferOwnership', 'team.roleSummary.owner.billingSecrets'],
    cannot: [],
  },
  admin: {
    summary: 'team.roleSummary.admin.summary',
    can: [
      'team.roleSummary.admin.agents',
      'team.roleSummary.admin.config',
      'team.roleSummary.admin.integrations',
      'team.roleSummary.admin.chats',
    ],
    cannot: ['team.roleSummary.transferOwnership', 'team.roleSummary.manageBilling'],
  },
  supervisor: {
    summary: 'team.roleSummary.supervisor.summary',
    can: [
      'team.roleSummary.supervisor.chats',
      'team.roleSummary.supervisor.coach',
      'team.roleSummary.supervisor.reports',
      'team.roleSummary.supervisor.bans',
      'team.roleSummary.supervisor.viewConfig',
    ],
    cannot: ['team.roleSummary.supervisor.noAgents', 'team.roleSummary.supervisor.noWorkspace'],
  },
  agent: {
    summary: 'team.roleSummary.agent.summary',
    can: [
      'team.roleSummary.agent.chats',
      'team.roleSummary.agent.shortcuts',
      'team.roleSummary.agent.history',
      'team.roleSummary.agent.visitors',
    ],
    cannot: ['team.roleSummary.agent.noMonitor', 'team.roleSummary.agent.noAnalytics', 'team.roleSummary.changeSettings'],
  },
  analyst: {
    summary: 'team.roleSummary.analyst.summary',
    can: ['team.roleSummary.analyst.analytics', 'team.roleSummary.analyst.roster'],
    cannot: ['team.roleSummary.analyst.noChats', 'team.roleSummary.changeSettings'],
  },
};
