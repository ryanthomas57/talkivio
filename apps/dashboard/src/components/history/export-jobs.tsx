'use client';
/**
 * Transcript export jobs (ch. 20): queued → running → ready / failed / expired,
 * followed by polling and the durable `export.ready` / `export.failed` events on
 * the requester's agent scope. Downloads use a 60-second grant that the API
 * re-authorises (scope, erasure, expiry) on every request; 410 means expired.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Clock, Download, FileDown, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Banner, Button, Dialog, DrawerContent, EmptyState, PanelError, Skeleton } from '@/components/ui';
import { useRealtimeEvent } from '@/hooks/use-realtime';
import { useT, type MessageKey } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatBytes, formatDateTime, formatPercent, formatRelative } from '@/lib/format';
import { FORMAT_LABEL, historyKeys, type DownloadGrant, type ExportJob, type ExportState } from './types';

const ACTIVE: ExportState[] = ['queued', 'running'];

/** Grants for API-hosted content go through the dashboard's same-origin proxy. */
function sameOriginIfApi(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    if (u.pathname.startsWith('/api/v1/')) return `${u.pathname}${u.search}`;
    return u.toString();
  } catch {
    return url;
  }
}

export async function downloadExport(id: string): Promise<void> {
  const grant = await api.get<DownloadGrant>(`/exports/${id}/download`);
  const a = document.createElement('a');
  a.href = sameOriginIfApi(grant.url);
  a.download = grant.filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Invalidate export queries when the worker reports completion. */
export function useExportEvents() {
  const qc = useQueryClient();
  useRealtimeEvent<{ exportId: string }>(['export.ready', 'export.failed'], (e) => {
    if (!e.payload?.exportId) return;
    void qc.invalidateQueries({ queryKey: historyKeys.export(e.payload.exportId) });
    void qc.invalidateQueries({ queryKey: historyKeys.exports, exact: true });
  });
}

export function useExportJob(id: string | null, initial?: ExportJob) {
  return useQuery({
    queryKey: historyKeys.export(id ?? ''),
    queryFn: () => api.get<ExportJob>(`/exports/${id}`),
    enabled: !!id,
    initialData: initial,
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.state) ? 1500 : false),
    refetchIntervalInBackground: true,
  });
}

const STATE: Record<ExportState, { label: MessageKey; tone: 'neutral' | 'info' | 'success' | 'danger' | 'warning'; Icon: typeof Clock }> = {
  queued: { label: 'history.jobState.queued', tone: 'neutral', Icon: Clock },
  running: { label: 'history.jobState.running', tone: 'info', Icon: Loader2 },
  ready: { label: 'history.jobState.ready', tone: 'success', Icon: CheckCircle2 },
  failed: { label: 'history.jobState.failed', tone: 'danger', Icon: AlertCircle },
  expired: { label: 'history.jobState.expired', tone: 'warning', Icon: Clock },
};

export function ExportStateBadge({ state }: { state: ExportState }) {
  const t = useT();
  const s = STATE[state];
  return (
    <Badge tone={s.tone} icon={<s.Icon className={state === 'running' ? 'size-3.5 animate-spin' : 'size-3.5'} aria-hidden />}>
      {t(s.label)}
    </Badge>
  );
}

export function ExportJobCard({ job }: { job: ExportJob }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadExport(job.id);
    } catch (e) {
      if (isApiError(e) && e.status === 410) {
        setError(t('history.jobs.expiredError'));
        void qc.invalidateQueries({ queryKey: historyKeys.export(job.id) });
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const pct = Math.max(0, Math.min(100, Math.round(job.progress)));
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <FileDown className="size-4 shrink-0 text-fg-2" aria-hidden />
          <span className="font-medium">{t(FORMAT_LABEL[job.format])}</span>
          <span className="text-fg-2">
            · {job.itemCount === null ? t('history.jobs.chatCountUnknown') : t('history.jobs.chatCount', { count: job.itemCount })}
            {job.includeInternal ? ` · ${t('history.jobs.withNotes')}` : ''}
          </span>
        </span>
        <ExportStateBadge state={job.state} />
      </div>
      {ACTIVE.includes(job.state) && (
        <div className="flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label={t('history.jobs.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.max(pct, job.state === 'queued' ? 2 : 6)}%` }} />
          </div>
          <span className="w-10 text-end text-xs tabular text-fg-2">{formatPercent(pct / 100)}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-2">
        <span>
          {t('history.jobs.requested', { time: formatRelative(job.createdAt), timezone: job.timezone })}
          {job.state === 'ready' && job.sizeBytes !== null ? ` · ${formatBytes(job.sizeBytes)}` : ''}
          {job.state === 'ready' ? ` · ${t('history.jobs.availableUntil', { date: formatDateTime(job.expiresAt) })}` : ''}
        </span>
        {job.state === 'ready' && (
          <Button size="sm" variant="primary" onClick={() => void download()} loading={busy}>
            <Download className="size-3.5" aria-hidden /> {t('common.download')}
          </Button>
        )}
      </div>
      {job.state === 'failed' && <p className="text-xs text-danger">{job.errorCode ? t('history.jobs.failed', { code: job.errorCode }) : t('history.jobs.failedNoCode')}</p>}
      {job.state === 'expired' && <p className="text-xs text-fg-2">{t('history.jobs.expiredNote')}</p>}
      {error && (
        <Banner tone="danger" className="py-1.5">
          {error}
        </Banner>
      )}
    </div>
  );
}

/** Live-updating card for one job (used in the export dialog). */
export function TrackedExport({ id, initial }: { id: string; initial?: ExportJob }) {
  const q = useExportJob(id, initial);
  if (!q.data) return <Skeleton className="h-20 w-full" />;
  return (
    <div aria-live="polite">
      <ExportJobCard job={q.data} />
    </div>
  );
}

/** Drawer listing the caller's recent exports. */
export function ExportsDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const q = useQuery({
    queryKey: historyKeys.exports,
    queryFn: () => api.get<ExportJob[]>('/exports'),
    enabled: open,
    refetchInterval: (query) => (query.state.data?.some((j) => ACTIVE.includes(j.state)) ? 2000 : false),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DrawerContent title={t('history.jobs.drawerTitle')} description={t('history.jobs.drawerHint')} width={460}>
        <div className="flex flex-col gap-3 p-5">
          {q.isLoading ? (
            <>
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </>
          ) : q.isError ? (
            <PanelError className="p-0" message={t('history.jobs.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
          ) : !q.data?.length ? (
            <EmptyState icon={<FileDown />} title={t('history.jobs.emptyTitle')} description={t('history.jobs.emptyBody')} />
          ) : (
            q.data.map((j) => <ExportJobCard key={j.id} job={j} />)
          )}
        </div>
      </DrawerContent>
    </Dialog>
  );
}
