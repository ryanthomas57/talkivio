/**
 * Unsaved agent edits. Drafts live in the Team page (not the drawer) so closing
 * the drawer or switching agents keeps them until they are saved or discarded
 * (ch. 09 "dirty edits remain until saved").
 */
import { tStatic } from '@/i18n';
import { api } from '@/lib/api';
import type { Agent, Department, Role } from '@/lib/types';

export interface DeptFlags {
  serve: boolean;
  monitor: boolean;
}

export interface AgentDraft {
  displayName: string;
  title: string;
  role: Role;
  capacity: number;
  departments: Record<string, DeptFlags>;
  /** Agent version the draft started from; sent as expected_version so a teammate's edit is not overwritten. */
  baseVersion?: number;
}

export const CAPACITY_MIN = 1;
export const CAPACITY_MAX = 20;

export function baselineFor(agent: Agent, departments: Department[] | undefined): AgentDraft {
  const deps: Record<string, DeptFlags> = {};
  for (const d of departments ?? []) {
    const m = d.members?.find((x) => x.membershipId === agent.id);
    if (m && (m.canServe || m.canMonitor)) deps[d.id] = { serve: m.canServe, monitor: m.canMonitor };
  }
  // Fall back to the roster's ids when department membership details are unavailable.
  if (!departments) for (const id of agent.departmentIds) deps[id] = { serve: true, monitor: false };
  return {
    displayName: agent.displayName,
    title: agent.title ?? '',
    role: agent.role,
    capacity: agent.capacity,
    departments: deps,
    baseVersion: agent.version,
  };
}

function normDepts(d: Record<string, DeptFlags>): string {
  return JSON.stringify(
    Object.keys(d)
      .filter((k) => d[k]!.serve || d[k]!.monitor)
      .sort()
      .map((k) => [k, !!d[k]!.serve, !!d[k]!.monitor]),
  );
}

export interface DraftDiff {
  patch: {
    displayName?: string | null;
    title?: string | null;
    role?: Exclude<Role, 'owner'>;
    capacity?: number;
  };
  departments: Array<{ departmentId: string; canServe: boolean; canMonitor: boolean }> | null;
}

export function diffDraft(base: AgentDraft, draft: AgentDraft): DraftDiff {
  const patch: DraftDiff['patch'] = {};
  if (draft.displayName.trim() !== base.displayName.trim())
    patch.displayName = draft.displayName.trim() || null;
  if (draft.title.trim() !== base.title.trim()) patch.title = draft.title.trim() || null;
  if (draft.role !== base.role && draft.role !== 'owner') patch.role = draft.role;
  if (draft.capacity !== base.capacity) patch.capacity = draft.capacity;
  const deptChanged = normDepts(base.departments) !== normDepts(draft.departments);
  return {
    patch,
    departments: deptChanged
      ? Object.entries(draft.departments)
          .filter(([, f]) => f.serve || f.monitor)
          .map(([departmentId, f]) => ({ departmentId, canServe: f.serve, canMonitor: f.monitor }))
      : null,
  };
}

export function isDirty(base: AgentDraft, draft: AgentDraft | undefined): boolean {
  if (!draft) return false;
  const d = diffDraft(base, draft);
  return Object.keys(d.patch).length > 0 || d.departments !== null;
}

export function validateDraft(d: AgentDraft): Partial<Record<'displayName' | 'title' | 'capacity', string>> {
  const e: Partial<Record<'displayName' | 'title' | 'capacity', string>> = {};
  if (d.displayName.trim().length > 120) e.displayName = tStatic('team.draft.errMaxChars', { max: 120 });
  if (d.title.trim().length > 80) e.title = tStatic('team.draft.errMaxChars', { max: 80 });
  if (!Number.isInteger(d.capacity) || d.capacity < CAPACITY_MIN || d.capacity > CAPACITY_MAX)
    e.capacity = tStatic('team.draft.errCapacity', { min: CAPACITY_MIN, max: CAPACITY_MAX });
  return e;
}

/**
 * Persist a draft: profile/role/capacity first (PATCH), then departments (PUT), each guarded
 * by the version the draft started from (VERSION_CONFLICT when a teammate saved in between).
 */
export async function saveDraft(
  agentId: string,
  base: AgentDraft,
  draft: AgentDraft,
): Promise<'saved' | 'nothing'> {
  const diff = diffDraft(base, draft);
  const hasPatch = Object.keys(diff.patch).length > 0;
  if (!hasPatch && !diff.departments) return 'nothing';
  let version = draft.baseVersion ?? base.baseVersion;
  if (hasPatch) version = (await api.patch<Agent>(`/agents/${agentId}`, { ...diff.patch, expectedVersion: version })).version;
  if (diff.departments)
    await api.put<Agent>(`/agents/${agentId}/departments`, { departments: diff.departments, expectedVersion: version });
  return 'saved';
}

/** Current server version from a VERSION_CONFLICT error, to rebase a draft after review. */
export function conflictVersion(details: Record<string, unknown>): number | undefined {
  const v = Number(details.currentVersion ?? details.current_version);
  return Number.isInteger(v) ? v : undefined;
}
