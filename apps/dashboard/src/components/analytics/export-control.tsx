'use client';
/**
 * CSV export (ch. 51): queues a job with the current filters (202), then follows
 * it by polling and by the durable `export.ready` event on the requester's own
 * agent scope, and finally offers the download link with its expiry.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Clock, Download, FileDown, Loader2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Banner, Button } from '@/components/ui';
import { useRealtimeEvent } from '@/hooks/use-realtime';
import { isolate, useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import { uuid } from '@/lib/ids';
import type { ExportResource } from './types';

type Report = 'chats' | 'agents' | 'invitations';

const exportKey = (id: string) => ['analytics', 'export', id] as const;
const TERMINAL = new Set(['succeeded', 'failed', 'expired']);

function clean(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== null && v !== undefined && v !== ''));
}

export function ExportControl({ report, filters, label }: { report: Report; filters: Record<string, unknown>; label: string }) {
  const t = useT();
  const [jobs, setJobs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const key = useRef<{ sig: string; key: string } | null>(null);

  useRealtimeEvent<{ exportId: string; kind: string }>('export.ready', (e) => {
    if (e.payload.kind === 'analytics' && e.payload.exportId) void qc.invalidateQueries({ queryKey: exportKey(e.payload.exportId) });
  });

  const start = async () => {
    setBusy(true);
    setError(null);
    const body = { report, format: 'csv', filters: clean(filters) };
    // Same request retried (e.g. after a network error) reuses its key; a changed request gets a new one.
    const sig = JSON.stringify(body);
    if (!key.current || key.current.sig !== sig) key.current = { sig, key: uuid() };
    try {
      const job = await api.post<ExportResource>('/analytics/exports', body, { idempotencyKey: key.current.key });
      qc.setQueryData(exportKey(job.id), job);
      setJobs((list) => [job.id, ...list.filter((x) => x !== job.id)].slice(0, 3));
      key.current = null;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="secondary" onClick={() => void start()} loading={busy}>
          <FileDown className="size-4" aria-hidden />
          {label}
        </Button>
      </div>
      {error && <Banner tone="danger">{t('analytics.export.notStarted', { error })}</Banner>}
      {jobs.length > 0 && (
        <ul className="flex w-full min-w-[260px] max-w-md flex-col gap-2" aria-label={t('analytics.export.recent')}>
          {jobs.map((id) => (
            <ExportJob key={id} id={id} onDismiss={() => setJobs((l) => l.filter((x) => x !== id))} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ExportJob({ id, onDismiss }: { id: string; onDismiss: () => void }) {
  const t = useT();
  const q = useQuery({
    queryKey: exportKey(id),
    queryFn: () => api.get<ExportResource>(`/analytics/exports/${id}`),
    refetchInterval: (query) => {
      const s = query.state.data?.state;
      return s && TERMINAL.has(s) ? false : 2000;
    },
    staleTime: 1000,
  });
  const job = q.data;
  const state = job?.state ?? 'queued';
  const expired = state === 'expired' || (job?.expiresAt ? new Date(job.expiresAt).getTime() < Date.now() : false);

  let body;
  if (q.error && !job) {
    body = (
      <span className="flex items-center gap-2 text-danger">
        <AlertCircle className="size-4 shrink-0" aria-hidden />
        {t('analytics.export.statusFailed', { error: errorMessage(q.error) })}
      </span>
    );
  } else if (state === 'succeeded' && !expired && job?.downloadPath) {
    body = (
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-2 font-medium text-success">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden />
          {t('analytics.export.ready')}
        </span>
        <a href={job.downloadPath} download={job.filename ?? true} className="inline-flex min-h-8 items-center gap-1.5 break-anywhere font-medium text-primary underline-offset-4 hover:underline">
          <Download className="size-4 shrink-0" aria-hidden />
          {job.filename ? t('analytics.export.download', { filename: isolate(job.filename) }) : t('analytics.export.downloadCsv')}
        </a>
        <span className="text-xs text-fg-2">
          {job.rowCount !== null ? t('analytics.export.rows', { count: job.rowCount }) : ''}
          {job.bytes !== null ? ` · ${formatBytes(job.bytes)}` : ''}
          {job.expiresAt && <ExpiresAt at={job.expiresAt} />}
        </span>
      </span>
    );
  } else if (state === 'failed') {
    body = (
      <span className="flex items-center gap-2 text-danger">
        <AlertCircle className="size-4 shrink-0" aria-hidden />
        {job?.errorCode ? t('analytics.export.failedCode', { code: isolate(job.errorCode) }) : t('analytics.export.failed')}
      </span>
    );
  } else if (expired) {
    body = (
      <span className="flex items-center gap-2 text-fg-2">
        <Clock className="size-4 shrink-0" aria-hidden />
        {t('analytics.export.expired')}
      </span>
    );
  } else {
    body = (
      <span className="flex items-center gap-2 text-fg-2">
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        {state === 'running' ? (job?.progress ? t('analytics.export.generatingProgress', { progress: job.progress }) : t('analytics.export.generating')) : t('analytics.export.queued')}
      </span>
    );
  }

  return (
    <li className="flex items-start gap-3 rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 py-2 text-sm">
      <div role="status" aria-live="polite" className="min-w-0 flex-1">
        {body}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={t('analytics.export.dismiss')} onClick={onDismiss}>
        <X className="size-4" />
      </Button>
    </li>
  );
}

/** " · expires in 2 days (12 Oct 2026, …)" — the relative time is marked <time>…</time> in the message. */
function ExpiresAt({ at }: { at: string }) {
  const t = useT();
  const [before, relative, after] = t('analytics.export.expires', { relative: formatRelative(at), date: formatDateTime(at) }).split(/<time>|<\/time>/);
  return (
    <>
      {' · '}
      {before}
      <time dateTime={at} title={formatDateTime(at)}>
        {relative}
      </time>
      {after}
    </>
  );
}
