'use client';
/**
 * Time-series line chart with an accessible table alternative (ch. 51). Series
 * are distinguished by color, line pattern, marker shape and a legend, so
 * identity never depends on hue alone. Buckets come straight from the API
 * (`series[].key` is already local to the report timezone).
 */
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ReactNode } from 'react';
import { Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { intlLocale, tStatic, useI18n } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatDayKey } from './range';
import type { GroupBy } from './types';
import { SERIES_COLORS, useIsDark } from './use-theme';

export type Marker = 'circle' | 'square' | 'triangle';

export interface SeriesDef {
  id: string;
  label: string;
  /** Index into SERIES_COLORS (fixed per entity, never by rank). */
  slot: 0 | 1 | 2;
  dash?: string;
  marker: Marker;
}

export interface ChartRow {
  key: string;
  start: string;
  [series: string]: number | null | string;
}

export interface ExtraColumn {
  id: string;
  label: string;
  render: (row: ChartRow) => ReactNode;
}

const DASH: Record<string, string | undefined> = { solid: undefined, dashed: '7 4', dotted: '2 3' };
export const LINE_PATTERN = DASH;

/** Bucket label from the API key (local date or local hour + offset). */
export function bucketLabel(key: string, group: GroupBy, multiDay: boolean, long = false): string {
  const day = key.slice(0, 10);
  const short = (k: string) => {
    const [y, m, d] = k.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  if (group === 'hour') {
    const hour = key.slice(11, 16);
    if (long) return tStatic('analytics.chart.dayHour', { date: formatDayKey(day), hour });
    return multiDay ? tStatic('analytics.chart.dayHourShort', { date: short(day), hour }) : hour;
  }
  if (group === 'week') return long ? tStatic('analytics.chart.weekStarting', { date: formatDayKey(day) }) : short(day);
  return long ? formatDayKey(day) : short(day);
}

function MarkerShape({ shape, cx, cy, color, surface, size = 4 }: { shape: Marker; cx: number; cy: number; color: string; surface: string; size?: number }) {
  if (shape === 'square') return <rect x={cx - size} y={cy - size} width={size * 2} height={size * 2} fill={color} stroke={surface} strokeWidth={2} />;
  if (shape === 'triangle') {
    const s = size + 1;
    return <path d={`M${cx},${cy - s} L${cx + s},${cy + s * 0.8} L${cx - s},${cy + s * 0.8} Z`} fill={color} stroke={surface} strokeWidth={2} />;
  }
  return <circle cx={cx} cy={cy} r={size} fill={color} stroke={surface} strokeWidth={2} />;
}

export function LegendSwatch({ def, dark }: { def: SeriesDef; dark: boolean }) {
  const color = (dark ? SERIES_COLORS.dark : SERIES_COLORS.light)[def.slot];
  return (
    <svg width="28" height="12" viewBox="0 0 28 12" aria-hidden className="shrink-0">
      <line x1="0" y1="6" x2="28" y2="6" stroke={color} strokeWidth={2} strokeDasharray={def.dash ? DASH[def.dash] : undefined} />
      <MarkerShape shape={def.marker} cx={14} cy={6} color={color} surface={dark ? '#11182b' : '#ffffff'} size={3.5} />
    </svg>
  );
}

export function SeriesChart({
  title,
  description,
  rows,
  series,
  group,
  multiDay,
  view,
  format,
  axisFormat,
  extraColumns = [],
  emptyText,
}: {
  title: string;
  description?: string;
  rows: ChartRow[];
  series: SeriesDef[];
  group: GroupBy;
  multiDay: boolean;
  view: 'chart' | 'table';
  format: (v: number | null) => string;
  axisFormat?: (v: number) => string;
  extraColumns?: ExtraColumn[];
  emptyText?: string;
}) {
  const { t, dir } = useI18n();
  const dark = useIsDark();
  const colors = dark ? SERIES_COLORS.dark : SERIES_COLORS.light;
  // Mirrors --surface / --border-subtle / --text-2 (SVG presentation attributes cannot read CSS variables).
  const surface = dark ? '#11182b' : '#ffffff';
  const grid = dark ? '#212b45' : '#e6eaf3';
  const axis = dark ? '#b2bccf' : '#475369';
  const hasData = rows.some((r) => series.some((s) => typeof r[s.id] === 'number' && (r[s.id] as number) !== 0));

  return (
    <figure className="flex min-w-0 flex-col gap-3">
      <figcaption className="flex flex-col gap-1">
        <span className="text-base font-semibold text-fg">{title}</span>
        {description && <span className="text-sm text-fg-2">{description}</span>}
      </figcaption>
      <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label={t('analytics.chart.legend', { title })}>
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-sm text-fg-2">
            <LegendSwatch def={s} dark={dark} />
            <span>{s.label}</span>
          </li>
        ))}
      </ul>
      {view === 'chart' ? (
        // The plot keeps time flowing left to right in every language; its labels and tooltip are translated.
        <div className="relative h-[260px] w-full min-w-0" dir="ltr">
          <p className="sr-only" dir={dir}>
            {t('analytics.chart.srSummary', { title: title.toLowerCase() })}
          </p>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }} accessibilityLayer>
              <CartesianGrid vertical={false} stroke={grid} strokeWidth={1} />
              <XAxis
                dataKey="key"
                tickFormatter={(k: string) => bucketLabel(k, group, multiDay)}
                tick={{ fill: axis, fontSize: 12 }}
                tickLine={false}
                axisLine={{ stroke: grid }}
                minTickGap={24}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: axis, fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={52}
                tickFormatter={axisFormat ?? ((v: number) => String(v))}
              />
              <Tooltip
                isAnimationActive={false}
                cursor={{ stroke: axis, strokeWidth: 1 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-[var(--shadow-float)]" dir={dir}>
                      <p className="mb-1 font-semibold text-fg">{bucketLabel(String(label), group, multiDay, true)}</p>
                      <ul className="flex flex-col gap-0.5">
                        {series.map((s) => {
                          const row = payload[0]?.payload as ChartRow | undefined;
                          const v = row ? (row[s.id] as number | null) : null;
                          return (
                            <li key={s.id} className="flex items-center gap-2 text-fg-2">
                              <LegendSwatch def={s} dark={dark} />
                              <span>{s.label}</span>
                              <span className="ms-auto ps-3 font-medium tabular text-fg">{format(v ?? null)}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                }}
              />
              {series.map((s) => (
                <Line
                  key={s.id}
                  type="linear"
                  dataKey={s.id}
                  name={s.label}
                  stroke={colors[s.slot]}
                  strokeWidth={2}
                  strokeDasharray={s.dash ? DASH[s.dash] : undefined}
                  connectNulls={false}
                  isAnimationActive={false}
                  dot={(p: { cx?: number; cy?: number; index?: number; value?: unknown }) =>
                    typeof p.cx === 'number' && typeof p.cy === 'number' && p.value !== null && p.value !== undefined ? (
                      <MarkerShape key={`${s.id}-${p.index}`} shape={s.marker} cx={p.cx} cy={p.cy} color={colors[s.slot]} surface={surface} />
                    ) : (
                      <g key={`${s.id}-${p.index}`} />
                    )
                  }
                  activeDot={(p: { cx?: number; cy?: number; index?: number }) =>
                    typeof p.cx === 'number' && typeof p.cy === 'number' ? <MarkerShape key={`a-${s.id}-${p.index}`} shape={s.marker} cx={p.cx} cy={p.cy} color={colors[s.slot]} surface={surface} size={5} /> : <g />
                  }
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {!hasData && (
            <p className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-fg-2" dir={dir}>
              {emptyText ?? t('analytics.chart.empty')}
            </p>
          )}
        </div>
      ) : (
        <TableScroll className="max-h-[420px] rounded-md border border-line-subtle">
          <Table>
            <caption className="sr-only">{title}</caption>
            <THead>
              <tr>
                <TH>{group === 'hour' ? t('analytics.chart.hour') : group === 'week' ? t('analytics.chart.week') : t('analytics.chart.day')}</TH>
                {series.map((s) => (
                  <TH key={s.id} className="text-end">
                    {s.label}
                  </TH>
                ))}
                {extraColumns.map((c) => (
                  <TH key={c.id} className="text-end">
                    {c.label}
                  </TH>
                ))}
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => (
                <TR key={r.key}>
                  <TD className="whitespace-nowrap">{bucketLabel(r.key, group, multiDay, true)}</TD>
                  {series.map((s) => (
                    <TD key={s.id} className={cn('text-end tabular', r[s.id] === null && 'text-fg-2')}>
                      {format((r[s.id] as number | null) ?? null)}
                    </TD>
                  ))}
                  {extraColumns.map((c) => (
                    <TD key={c.id} className="text-end tabular">
                      {c.render(r)}
                    </TD>
                  ))}
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      )}
    </figure>
  );
}
