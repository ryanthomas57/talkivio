'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useEphemeralEvent, useRealtimeEvent, useResync, useScopes } from '@/hooks/use-realtime';
import type { MessageKey, Translate } from '@/i18n';
import { qk } from '@/lib/queries';
import type { Agent, Department, Role } from '@/lib/types';

export interface DepartmentMember {
  membershipId: string;
  canServe: boolean;
  canMonitor: boolean;
}

/** `/departments` projection (workspace.controller.ts `resources`). */
export interface DepartmentResource extends Department {
  members: DepartmentMember[];
  queued: number;
  archivedAt: string | null;
}

export const asResource = (d: Department) => d as DepartmentResource;

/** Roles that hold `chats.serve` (server: ROLE_PERMISSIONS). Analysts can't take chats. */
export const SERVING_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'supervisor', 'agent']);

/**
 * Agents who could take a new chat for this department right now: member with
 * "can serve", enabled serving role, online with a live connection and below
 * their global capacity (mirrors routing eligibility; reservations aren't visible here).
 */
export function eligibleOnline(dept: DepartmentResource, agents: Agent[] | undefined): number | null {
  if (!agents) return null;
  const serving = new Set(dept.members.filter((m) => m.canServe).map((m) => m.membershipId));
  return agents.filter((a) => serving.has(a.id) && a.enabled && SERVING_ROLES.has(a.role) && a.effectiveStatus === 'online' && a.connected && a.activeChats < a.capacity).length;
}

/** Routing modes with catalog keys (translated at render time). */
export const ROUTING_MODES: Array<{ value: Department['routingMode']; label: MessageKey; description: MessageKey }> = [
  { value: 'broadcast', label: 'settings.departments.routing.broadcast', description: 'settings.departments.routing.broadcastHint' },
  { value: 'assigned', label: 'settings.departments.routing.assigned', description: 'settings.departments.routing.assignedHint' },
  { value: 'manual', label: 'settings.departments.routing.manual', description: 'settings.departments.routing.manualHint' },
];

/** Radio options for the routing modes in the UI language. */
export const routingOptions = (t: Translate) => ROUTING_MODES.map((r) => ({ value: r.value, label: t(r.label), description: t(r.description) }));

export const routingLabel = (t: Translate, m: Department['routingMode']) => {
  const key = ROUTING_MODES.find((r) => r.value === m)?.label;
  return key ? t(key) : m;
};

/**
 * Keeps department queue counts and agent presence fresh: queue events arrive on
 * the queue scopes the inbox already subscribes to; presence on the team scope.
 */
export function useDepartmentsRealtime() {
  const qc = useQueryClient();
  const timers = useRef<{ d?: ReturnType<typeof setTimeout>; a?: ReturnType<typeof setTimeout> }>({});
  const soon = (key: 'd' | 'a') => {
    if (timers.current[key]) return;
    timers.current[key] = setTimeout(() => {
      timers.current[key] = undefined;
      void qc.invalidateQueries({ queryKey: key === 'd' ? qk.departments : qk.agents });
    }, 1500);
  };
  useEffect(() => () => {
    clearTimeout(timers.current.d);
    clearTimeout(timers.current.a);
  }, []);
  useScopes([{ kind: 'team', id: 'all' }]);
  useRealtimeEvent(['chat.requested', 'chat.queued', 'chat.closed', 'assignment.accepted', 'chat.transferred'], () => {
    soon('d');
    soon('a');
  });
  useEphemeralEvent('presence.updated', () => soon('a'));
  useResync(() => {
    void qc.invalidateQueries({ queryKey: qk.departments });
    void qc.invalidateQueries({ queryKey: qk.agents });
  });
}
