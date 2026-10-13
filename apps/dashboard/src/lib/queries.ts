'use client';
/**
 * Shared directory queries (departments, agents, tags, sites). Each page uses
 * these keys so realtime invalidation and mutations refresh one cache entry.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Agent, Department, Site, Tag } from './types';
import { useSession } from '@/stores/session';

export const qk = {
  departments: ['departments'] as const,
  agents: ['agents'] as const,
  tags: ['tags'] as const,
  sites: ['sites'] as const,
};

export function useDepartments(enabled = true) {
  const can = useSession((s) => s.permissions.has('departments.view'));
  return useQuery({ queryKey: qk.departments, queryFn: () => api.get<Department[]>('/departments'), enabled: enabled && can, staleTime: 60_000 });
}

export function useAgents(enabled = true) {
  const can = useSession((s) => s.permissions.has('agents.view'));
  return useQuery({ queryKey: qk.agents, queryFn: () => api.get<Agent[]>('/agents'), enabled: enabled && can, staleTime: 15_000 });
}

export function useTags(enabled = true) {
  return useQuery({ queryKey: qk.tags, queryFn: () => api.get<Tag[]>('/tags'), enabled, staleTime: 60_000 });
}

export function useSites(enabled = true) {
  const can = useSession((s) => s.permissions.has('sites.view'));
  return useQuery({ queryKey: qk.sites, queryFn: () => api.get<Site[]>('/sites'), enabled: enabled && can, staleTime: 60_000 });
}

/** Lookup helpers for rendering names from ids. */
export function byId<T extends { id: string }>(list: T[] | undefined): Map<string, T> {
  return new Map((list ?? []).map((x) => [x.id, x]));
}
