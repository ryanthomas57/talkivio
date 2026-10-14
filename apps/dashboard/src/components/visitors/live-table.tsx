'use client';
/**
 * Windowed live visitor table: grouped rows (Incoming, Served, Browsing, Idle),
 * fixed row heights, spacer rows, and scroll anchoring — when realtime patches
 * insert or remove rows above the viewport the first visible row stays put, and
 * the selected row is kept by visitor id rather than position.
 */
import { BadgeCheck, Globe, Info, MessageSquare, Timer } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { cn } from '@/lib/cn';
import { countryName, flagEmoji, formatDuration, formatDurationLong, formatNumber } from '@/lib/format';
import { Elapsed, PageCell, ticking, useMonoNow } from './display';
import type { LiveRow } from './live-model';
import { GROUP_HINT, GROUP_LABEL, type LiveGroup, type LiveVisitor } from './types';
import { useWindowedRows } from './windowing';

const ROW_H = 56;
const GROUP_H = 36;
const HEAD_H = 40;

type Item =
  { kind: 'group'; group: LiveGroup; loaded: number } | { kind: 'row'; row: LiveRow; index: number };

const COLS: Array<{
  key: string;
  label: MessageKey;
  width: number;
  sticky?: boolean;
  srOnly?: boolean;
}> = [
  { key: 'visitor', label: 'common.visitor', width: 240, sticky: true },
  { key: 'ip', label: 'visitors.live.col.ip', width: 200 },
  { key: 'page', label: 'visitors.live.col.viewing', width: 300 },
  { key: 'site', label: 'visitors.live.col.onSite', width: 96 },
  { key: 'sessions', label: 'visitors.live.col.visits', width: 72 },
  { key: 'chat', label: 'common.chat', width: 136 },
  { key: 'more', label: 'visitors.live.col.details', width: 52, srOnly: true },
];
const TABLE_W = COLS.reduce((n, c) => n + c.width, 0);

