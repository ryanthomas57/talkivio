'use client';
/** Canned replies (ch. 18) REST contracts, query keys, permissions and realtime refresh. */
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRealtimeEvent, useResync, useScopes } from '@/hooks/use-realtime';
import { useSession } from '@/stores/session';
import type { MessageKey } from '@/i18n';

export type ScopeType = 'tenant' | 'department' | 'personal';

export interface Shortcut {
  id: string;
  slug: string;
  title: string;
  body: string;
  scopeType: ScopeType;
  scopeId: string | null;
  enabled: boolean;
  options: string[];
  tags: string[];
  placeholders: string[];
  usageCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  editable: boolean;
}

/** POST /shortcuts/{id}/render and /shortcuts/render-preview (replyId is null for unsaved text). */
export interface RenderResult {
  replyId: string | null;
  text: string;
  unresolved: string[];
  canSend: boolean;
  options: string[];
}

export interface ImportRowDiagnostic {
  line: number;
  slug: string;
  title: string;
  scopeType: string;
  scopeId: string | null;
  status: 'valid' | 'rejected';
  action: 'create' | 'restore' | null;
  errors: string[];
}

export interface ImportPreview {
  previewToken: string | null;
  expiresAt: string | null;
  summary: { total: number; valid: number; rejected: number };
  capacityError: string | null;
  rows: ImportRowDiagnostic[];
}

export interface ImportCommit {
  committed: number;
  restored: number;
  items: Shortcut[];
}

/** Allowlisted placeholders (ch. 18). Grammar: {{key}} or {{key|fallback}}. `label` is a message key. */
export const PLACEHOLDERS = [
  { key: 'visitor.name', label: 'shortcuts.placeholder.visitorName' },
  { key: 'agent.display_name', label: 'shortcuts.placeholder.agentName' },
  { key: 'department.name', label: 'shortcuts.placeholder.departmentName' },
  { key: 'site.name', label: 'shortcuts.placeholder.siteName' },
] as const satisfies ReadonlyArray<{ key: string; label: MessageKey }>;
export type PlaceholderKey = (typeof PLACEHOLDERS)[number]['key'];

export const MAX_BODY = 8000;
export const MAX_TITLE = 120;
export const MAX_OPTIONS = 8;
export const MAX_TAGS = 10;
/** Slug shape enforced by the API (shortcuts.service SLUG_RE); shown as guidance, the API decides. Message key. */
export const SLUG_HINT: MessageKey = 'shortcuts.slugHint';

export const sk = {
  root: ['shortcuts'] as const,
  list: (q: string, scope: string) => ['shortcuts', 'list', q, scope] as const,
  detail: (id: string) => ['shortcuts', 'detail', id] as const,
};

/** Message keys: render with t(). */
export const SCOPE_LABELS: Record<ScopeType, MessageKey> = { tenant: 'shortcuts.scope.tenant', department: 'shortcuts.scope.department', personal: 'shortcuts.scope.personal' };

export interface ScopeAbilities {
  /** Scopes the caller can see (list filter). */
  visible: ScopeType[];
  /** Scopes the caller can create/edit in. */
  manageable: ScopeType[];
  canManageShared: boolean;
  canManageDepartment: boolean;
  canManagePersonal: boolean;
  /** Department ids the caller may manage replies for ('all' = every department). */
  manageableDepartments: 'all' | string[];
  membershipId: string | null;
}

/** UI hints mirroring the API's canSee/canManage; the API remains the authority. */
export function useScopeAbilities(): ScopeAbilities {
  const perms = useSession((s) => s.permissions);
  const agent = useSession((s) => s.agent);
  const deptScope = agent?.departmentScope ?? [];
  const shared = perms.has('shortcuts.manage_shared');
  const dept = shared || perms.has('shortcuts.manage_department');
  const personal = perms.has('shortcuts.manage_personal');
  const visible: ScopeType[] = ['tenant'];
  if (deptScope === 'all' || deptScope.length > 0) visible.push('department');
  visible.push('personal');
  const manageable: ScopeType[] = [];
  if (shared) manageable.push('tenant');
  if (dept && (shared || deptScope === 'all' || deptScope.length > 0)) manageable.push('department');
  if (personal) manageable.push('personal');
  return {
    visible,
    manageable,
    canManageShared: shared,
    canManageDepartment: dept,
    canManagePersonal: personal,
    manageableDepartments: shared ? 'all' : deptScope,
    membershipId: agent?.agent.id ?? null,
  };
}

/** Refresh lists when replies change anywhere (durable `shortcut.changed`; personal ones reach only their owner). */
export function useShortcutsRealtime(): void {
  const qc = useQueryClient();
  const me = useSession((s) => s.agent?.agent.id ?? null);
  const canTeam = useSession((s) => s.permissions.has('agents.view'));
  useScopes([...(canTeam ? [{ kind: 'team' as const, id: 'all' }] : []), ...(me ? [{ kind: 'agent' as const, id: me }] : [])]);
  useRealtimeEvent('shortcut.changed', () => void qc.invalidateQueries({ queryKey: sk.root }));
  useResync(() => void qc.invalidateQueries({ queryKey: sk.root }));
}

export function fetchShortcut(id: string): Promise<Shortcut> {
  return api.get<Shortcut>(`/shortcuts/${id}`);
}

/** Placeholder tokens in a body (display only — the API validates and renders). */
const TOKEN_RE = /\{\{([^{}]*)\}\}/g;
export function placeholderTokens(body: string): Array<{ raw: string; key: string; start: number; end: number }> {
  const out: Array<{ raw: string; key: string; start: number; end: number }> = [];
  for (const m of body.matchAll(TOKEN_RE)) {
    const key = (m[1] ?? '').split('|')[0]!.trim();
    out.push({ raw: m[0], key, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
