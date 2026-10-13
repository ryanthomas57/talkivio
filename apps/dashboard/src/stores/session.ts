'use client';
/**
 * Signed-in session: user, memberships, active tenant, and the caller's membership
 * (permissions + preferences). Loaded once per page load and after tenant switches.
 */
import { create } from 'zustand';
import { api, isApiError } from '@/lib/api';
import type { AgentMe, Me, Tenant } from '@/lib/types';

export type SessionStatus = 'loading' | 'anonymous' | 'no-tenant' | 'ready' | 'error';

interface SessionState {
  status: SessionStatus;
  me: Me | null;
  tenant: Tenant | null;
  agent: AgentMe | null;
  permissions: ReadonlySet<string>;
  error: string | null;
  load: () => Promise<void>;
  setMe: (me: Me) => Promise<void>;
  refreshTenant: () => Promise<void>;
  refreshAgent: () => Promise<void>;
  setTenant: (t: Tenant) => void;
  setAgent: (a: AgentMe) => void;
  logout: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
  reset: () => void;
}

const EMPTY = new Set<string>();

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  me: null,
  tenant: null,
  agent: null,
  permissions: EMPTY,
  error: null,

  async load() {
    try {
      const me = await api.get<Me>('/auth/me', undefined, { quietAuth: true });
      await get().setMe(me);
    } catch (e) {
      if (isApiError(e) && (e.status === 401 || e.status === 403)) set({ status: 'anonymous', me: null, tenant: null, agent: null, permissions: EMPTY, error: null });
      else set({ status: 'error', error: e instanceof Error ? e.message : 'Unable to load your session' });
    }
  },

  async setMe(me) {
    if (!me.activeTenantId) {
      set({ me, status: 'no-tenant', tenant: null, agent: null, permissions: EMPTY, error: null });
      return;
    }
    const [tenant, agent] = await Promise.all([api.get<Tenant>('/tenants/current'), api.get<AgentMe>('/agents/me')]);
    set({ me, tenant, agent, permissions: new Set(agent.permissions), status: 'ready', error: null });
  },

  async refreshTenant() {
    const tenant = await api.get<Tenant>('/tenants/current');
    set({ tenant });
  },

  async refreshAgent() {
    const agent = await api.get<AgentMe>('/agents/me');
    set({ agent, permissions: new Set(agent.permissions) });
  },

  setTenant: (tenant) => set({ tenant }),
  setAgent: (agent) => set({ agent, permissions: new Set(agent.permissions) }),

  async logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      get().reset();
      set({ status: 'anonymous' });
    }
  },

  async switchTenant(tenantId) {
    const me = await api.post<Me>('/tenants/switch', { tenantId });
    await get().setMe(me);
  },

  reset: () => set({ me: null, tenant: null, agent: null, permissions: EMPTY, error: null }),
}));

/** True when the signed-in membership holds the permission (UI hint only). */
export function useCan(permission: string): boolean {
  return useSession((s) => s.permissions.has(permission));
}

export function useCanAny(permissions: string[]): boolean {
  return useSession((s) => permissions.some((p) => s.permissions.has(p)));
}
