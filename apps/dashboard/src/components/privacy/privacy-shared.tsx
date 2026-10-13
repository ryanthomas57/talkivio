'use client';
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { CheckCircle2, Clock, Download, Eraser, Hourglass, Loader2, ShieldQuestion, XCircle } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui';
import { useConnectionState, useRealtimeEvent, useResync, useScopes } from '@/hooks/use-realtime';
import { useT, type MessageKey, type Translate } from '@/i18n';
import { api, isApiError, type Paged } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatPercent } from '@/lib/format';
import { useCan, useSession } from '@/stores/session';
import { privacyKeys, type PrivacyKind, type PrivacyListItem, type PrivacyRequest, type PrivacyState, type PrivacySubject, type PrivacyUpdatedPayload, type VisitorProfile } from './types';

const STATE: Record<PrivacyState, { label: MessageKey; tone: BadgeTone; Icon: typeof Clock; spin?: boolean }> = {
  pending_verification: { label: 'privacy.state.pendingVerification', tone: 'warning', Icon: ShieldQuestion },
  queued: { label: 'privacy.state.queued', tone: 'info', Icon: Hourglass },
  running: { label: 'privacy.state.running', tone: 'info', Icon: Loader2, spin: true },
  completed: { label: 'privacy.state.completed', tone: 'success', Icon: CheckCircle2 },
  failed: { label: 'privacy.state.failed', tone: 'danger', Icon: XCircle },
};

export function stateLabel(t: Translate, s: PrivacyState): string {
  const m = STATE[s];
  return m ? t(m.label) : s;
}

export function PrivacyStateBadge({ state }: { state: PrivacyState }) {
  const t = useT();
  const known = STATE[state];
  const m = known ? { ...known, label: t(known.label) } : { label: state, tone: 'neutral' as const, Icon: Clock, spin: false };
  return (
    <Badge tone={m.tone} icon={<m.Icon className={cn('size-3.5', m.spin && 'animate-spin')} aria-hidden />}>
      {m.label}
    </Badge>
  );
}

export function KindBadge({ kind }: { kind: PrivacyKind }) {
  const t = useT();
  return kind === 'erase' ? (
    <Badge tone="danger" icon={<Eraser className="size-3.5" aria-hidden />}>
      {t('privacy.kind.erase')}
    </Badge>
  ) : (
    <Badge tone="info" icon={<Download className="size-3.5" aria-hidden />}>
      {t('privacy.kind.access')}
    </Badge>
  );
}

/** Report keys (stores, counts, job steps, error codes) the dashboard knows; unknown ones are humanized as-is. */
const LABELS: Record<string, MessageKey> = {
  lockout: 'privacy.label.lockout',
  attachments: 'privacy.label.attachments',
  messages: 'privacy.label.messages',
  chats: 'privacy.label.chats',
  pageEvents: 'privacy.label.pageEvents',
  sessions: 'privacy.label.sessions',
  consent: 'privacy.label.consentRecords',
  consentRecords: 'privacy.label.consentRecords',
  links: 'privacy.label.links',
  offline: 'privacy.label.offlineMessages',
  offlineSubmissions: 'privacy.label.offlineMessages',
  exports: 'privacy.label.exports',
  idempotency: 'privacy.label.idempotency',
  outbox: 'privacy.label.outbox',
  webhooks: 'privacy.label.webhooks',
  jobs: 'privacy.label.jobs',
  notifications: 'privacy.label.notifications',
  emails: 'privacy.label.emails',
  caches: 'privacy.label.caches',
  visitor: 'privacy.label.visitor',
  verify: 'privacy.label.verify',
  identities: 'privacy.label.identities',
  tombstoneLedger: 'privacy.label.tombstoneLedger',
  database: 'privacy.label.database',
  objectStore: 'privacy.label.objectStore',
  search: 'privacy.label.search',
  started: 'privacy.label.started',
  collecting: 'privacy.label.collecting',
  completed: 'privacy.state.completed',
};

const STORES: Record<string, MessageKey> = {
  'postgresql.transcripts': 'privacy.store.transcripts',
  'postgresql.search_index': 'privacy.store.searchIndex',
  'postgresql.profile': 'privacy.store.profile',
  'postgresql.derived_payloads': 'privacy.store.derivedPayloads',
  object_storage: 'privacy.store.objectStorage',
  redis: 'privacy.store.redis',
  tombstone_ledger: 'privacy.store.tombstoneLedger',
};

