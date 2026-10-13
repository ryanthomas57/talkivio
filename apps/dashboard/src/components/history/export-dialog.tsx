'use client';
/**
 * Export dialog (ch. 20): format, time zone and internal-note policy (default
 * excluded; offered only with `exports.internal`), a server count preview before
 * anything is queued, then the job's progress and download in place.
 */
import { useQuery } from '@tanstack/react-query';
import { FileDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Banner, Button, CheckboxField, Dialog, DialogContent, Field, RadioGroup, Spinner, TimezonePicker } from '@/components/ui';
import { useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { useSession } from '@/stores/session';
import { TrackedExport, useExportEvents } from './export-jobs';
import { FORMAT_LABEL, type ExportFilters, type ExportFormat, type ExportJob, type ExportPreview } from './types';
import { validTimeZone } from './tz';

export type ExportSource = { kind: 'chats'; chatIds: string[]; label: string } | { kind: 'filters'; filters: ExportFilters; label: string };

export function ExportDialog({ open, onOpenChange, source }: { open: boolean; onOpenChange: (o: boolean) => void; source: ExportSource | null }) {
  const t = useT();
  const workspaceTz = useSession((s) => validTimeZone(s.tenant?.timezone));
  const perms = useSession((s) => s.permissions);
  const canInternal = perms.has('exports.internal') && perms.has('notes.view');
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [tz, setTz] = useState(workspaceTz);
  const [includeInternal, setIncludeInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ExportJob | null>(null);
  const idem = useRef<{ sig: string; key: string } | null>(null);
  useExportEvents();

  useEffect(() => {
    if (!open) return;
    setFormat('pdf');
    setTz(workspaceTz);
    setIncludeInternal(false);
    setError(null);
    setJob(null);
    idem.current = null;
  }, [open, workspaceTz]);

  const target = source?.kind === 'chats' ? { chatIds: source.chatIds } : source ? { filters: source.filters } : null;
  const preview = useQuery({
    queryKey: ['exports', 'preview', target, format, includeInternal],
    queryFn: () => api.post<ExportPreview>('/exports/preview', { ...target, format, includeInternal }),
    enabled: open && !!target && !job,
    staleTime: 10_000,
    retry: false,
  });
  const p = preview.data;
  const over = !!p && p.count > p.limit;
  const blocked = !p || p.count === 0 || over;

  const start = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    const body = { ...target, format, timezone: tz, includeInternal };
    const sig = JSON.stringify(body);
    if (!idem.current || idem.current.sig !== sig) idem.current = { sig, key: uuid() };
    try {
      setJob(await api.post<ExportJob>('/exports', body, { idempotencyKey: idem.current.key }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="md"
        title={t('history.export.title')}
        description={source?.label}
        footer={
          job ? (
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('common.close')}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void start()} loading={busy} disabled={blocked || preview.isFetching}>
                <FileDown className="size-4" aria-hidden />
                {p && !blocked ? t('history.export.exportCount', { count: p.count }) : t('common.export')}
              </Button>
            </>
          )
        }
      >
        {job ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-2">{t('history.export.background')}</p>
            <TrackedExport id={job.id} initial={job} />
          </div>
        ) : (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked) void start();
            }}
          >
            <RadioGroup<ExportFormat>
              legend={t('history.export.format')}
              name="export-format"
              value={format}
              onChange={setFormat}
              options={(['pdf', 'txt', 'csv', 'json'] as ExportFormat[]).map((f) => ({
                value: f,
                label: t(FORMAT_LABEL[f]),
                description: f === 'csv' ? t('history.export.csvHint') : f === 'json' ? t('history.export.jsonHint') : f === 'pdf' ? t('history.export.pdfHint') : undefined,
              }))}
            />
            <Field label={t('history.export.timezone')} description={t('history.export.timezoneHint')}>
              <TimezonePicker value={tz} onChange={setTz} />
            </Field>
            {canInternal ? (
              <CheckboxField checked={includeInternal} onCheckedChange={(c) => setIncludeInternal(c === true)} label={t('history.export.includeNotes')} description={t('history.export.includeNotesHint')} />
            ) : (
              <p className="text-sm text-fg-2">{t('history.export.notesExcluded')}</p>
            )}
            <div className="rounded-[var(--radius-control)] border border-line-subtle bg-surface-2 px-3 py-2 text-sm" aria-live="polite">
              {preview.isFetching && !p ? (
                <Spinner label={t('history.export.counting')} />
              ) : preview.isError ? (
                <span className="text-danger">{errorMessage(preview.error)}</span>
              ) : p ? (
                p.count === 0 ? (
                  <span className="text-fg-2">{t('history.export.none')}</span>
                ) : over ? (
                  <span className="text-danger">{t(format === 'pdf' ? 'history.export.overLimitPdf' : 'history.export.overLimit', { count: p.count, limit: formatNumber(p.limit) })}</span>
                ) : (
                  <WillExport text={t('history.export.willExport', { count: p.count, limit: formatNumber(p.limit) })} />
                )
              ) : null}
            </div>
            {error && <Banner tone="danger">{error}</Banner>}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The count is marked <b>…</b> in the message so the emphasis follows the translation's word order. */
function WillExport({ text }: { text: string }) {
  const [before, count, after] = text.split(/<b>|<\/b>/);
  return (
    <span>
      {before}
      {count !== undefined && <span className="font-semibold tabular">{count}</span>}
      {after}
    </span>
  );
}
