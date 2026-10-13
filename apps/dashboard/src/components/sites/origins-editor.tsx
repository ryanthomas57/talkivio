'use client';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { Button, Field, Input, Select } from '@/components/ui';
import { tStatic, useT } from '@/i18n';
import { isApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { SiteOrigin } from '@/lib/types';

export interface OriginRow {
  key: string;
  origin: string;
  patternType: 'exact' | 'subdomain';
  verifiedAt?: string | null;
}

export const MAX_ORIGINS = 50;
let seq = 0;
export const newOriginRow = (origin = '', patternType: OriginRow['patternType'] = 'exact'): OriginRow => ({
  key: `o${++seq}`,
  origin,
  patternType,
});
export const rowsFromOrigins = (origins: SiteOrigin[]): OriginRow[] =>
  origins.length
    ? origins.map((o) => ({ ...newOriginRow(o.origin, o.patternType), verifiedAt: o.verifiedAt }))
    : [newOriginRow()];

/** Comparable form of the rows (blank rows ignored). */
export const originsSignature = (rows: OriginRow[]) =>
  JSON.stringify(
    rows
      .filter((r) => r.origin.trim())
      .map((r) => [r.origin.trim().toLowerCase().replace(/\/+$/, ''), r.patternType]),
  );

/**
 * Rows → request body. Blank rows are not sent, so `indexMap[i]` maps the wire
 * index back to the visible row for `origins.N.origin` field errors.
 */
export function originsPayload(rows: OriginRow[]): {
  origins: Array<{ origin: string; patternType: OriginRow['patternType'] }>;
  indexMap: number[];
} {
  const origins: Array<{ origin: string; patternType: OriginRow['patternType'] }> = [];
  const indexMap: number[] = [];
  rows.forEach((r, i) => {
    if (!r.origin.trim()) return;
    origins.push({ origin: r.origin.trim(), patternType: r.patternType });
    indexMap.push(i);
  });
  return { origins, indexMap };
}

/** Client-side duplicate check (the server validates format and HTTPS rules per row). */
export function duplicateOriginErrors(rows: OriginRow[]): Record<number, string> {
  const seen = new Map<string, number>();
  const out: Record<number, string> = {};
  rows.forEach((r, i) => {
    const k = `${r.origin.trim().toLowerCase().replace(/\/+$/, '')}|${r.patternType}`;
    if (!r.origin.trim()) return;
    const first = seen.get(k);
    if (first !== undefined) out[i] = tStatic('sites.origins.duplicate', { n: first + 1 });
    else seen.set(k, i);
  });
  return out;
}

/** Map `origins.N.origin` server errors onto visible rows. */
export function originErrorsFrom(e: unknown, indexMap: number[]): Record<number, string> {
  const out: Record<number, string> = {};
  if (!isApiError(e)) return out;
  for (const [k, v] of Object.entries(e.fieldErrors)) {
    const m = /^origins\.(\d+)(?:\.(origin|pattern_type))?$/.exec(k);
    if (!m) continue;
    const row = indexMap[Number(m[1])];
    if (row !== undefined && v[0]) out[row] = v[0];
  }
  return out;
}

export function OriginsEditor({
  rows,
  onChange,
  errors,
  disabled,
  legend,
}: {
  rows: OriginRow[];
  onChange: (rows: OriginRow[]) => void;
  errors: Record<number, string>;
  disabled?: boolean;
  legend?: string;
}) {
  const t = useT();
  const update = (i: number, patch: Partial<OriginRow>) =>
    onChange(
      rows.map((r, j) =>
        j === i
          ? {
              ...r,
              ...patch,
              ...(patch.origin !== undefined || patch.patternType !== undefined ? { verifiedAt: null } : {}),
            }
          : r,
      ),
    );
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">{legend ?? t('sites.origins.legend')}</legend>
      <p className="-mt-1 text-xs text-fg-2">{t('sites.origins.help')}</p>
      {rows.map((r, i) => (
        <div key={r.key} className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <Field label={t('sites.origins.originN', { n: i + 1 })} hideLabel error={errors[i]} className="min-w-0 flex-1">
            <Input
              value={r.origin}
              placeholder="https://www.example.com" // i18n-ignore: example URL
              dir="ltr"
              inputMode="url"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={300}
              onChange={(e) => update(i, { origin: e.target.value })}
            />
          </Field>
          <div className="flex items-start gap-2">
            <Field label={t('sites.origins.matchN', { n: i + 1 })} hideLabel className="w-full sm:w-44">
              <Select
                value={r.patternType}
                onChange={(e) => update(i, { patternType: e.target.value as OriginRow['patternType'] })}
              >
                <option value="exact">{t('sites.origins.exact')}</option>
                <option value="subdomain">{t('sites.origins.subdomain')}</option>
              </Select>
            </Field>
            <Button
              variant="ghost"
              size="icon"
              aria-label={r.origin ? t('sites.origins.removeNamed', { n: i + 1, origin: r.origin }) : t('sites.origins.remove', { n: i + 1 })}
              disabled={disabled || (rows.length === 1 && !r.origin)}
              onClick={() => onChange(rows.length === 1 ? [newOriginRow()] : rows.filter((_, j) => j !== i))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          {r.verifiedAt && (
            <span className="inline-flex items-center gap-1 text-xs text-success sm:hidden">
              <CheckCircle2 className="size-3.5" aria-hidden /> {t('sites.origins.widgetSeen', { time: formatRelative(r.verifiedAt) })}
            </span>
          )}
          {r.verifiedAt && (
            <span
              className="hidden h-10 items-center gap-1 whitespace-nowrap text-xs text-success sm:inline-flex"
              title={formatDateTime(r.verifiedAt)}
            >
              <CheckCircle2 className="size-3.5" aria-hidden /> {t('sites.origins.seen', { time: formatRelative(r.verifiedAt) })}
            </span>
          )}
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        className="self-start"
        onClick={() => onChange([...rows, newOriginRow()])}
        disabled={disabled || rows.length >= MAX_ORIGINS}
      >
        <Plus className="size-4" aria-hidden /> {t('sites.origins.add')}
      </Button>
      {rows.length >= MAX_ORIGINS && (
        <p className="text-xs text-fg-2">{t('sites.origins.limit', { count: MAX_ORIGINS })}</p>
      )}
    </fieldset>
  );
}