/** "page_events" / "pageEvents" → "Page events" (known stores get a friendlier name). */
export function humanize(t: Translate, key: string): string {
  const store = STORES[key];
  if (store) return t(store);
  const camel = key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  const label = LABELS[camel];
  if (label) return t(label);
  const words = camel.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').toLowerCase().trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

/** Subject name from a list item (resolved by the API in the same query — no per-row lookups). */
export function subjectLabel(t: Translate, visitorId: string | null, subject: PrivacySubject | null | undefined): string {
  if (subject?.displayName) return subject.displayName;
  if (subject?.erased) return t('privacy.subject.erased');
  if (!visitorId) return t('privacy.subject.removed');
  return t('privacy.subject.fallback', { id: visitorId.slice(0, 8) });
}

export function SubjectName({ r, className }: { r: PrivacyListItem; className?: string }) {
  const t = useT();
  const label = subjectLabel(t, r.visitorId, r.subject);
  return (
    <span className={cn(!r.subject?.displayName && 'text-fg-2', className)} dir="auto">
      {label}
    </span>
  );
}

/** The subject of a request as last listed, if any list page holds it (the detail endpoint has no `subject`). */
export function useListedSubject(id: string): PrivacySubject | null {
  const qc = useQueryClient();
  for (const [, data] of qc.getQueriesData<InfiniteData<Paged<PrivacyListItem>>>({ queryKey: privacyKeys.lists })) {
    for (const page of data?.pages ?? []) {
      const hit = page.items.find((r) => r.id === id);
      if (hit?.subject) return hit.subject;
    }
  }
  return null;
}

/**
 * Live privacy progress. `privacy.updated` reaches every privacy admin on their own
 * agent scope, on state changes and after each job step (with `progress` 0–100):
 * progress and state are patched into cached lists and details at once, and the
 * changed request is refetched for its step report. Mount once per screen (the
 * privacy page); queries use `useFallbackPoll` for a slow safety-net poll.
 */
export function usePrivacyLive(): void {
  const qc = useQueryClient();
  const canManage = useCan('privacy.manage');
  const membershipId = useSession((s) => s.agent?.agent.id ?? null);
  useScopes(canManage && membershipId ? [{ kind: 'agent', id: membershipId }] : null);
  useRealtimeEvent<PrivacyUpdatedPayload>('privacy.updated', (e) => {
    const p = e.payload;
    if (!p?.requestId) return;
    let found = false;
    let refetchLists = false;
    const patch = <T extends PrivacyRequest>(r: T): T => {
      if (r.id !== p.requestId) return r;
      found = true;
      const sameState = r.state === p.state;
      if (!sameState) refetchLists = true; // may move between filtered lists; report changes
      const current = r.job?.progress ?? null;
      // Events can trail a fresher REST read (outbox lag): within one state, progress never moves backwards.
      const progress = p.state === 'completed' ? 100 : p.progress === null ? current : sameState && current !== null ? Math.max(current, p.progress) : p.progress;
      if (!r.job && p.progress !== null) refetchLists = true;
      return { ...r, state: p.state, completedAt: p.completedAt ?? r.completedAt, job: r.job ? { ...r.job, progress } : r.job };
    };
    qc.setQueriesData<InfiniteData<Paged<PrivacyListItem>>>({ queryKey: privacyKeys.lists }, (data) => (data ? { ...data, pages: data.pages.map((pg) => ({ ...pg, items: pg.items.map(patch) })) } : data));
    qc.setQueryData<PrivacyRequest>(privacyKeys.detail(p.requestId), (r) => (r ? patch(r) : r));
    if (refetchLists || !found) void qc.invalidateQueries({ queryKey: privacyKeys.lists });
    void qc.invalidateQueries({ queryKey: privacyKeys.detail(p.requestId) });
  });
  useResync(() => void qc.invalidateQueries({ queryKey: privacyKeys.all }));
}

/** Poll interval while work is in flight: slow when realtime is live (fallback only), quick when it is down. */
export function useFallbackPoll(): (active: boolean, liveMs: number) => number | false {
  const live = useConnectionState() === 'live';
  return (active, liveMs) => (active ? (live ? liveMs : 3000) : false);
}

/** Display name for a privacy subject. Erased visitors keep only their anonymous label. */
export function useVisitorLabel(visitorId: string | null): { label: string; loading: boolean } {
  const t = useT();
  const canView = useCan('visitors.view');
  const q = useQuery({
    queryKey: privacyKeys.visitor(visitorId ?? 'none'),
    queryFn: () => api.get<VisitorProfile>(`/visitors/${visitorId}`),
    enabled: !!visitorId && canView,
    staleTime: 60_000,
    retry: (n, e) => !isApiError(e) || (e.status >= 500 && n < 2),
  });
  if (!visitorId) return { label: t('privacy.subject.removed'), loading: false };
  const fallback = t('privacy.subject.fallback', { id: visitorId.slice(0, 8) });
  if (q.data) return { label: q.data.displayName || q.data.anonymousLabel || fallback, loading: false };
  return { label: fallback, loading: q.isPending && canView };
}

export function ProgressBar({ value, label, className }: { value: number | null; label: string; className?: string }) {
  const v = value === null ? null : Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v ?? undefined} className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-3">
        <div className={cn('h-full rounded-full bg-primary transition-[width] duration-500', v === null && 'w-1/3 animate-pulse')} style={v === null ? undefined : { width: `${v}%` }} />
      </div>
      <span className="w-10 text-end text-xs tabular text-fg-2">{v === null ? '…' : formatPercent(v / 100)}</span>
    </div>
  );
}
