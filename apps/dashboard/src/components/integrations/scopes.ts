'use client';
/**
 * Integration token scopes (ch. 55). The catalogue — every scope, the permissions it
 * carries and whether the caller may grant it — comes from
 * GET /integration-tokens/scopes, so the API stays the single source of truth. This
 * file only holds presentation copy (labels, descriptions, grouping); a scope the
 * copy doesn't know yet is still listed, under "Other", by its key.
 */
import { useQuery } from '@tanstack/react-query';
import { isolate, type MessageKey, type Translate } from '@/i18n';
import { api } from '@/lib/api';
import { integrationKeys } from './types';

/** One entry of GET /integration-tokens/scopes. */
export interface TokenScope {
  scope: string;
  permissions: string[];
  /** False when the caller lacks a permission the scope carries (tokens never exceed their creator). */
  grantable: boolean;
}

export interface ScopeView extends TokenScope {
  label: string;
  description: string;
}

export interface ScopeGroup {
  id: GroupId;
  label: string;
  scopes: ScopeView[];
}

type GroupId = 'chats' | 'visitors' | 'reporting' | 'administration' | 'other';

const COPY: Record<string, { group: GroupId; label: MessageKey; description: MessageKey }> = {
  'chats:read': { group: 'chats', label: 'integrations.scopes.chatsRead.label', description: 'integrations.scopes.chatsRead.description' },
  'chats:write': { group: 'chats', label: 'integrations.scopes.chatsWrite.label', description: 'integrations.scopes.chatsWrite.description' },
  'visitors:read': { group: 'visitors', label: 'integrations.scopes.visitorsRead.label', description: 'integrations.scopes.visitorsRead.description' },
  'visitors:write': { group: 'visitors', label: 'integrations.scopes.visitorsWrite.label', description: 'integrations.scopes.visitorsWrite.description' },
  'analytics:read': { group: 'reporting', label: 'integrations.scopes.analyticsRead.label', description: 'integrations.scopes.analyticsRead.description' },
  'webhooks:manage': { group: 'administration', label: 'integrations.scopes.webhooksManage.label', description: 'integrations.scopes.webhooksManage.description' },
};
const GROUP_ORDER: GroupId[] = ['chats', 'visitors', 'reporting', 'administration', 'other'];
const GROUP_LABEL: Record<GroupId, MessageKey> = {
  chats: 'common.chats',
  visitors: 'integrations.scopes.group.visitors',
  reporting: 'integrations.scopes.group.reporting',
  administration: 'integrations.scopes.group.administration',
  other: 'common.other',
};

export function useTokenScopes() {
  return useQuery({ queryKey: integrationKeys.tokenScopes, queryFn: () => api.get<TokenScope[]>('/integration-tokens/scopes'), staleTime: 60_000 });
}

/** Group the API catalogue for display, keeping the API's scope order within a group. */
export function groupScopes(list: TokenScope[], t: Translate): ScopeGroup[] {
  const groups = new Map<GroupId, ScopeView[]>();
  for (const s of list) {
    const copy = COPY[s.scope];
    const group = copy?.group ?? 'other';
    const description = copy ? t(copy.description) : t('integrations.scopes.grantsFallback', { permissions: isolate(s.permissions.join(', ')) });
    groups.set(group, [...(groups.get(group) ?? []), { ...s, label: copy ? t(copy.label) : s.scope, description }]);
  }
  return [...groups.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0])).map(([id, scopes]) => ({ id, label: t(GROUP_LABEL[id]), scopes }));
}

export function scopeLabel(key: string, t: Translate): string {
  const copy = COPY[key];
  return copy ? t(copy.label) : key;
}

export const DAY_MS = 86_400_000;
export const DEFAULT_TTL_DAYS = 90;
export const MAX_TTL_DAYS = 365;
