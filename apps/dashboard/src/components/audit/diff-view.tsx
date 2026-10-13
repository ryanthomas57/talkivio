'use client';
/**
 * Safe diff renderer (ch. 54): audit diffs are shown as readable key/value rows —
 * `before`/`after` pairs pivot into a three-column table and `{from, to}` leaves read
 * "old → new". Values the server withheld (`[changed]`) say so explicitly. Raw JSON
 * is never dumped.
 */
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT, type Translate } from '@/i18n';
import { formatDateTime } from '@/lib/format';

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

export function DiffValue({ value }: { value: unknown }): ReactNode {
  const t = useT();
  if (value === null || value === undefined) return <span className="text-fg-2">{t('audit.diff.none')}</span>;
  if (value === '[changed]') return <span className="italic text-fg-2">{t('audit.diff.changedNotRecorded')}</span>;
  if (value === '[truncated]') return <span className="italic text-fg-2">{t('audit.diff.tooDeep')}</span>;
  if (typeof value === 'boolean') return <span>{value ? t('common.yes') : t('common.no')}</span>;
  if (typeof value === 'number') return <span className="tabular">{String(value)}</span>;
  if (typeof value === 'string') {
    if (value === '') return <span className="text-fg-2">{t('audit.diff.empty')}</span>;
    if (ISO_RE.test(value)) return <time dateTime={value} title={value}>{formatDateTime(value)}</time>;
    return <span className="break-words" dir="auto">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-fg-2">{t('audit.diff.none')}</span>;
    if (value.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) return <span className="break-words" dir="auto">{value.map((x) => (x === null ? t('audit.diff.none') : String(x))).join(t('audit.diff.listSeparator'))}</span>;
    return <span className="text-fg-2">{t('common.countItems', { count: value.length })}</span>;
  }
  return <span className="text-fg-2">{t('audit.diff.details')}</span>;
}

function isFromTo(v: unknown): v is { from: unknown; to: unknown } {
  if (!isPlain(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k === 'from' || k === 'to');
}

interface Leaf {
  path: string;
  value: unknown;
  change?: { from: unknown; to: unknown };
}

function flatten(v: unknown, prefix = '', out: Leaf[] = [], depth = 0): Leaf[] {
  if (depth > 6) {
    out.push({ path: prefix || 'value', value: '[truncated]' });
    return out;
  }
  if (isFromTo(v)) {
    out.push({ path: prefix || 'value', value: null, change: { from: v.from, to: v.to } });
    return out;
  }
  if (isPlain(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (!entries.length && prefix) out.push({ path: prefix, value: null });
    for (const [k, x] of entries) flatten(x, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    return out;
  }
  if (Array.isArray(v) && v.some((x) => isPlain(x) || Array.isArray(x))) {
    v.forEach((x, i) => flatten(x, `${prefix || 'item'} ${i + 1}`, out, depth + 1));
    return out;
  }
  out.push({ path: prefix || 'value', value: v });
  return out;
}

/** Field keys are server data and stay as humanized keys; the synthetic "value" / "item N" segments are translated. */
function pathLabel(path: string, t: Translate): string {
  return path
    .split('.')
    .map((seg) => {
      if (seg === 'value') return t('audit.diff.value');
      const item = /^item (\d+)$/.exec(seg);
      return item ? t('audit.diff.item', { n: Number(item[1]) }) : fieldLabel(seg);
    })
    .join(' › ');
}

export function DiffView({ diff }: { diff: unknown }) {
  const t = useT();
  if (diff === null || diff === undefined || (isPlain(diff) && Object.keys(diff).length === 0)) return <p className="text-sm text-fg-2">{t('audit.diff.noDetails')}</p>;

  const pivot = isPlain(diff) && (isPlain(diff.before) || isPlain(diff.after)) ? { before: isPlain(diff.before) ? diff.before : {}, after: isPlain(diff.after) ? diff.after : {} } : null;
  const rest = pivot && isPlain(diff) ? Object.fromEntries(Object.entries(diff).filter(([k]) => k !== 'before' && k !== 'after')) : diff;
  const restLeaves = flatten(rest);

  return (
    <div className="flex flex-col gap-4">
      {pivot && <BeforeAfter before={pivot.before} after={pivot.after} />}
      {restLeaves.length > 0 && (
        <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[minmax(140px,max-content)_1fr]">
          {restLeaves.map((l) => (
            <div key={l.path} className="contents">
              <dt className="font-medium text-fg-2" title={l.path} dir="auto">
                {pathLabel(l.path, t)}
              </dt>
              <dd className="min-w-0">
                {l.change ? (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <DiffValue value={l.change.from} />
                    <ArrowRight className="size-3.5 shrink-0 text-fg-2 rtl:-scale-x-100" aria-label={t('audit.diff.changedTo')} />
                    <DiffValue value={l.change.to} />
                  </span>
                ) : (
                  <DiffValue value={l.value} />
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function BeforeAfter({ before, after }: { before: Plain; after: Plain }) {
  const t = useT();
  const b = new Map(flatten(before).map((l) => [l.path, l.value]));
  const a = new Map(flatten(after).map((l) => [l.path, l.value]));
  const paths = [...new Set([...b.keys(), ...a.keys()])];
  return (
    <div className="relative overflow-x-auto rounded-[var(--radius-control)] border border-line scroll-thin">
      <table className="w-full min-w-[420px] text-start text-sm">
        <thead className="bg-surface-3">
          <tr>
            <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-fg-2">
              {t('audit.diff.field')}
            </th>
            <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-fg-2">
              {t('audit.diff.before')}
            </th>
            <th scope="col" className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-fg-2">
              {t('audit.diff.after')}
            </th>
          </tr>
        </thead>
        <tbody>
          {paths.map((p) => {
            const changed = JSON.stringify(b.get(p)) !== JSON.stringify(a.get(p));
            return (
              <tr key={p} className="border-t border-line-subtle">
                <th scope="row" className="px-3 py-2 font-medium text-fg" title={p}>
                  <bdi>{pathLabel(p, t)}</bdi>
                  {changed && <span className="sr-only">{t('audit.diff.changedSr')}</span>}
                </th>
                <td className="px-3 py-2">{b.has(p) ? <DiffValue value={b.get(p)} /> : <span className="text-fg-2">{t('audit.diff.notRecorded')}</span>}</td>
                <td className={changed ? 'px-3 py-2 font-medium' : 'px-3 py-2'}>{a.has(p) ? <DiffValue value={a.get(p)} /> : <span className="text-fg-2">{t('audit.diff.notRecorded')}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
