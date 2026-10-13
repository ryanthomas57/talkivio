'use client';
import { useMemo } from 'react';
import { Archive, CheckCircle2, CircleDot, EyeOff } from 'lucide-react';
import { Badge } from '@/components/ui';
import { useScopes } from '@/hooks/use-realtime';
import { useT } from '@/i18n';
import { useDepartments } from '@/lib/queries';
import type { Scope } from '@/lib/realtime';
import { useSession } from '@/stores/session';
import type { OfflineStatus } from './types';

export const offlineKeys = {
  list: (status: string, departmentId: string | null) => ['offline', 'list', status, departmentId ?? 'all'] as const,
  listAll: ['offline', 'list'] as const,
  detail: (id: string) => ['offline', 'detail', id] as const,
};

/** Status uses icon + text + color (ch. 05). */
export function OfflineStatusBadge({ status }: { status: OfflineStatus }) {
  const t = useT();
  switch (status) {
    case 'received':
      return (
        <Badge tone="warning" icon={<CircleDot className="size-3" aria-hidden />}>
          {t('offline.status.received')}
        </Badge>
      );
    case 'handled':
      return (
        <Badge tone="success" icon={<CheckCircle2 className="size-3" aria-hidden />}>
          {t('offline.status.handled')}
        </Badge>
      );
    case 'exported':
      return (
        <Badge tone="neutral" icon={<Archive className="size-3" aria-hidden />}>
          {t('offline.status.exported')}
        </Badge>
      );
    case 'erased':
      return (
        <Badge tone="neutral" icon={<EyeOff className="size-3" aria-hidden />}>
          {t('offline.status.erased')}
        </Badge>
      );
    default:
      return <Badge tone="neutral">{status}</Badge>;
  }
}

/**
 * Queue scopes carry `offline.submitted` / `offline.updated`. The inbox already
 * subscribes for agents who serve chats; subscriptions are reference counted, so
 * subscribing here too is free and covers members without `chats.serve`.
 */
export function useOfflineScopes() {
  const scope = useSession((s) => s.agent?.departmentScope);
  const departments = useDepartments(scope === 'all');
  const scopes = useMemo<Scope[] | null>(() => {
    if (!scope) return null;
    const ids = scope === 'all' ? (departments.data ?? []).filter((d) => !d.archivedAt).map((d) => d.id) : scope;
    return [{ kind: 'queue', id: 'none' }, ...ids.map((id) => ({ kind: 'queue' as const, id }))];
  }, [scope, departments.data]);
  useScopes(scopes);
}
