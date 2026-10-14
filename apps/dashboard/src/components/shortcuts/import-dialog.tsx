'use client';
/**
 * CSV import (ch. 18): paste or choose a file → POST /shortcuts/import-preview shows
 * every row as valid or rejected with reasons (no writes) → POST import-commit with
 * the preview token imports all valid rows in one transaction.
 */
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileUp, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Banner,
  Button,
  CheckboxField,
  Dialog,
  DialogContent,
  Field,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
  Textarea,
} from '@/components/ui';
import { api, ApiError, errorMessage, isApiError } from '@/lib/api';
import { formatBytes, formatTime } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { formatNumber } from '@/lib/format';
import { isolate, useT } from '@/i18n';
import { SCOPE_LABELS, sk, type ImportCommit, type ImportPreview, type ScopeType } from './shortcuts-api';

const MAX_CSV = 250_000;
const COLUMNS = 'slug,title,body,scope_type,scope_id,tags,options,enabled';
const REQUIRED_COLUMNS = 'slug, title, body'; // i18n-ignore: CSV column names

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [rejectedOnly, setRejectedOnly] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const commitKey = useRef<string | null>(null);
  const tooLong = csv.length > MAX_CSV;

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    if (f.size > MAX_CSV * 4) {
      setFieldError(
        t('shortcuts.import.fileTooLarge', { size: formatBytes(f.size), max: formatBytes(MAX_CSV) }),
      );
      return;
    }
    const text = await f.text();
    setCsv(text);
    setFileName(f.name);
    setFieldError(null);
    setPreview(null);
  };

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    setFieldError(null);
    try {
      const r = await api.post<ImportPreview>('/shortcuts/import-preview', { csvText: csv });
      setPreview(r);
      commitKey.current = uuid();
      setRejectedOnly(false);
    } catch (e) {
      if (e instanceof ApiError && e.fieldErrors.csv_text?.length)
        setFieldError(e.fieldErrors.csv_text.join(' · '));
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (!preview?.previewToken) return;
    setBusy('commit');
    setError(null);
    try {
      const r = await api.post<ImportCommit>(
        '/shortcuts/import-commit',
        { previewToken: preview.previewToken },
        { idempotencyKey: commitKey.current ?? uuid() },
      );
      toast.success(
        r.restored
          ? t('shortcuts.import.doneRestored', { count: r.committed, restored: r.restored })
          : t('shortcuts.import.done', { count: r.committed }),
      );
      await qc.invalidateQueries({ queryKey: sk.root });
      onClose();
    } catch (e) {
      if (isApiError(e, 'TOKEN_EXPIRED') || isApiError(e, 'VERSION_CONFLICT')) {
        setPreview(null);
        setError(t('shortcuts.import.failed', { error: errorMessage(e) }));
      } else setError(t('shortcuts.import.failed', { error: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  };

  const rows = preview
    ? rejectedOnly
      ? preview.rows.filter((r) => r.status === 'rejected')
      : preview.rows
    : [];

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        size="xl"
        title={t('shortcuts.import.title')}
        description={preview ? t('shortcuts.import.reviewHelp') : t('shortcuts.import.pasteHelp')}
        footer={
          preview ? (
            <>
              <Button variant="secondary" onClick={() => setPreview(null)} disabled={!!busy}>
                {t('shortcuts.import.backToCsv')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void commit()}
                loading={busy === 'commit'}
                disabled={!preview.previewToken}
              >
                {preview.summary.valid
                  ? t('shortcuts.import.commit', { count: preview.summary.valid })
                  : t('shortcuts.import.nothing')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose} disabled={!!busy}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => void runPreview()}
                loading={busy === 'preview'}
                disabled={!csv.trim() || tooLong}
              >
                {t('shortcuts.import.preview')}
              </Button>
            </>
          )
        }
      >
        {!preview ? (
          <div className="flex flex-col gap-4">
            <div className="rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-sm text-fg-2">
              <p>
                {t('shortcuts.import.required')}{' '}
                <code className="text-fg" dir="ltr">
                  {REQUIRED_COLUMNS}
                </code>
              </p>
              <p className="mt-1">{t('shortcuts.import.optional')}</p>
              <code className="mt-1 block break-all text-xs text-fg" dir="ltr">
                {COLUMNS}
              </code>
              <p className="mt-1 text-xs">
                {t('shortcuts.import.formatHelp', {
                  column: 'scope_type',
                  values: 'tenant, department, personal',
                  separator: '|',
                  max: formatNumber(500),
                })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="sr-only"
                id="csv-file"
                onChange={(e) => void readFile(e.target.files?.[0])}
              />
              <Button variant="secondary" onClick={() => fileRef.current?.click()}>
                <FileUp className="size-4" aria-hidden />
                {t('shortcuts.import.chooseFile')}
              </Button>
              {fileName && (
                <span className="text-sm text-fg-2">
                  {t('shortcuts.import.loaded', { name: isolate(fileName) })}
                </span>
              )}
            </div>
            <Field
              label={t('shortcuts.import.csvText')}
              error={
                fieldError ??
                (tooLong
                  ? t('shortcuts.import.tooLong', {
                      length: formatNumber(csv.length),
                      max: formatNumber(MAX_CSV),
                    })
                  : undefined)
              }
            >
              <Textarea
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setFileName(null);
                  setFieldError(null);
                }}
                rows={10}
                className="font-mono text-xs"
                dir="ltr"
                spellCheck={false}
                placeholder={`${COLUMNS}\nrefund,Refund policy,"You can request a refund within 30 days, {{visitor.name|there}}.",tenant,,billing,,true`} // i18n-ignore: CSV sample
              />
            </Field>
            {error && <Banner tone="danger">{error}</Banner>}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2" role="status">
              <Badge tone="neutral">{t('shortcuts.import.rows', { count: preview.summary.total })}</Badge>
              <Badge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden />}>
                {t('shortcuts.import.valid', { count: preview.summary.valid })}
              </Badge>
              <Badge
                tone={preview.summary.rejected ? 'danger' : 'neutral'}
                icon={<XCircle className="size-3.5" aria-hidden />}
              >
                {t('shortcuts.import.rejected', { count: preview.summary.rejected })}
              </Badge>
              {preview.expiresAt && (
                <span className="text-xs text-fg-2">
                  {t('shortcuts.import.validUntil', { time: formatTime(preview.expiresAt) })}
                </span>
              )}
            </div>
            {preview.capacityError && <Banner tone="danger">{preview.capacityError}</Banner>}
            {!preview.previewToken && !preview.capacityError && (
              <Banner tone="warning">{t('shortcuts.import.noneValid')}</Banner>
            )}
            {error && <Banner tone="danger">{error}</Banner>}
            {preview.summary.rejected > 0 && (
              <CheckboxField
                label={t('shortcuts.import.rejectedOnly')}
                checked={rejectedOnly}
                onCheckedChange={(c) => setRejectedOnly(c === true)}
                className="min-h-0 py-0"
              />
            )}
            <TableScroll className="max-h-[50vh] rounded-[var(--radius-control)] border border-line-subtle">
              <Table className="min-w-[720px]">
                <THead>
                  <tr>
                    <TH className="w-16">{t('shortcuts.import.colLine')}</TH>
                    <TH>{t('shortcuts.page.colShortcut')}</TH>
                    <TH>{t('shortcuts.page.colTitle')}</TH>
                    <TH>{t('shortcuts.page.scope')}</TH>
                    <TH>{t('shortcuts.import.colResult')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {rows.map((r) => (
                    <TR key={r.line} className="align-top">
                      <TD className="py-2 tabular text-fg-2">{r.line}</TD>
                      <TD className="py-2 font-mono text-sm" dir="ltr">
                        {r.slug ? `/${r.slug}` : null}
                      </TD>
                      <TD className="py-2 text-sm" dir="auto">
                        {r.title || null}
                      </TD>
                      <TD className="py-2 text-sm">
                        {r.scopeType && r.scopeType in SCOPE_LABELS
                          ? t(SCOPE_LABELS[r.scopeType as ScopeType])
                          : r.scopeType}
                      </TD>
                      <TD className="py-2">
                        {r.status === 'valid' ? (
                          <Badge tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden />}>
                            {r.action === 'restore'
                              ? t('shortcuts.import.validRestore')
                              : t('shortcuts.import.validNew')}
                          </Badge>
                        ) : (
                          <div className="flex flex-col gap-1">
                            <Badge tone="danger" icon={<XCircle className="size-3.5" aria-hidden />}>
                              {t('shortcuts.import.rejectedRow')}
                            </Badge>
                            <ul className="flex flex-col gap-0.5 text-xs text-danger">
                              {r.errors.map((m, i) => (
                                <li key={i}>{m}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