export function LiveTable({
  rows,
  counts,
  version,
  selectedId,
  onOpen,
  onDetails,
  onNearEnd,
  showGroups,
  label,
}: {
  rows: LiveRow[];
  counts: Partial<Record<LiveGroup, number>>;
  version: number;
  selectedId: string | null;
  /** Click on a visitor: their chat window opens in the dock. */
  onOpen: (v: LiveVisitor) => void;
  /** The details button: the visitor drawer. */
  onDetails: (id: string) => void;
  onNearEnd: () => void;
  showGroups: LiveGroup[];
  label: string;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const now = useMonoNow(1000);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    let i = 0;
    for (const g of showGroups) {
      const groupRows = rows.filter((r) => r.v.group === g);
      // Empty groups take no space; the activity chips above still show every count.
      if (!groupRows.length && !(counts[g] ?? 0)) continue;
      out.push({ kind: 'group', group: g, loaded: groupRows.length });
      for (const row of groupRows) out.push({ kind: 'row', row, index: i++ });
    }
    return out;
  }, [rows, showGroups, counts]);
  const heights = useMemo(() => items.map((it) => (it.kind === 'group' ? GROUP_H : ROW_H)), [items]);
  const { range, scrollToIndex, anchor, offsets } = useWindowedRows(scrollRef, heights, HEAD_H);
  const posById = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((it, i) => it.kind === 'row' && m.set(it.row.v.visitorId, i));
    return m;
  }, [items]);

  // ── Scroll anchoring across realtime updates ──
  const anchorRef = useRef<{ id: string; delta: number } | null>(null);
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    const a = anchor();
    if (!el || !a || el.scrollTop <= 0) {
      anchorRef.current = null;
      return;
    }
    // Anchor on the first data row at or below the viewport top.
    let idx = a.index;
    while (idx < items.length && items[idx]!.kind !== 'row') idx++;
    const it = items[idx];
    anchorRef.current =
      it && it.kind === 'row' ? { id: it.row.v.visitorId, delta: el.scrollTop - offsets[idx]! } : null;
  }, [anchor, items, offsets]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => captureAnchor();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [captureAnchor]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchorRef.current;
    if (!el || !a) return;
    const idx = posById.get(a.id);
    if (idx === undefined) return;
    const want = offsets[idx]! + a.delta;
    if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Ask for the next page shortly before the end of the loaded rows.
  useEffect(() => {
    if (items.length && range.end >= items.length - 15) onNearEnd();
  }, [range.end, items.length, onNearEnd]);

  // ── Keyboard: ArrowUp/Down move between visitor buttons, Home/End jump ──
  const focusRow = useCallback(
    (pos: number) => {
      scrollToIndex(pos);
      requestAnimationFrame(() => {
        const it = items[pos];
        if (it?.kind !== 'row') return;
        scrollRef.current
          ?.querySelector<HTMLButtonElement>(`[data-visitor-button="${it.row.v.visitorId}"]`)
          ?.focus();
      });
    },
    [items, scrollToIndex],
  );
  const onKey = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
      const pos = posById.get(id);
      if (pos === undefined) return;
      const step = (from: number, dir: 1 | -1) => {
        let p = from + dir;
        while (p >= 0 && p < items.length && items[p]!.kind !== 'row') p += dir;
        return p >= 0 && p < items.length ? p : null;
      };
      let target: number | null = null;
      if (e.key === 'ArrowDown') target = step(pos, 1);
      else if (e.key === 'ArrowUp') target = step(pos, -1);
      else if (e.key === 'Home') target = step(-1, 1);
      else if (e.key === 'End') target = step(items.length, -1);
      if (target === null) return;
      e.preventDefault();
      focusRow(target);
    },
    [posById, items, focusRow],
  );

  // Bring a selection restored from the URL into view once it is loaded.
  const restored = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || restored.current === selectedId) return;
    const pos = posById.get(selectedId);
    if (pos === undefined) return;
    restored.current = selectedId;
    scrollToIndex(pos);
  }, [selectedId, posById, scrollToIndex]);

  const totalRows = rows.length;
  const visible = items.slice(range.start, range.end);

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-auto scroll-thin"
      role="region"
      aria-label={label}
      tabIndex={-1}
    >
      <table
        className="table-fixed border-collapse text-start text-sm"
        style={{ width: TABLE_W, minWidth: '100%' }}
        aria-rowcount={totalRows + 1}
      >
        <colgroup>
          {COLS.map((c) => (
            <col key={c.key} style={{ width: c.width }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-[2] bg-surface-2">
          <tr aria-rowindex={1} style={{ height: HEAD_H }}>
            {COLS.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  'whitespace-nowrap border-b border-line px-3 text-start text-xs font-semibold uppercase tracking-wide text-fg-2',
                  c.sticky && 'sticky start-0 z-[3] bg-surface-2',
                )}
              >
                {c.srOnly ? <span className="sr-only">{t(c.label)}</span> : t(c.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {range.padTop > 0 && <tr aria-hidden style={{ height: range.padTop }} />}
          {visible.map((it) =>
            it.kind === 'group' ? (
              <tr key={`g-${it.group}`} style={{ height: GROUP_H }} className="bg-canvas">
                <th
                  scope="colgroup"
                  colSpan={COLS.length}
                  className="sticky start-0 border-b border-line-subtle px-3 text-start text-xs font-semibold text-fg-2"
                >
                  <span className="inline-flex items-center gap-2">
                    <span className="uppercase tracking-wide text-fg">{t(GROUP_LABEL[it.group])}</span>
                    <span className="tabular">{formatNumber(counts[it.group] ?? it.loaded)}</span>
                    {counts[it.group] !== undefined && (counts[it.group] ?? 0) > it.loaded && (
                      <span className="font-normal">
                        {t('visitors.live.groupLoaded', { count: it.loaded })}
                      </span>
                    )}
                    <span className="hidden font-normal sm:inline">· {t(GROUP_HINT[it.group])}</span>
                  </span>
                </th>
              </tr>
            ) : (
              <VisitorRow
                key={it.row.v.visitorId}
                row={it.row}
                rowIndex={it.index + 2}
                now={now}
                selected={it.row.v.visitorId === selectedId}
                onOpen={onOpen}
                onDetails={onDetails}
                onKey={onKey}
              />
            ),
          )}
          {range.padBottom > 0 && <tr aria-hidden style={{ height: range.padBottom }} />}
        </tbody>
      </table>
    </div>
  );
}

const VisitorRow = memo(function VisitorRow({
  row,
  rowIndex,
  now,
  selected,
  onOpen,
  onDetails,
  onKey,
}: {
  row: LiveRow;
  rowIndex: number;
  now: number;
  selected: boolean;
  onOpen: (v: LiveVisitor) => void;
  onDetails: (id: string) => void;
  onKey: (e: KeyboardEvent<HTMLButtonElement>, id: string) => void;
}) {
  const t = useT();
  const v = row.v;
  const onSite = v.browsingHidden ? null : ticking(v.timeOnSiteMs, row.recv, now);
  const wait = v.chat ? ticking(v.chat.waitMs, row.recv, now) : null;
  const flag = flagEmoji(v.country);
  const country = countryName(v.country);
  const cell = 'border-b border-line-subtle px-3 align-middle';
  return (
    <tr
      aria-rowindex={rowIndex}
      aria-selected={selected || undefined}
      style={{ height: ROW_H }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a')) return;
        onOpen(v);
      }}
      className={cn('group cursor-pointer', selected ? 'bg-primary-tint' : 'hover:bg-surface-2')}
    >
      <td
        className={cn(
          cell,
          'sticky start-0 z-[1]',
          selected ? 'bg-primary-tint' : 'bg-surface group-hover:bg-surface-2',
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex w-6 shrink-0 justify-center text-lg leading-none"
            title={country ?? undefined}
            aria-hidden
          >
            {flag ?? <Globe className="size-4 text-fg-3" />}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                data-visitor-button={v.visitorId}
                onClick={() => onOpen(v)}
                onKeyDown={(e) => onKey(e, v.visitorId)}
                aria-label={t('visitors.live.openChat', { name: v.displayName })}
                dir="auto"
                className="max-w-full truncate rounded-sm text-start font-medium text-fg hover:underline"
              >
                {v.displayName}
              </button>
              {v.identity.verified && (
                <BadgeCheck
                  className="size-4 shrink-0 text-success"
                  aria-label={t('visitors.display.verified')}
                />
              )}
            </span>
            {country && <span className="truncate text-xs text-fg-2">{country}</span>}
          </div>
        </div>
      </td>
      <td className={cell}>
        {v.ipAddress ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono text-xs" dir="ltr">
              {v.ipAddress}
            </span>
            {v.network && (
              <span className="truncate text-xs text-fg-2" title={v.network} dir="auto">
                {v.network}
              </span>
            )}
          </div>
        ) : null}
      </td>
      <td className={cell}>
        <div className="flex min-w-0 flex-col gap-0.5">
          {!v.browsingHidden && v.currentTitle && (
            <span className="truncate" dir="auto">
              {v.currentTitle}
            </span>
          )}
          <div className={cn('min-w-0', !v.browsingHidden && v.currentTitle && 'text-xs text-fg-2')}>
            <PageCell url={v.currentUrl} title={v.currentTitle} hidden={v.browsingHidden} />
          </div>
        </div>
      </td>
      <td className={cell}>
        <Elapsed ms={onSite} />
      </td>
      <td className={cell}>
        <span className="tabular">{v.sessionCount === null ? '' : formatNumber(v.sessionCount)}</span>
      </td>
      <td className={cell}>
        {v.chat ? (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 font-medium',
              v.group === 'incoming' ? 'text-warning' : 'text-success',
            )}
          >
            {v.group === 'incoming' ? (
              <Timer className="size-3.5" aria-hidden />
            ) : (
              <MessageSquare className="size-3.5" aria-hidden />
            )}
            {v.group === 'incoming' ? (
              <span
                className="tabular"
                aria-label={
                  wait === null
                    ? undefined
                    : t('visitors.live.waiting', { duration: formatDurationLong(wait) })
                }
              >
                {wait === null
                  ? t('visitors.group.incoming')
                  : t('visitors.live.waiting', { duration: formatDuration(wait) })}
              </span>
            ) : (
              t('visitors.live.inChat')
            )}
          </span>
        ) : null}
      </td>
      <td className={cn(cell, 'px-1 text-center')}>
        <button
          type="button"
          onClick={() => onDetails(v.visitorId)}
          aria-haspopup="dialog"
          aria-label={t('visitors.live.details', { name: v.displayName })}
          className="inline-flex size-9 items-center justify-center rounded-md text-fg-2 hover:bg-surface-3 hover:text-fg"
        >
          <Info className="size-4" aria-hidden />
        </button>
      </td>
    </tr>
  );
});
