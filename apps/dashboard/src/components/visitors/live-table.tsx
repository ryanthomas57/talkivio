'use client';
/**
 * Windowed live visitor table in the classic live chat layout: collapsible group sections ("Incoming chats …
 * Visitors: 3"), one line per visitor with an activity square, flag and device, then IP address, time online,
 * the page being viewed (with pages viewed), referrer, visits and chat state. Fixed row heights, spacer rows and
 * scroll anchoring keep 10 000 rows usable: when realtime patches insert or remove rows above the viewport the
 * first visible row stays put, and the selected row is kept by visitor id rather than position.
 */
import { BadgeCheck, ChevronDown, Eye, Hand, Info, MessageSquare, Moon } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { cn } from '@/lib/cn';
import { countryName, flagEmoji, formatDuration, formatDurationLong, formatNumber } from '@/lib/format';
import { DEVICE, originLabel, ticking, urlLabel, useMonoNow } from './display';
import type { LiveRow } from './live-model';
import { GROUP_LABEL, type LiveGroup, type LiveVisitor } from './types';
import { useWindowedRows } from './windowing';

const ROW_H = 56;
const GROUP_H = 56;
const HEAD_H = 44;

/** A section of the table: rows that share an activity, a country or a page. */
export interface TableGroup {
  key: string;
  label: string;
  hint?: string;
  /** Visitors in the group (server count for activity groups, loaded rows otherwise). */
  total: number;
  rows: LiveRow[];
}

type Item =
  { kind: 'group'; group: TableGroup; collapsed: boolean } | { kind: 'row'; row: LiveRow; index: number };

const COLS: Array<{ key: string; label: MessageKey; width: number; sticky?: boolean; srOnly?: boolean }> = [
  { key: 'visitor', label: 'common.visitor', width: 270, sticky: true },
  { key: 'ip', label: 'visitors.live.col.ip', width: 150 },
  { key: 'online', label: 'visitors.live.col.online', width: 84 },
  { key: 'viewing', label: 'visitors.live.col.viewing', width: 290 },
  { key: 'ref', label: 'visitors.live.col.referrer', width: 140 },
  { key: 'visits', label: 'visitors.live.col.visits', width: 64 },
  { key: 'chat', label: 'common.chat', width: 116 },
  { key: 'more', label: 'visitors.live.col.details', width: 44, srOnly: true },
];
const TABLE_W = COLS.reduce((n, c) => n + c.width, 0);

/** The activity square at the start of each row (a raised hand asks for a chat, as in classic live chat). */
const ACTIVITY: Record<LiveGroup, { Icon: typeof Hand; cls: string }> = {
  incoming: { Icon: Hand, cls: 'bg-warning text-white' },
  served: { Icon: MessageSquare, cls: 'bg-success text-white' },
  browsing: { Icon: Eye, cls: 'bg-primary-tint text-primary' },
  idle: { Icon: Moon, cls: 'bg-surface-3 text-fg-2' },
};

export function LiveTable({
  groups,
  collapsed,
  onToggleGroup,
  version,
  selectedId,
  onOpen,
  onDetails,
  onNearEnd,
  label,
}: {
  groups: TableGroup[];
  collapsed: Set<string>;
  onToggleGroup: (key: string) => void;
  version: number;
  selectedId: string | null;
  /** Click on a visitor: their chat window opens in the dock. */
  onOpen: (v: LiveVisitor) => void;
  /** The details button: the visitor drawer. */
  onDetails: (id: string) => void;
  onNearEnd: () => void;
  label: string;
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const now = useMonoNow(1000);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    let i = 0;
    for (const g of groups) {
      const shut = collapsed.has(g.key);
      out.push({ kind: 'group', group: g, collapsed: shut });
      if (!shut) for (const row of g.rows) out.push({ kind: 'row', row, index: i++ });
    }
    return out;
  }, [groups, collapsed]);
  const totalRows = useMemo(() => groups.reduce((n, g) => n + g.rows.length, 0), [groups]);
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
        <thead className="sticky top-0 z-[2] bg-surface">
          <tr aria-rowindex={1} style={{ height: HEAD_H }}>
            {COLS.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  'whitespace-nowrap border-b border-line px-3 text-start text-sm font-semibold text-fg',
                  c.sticky && 'sticky start-0 z-[3] bg-surface ps-14',
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
              <GroupRow
                key={`g-${it.group.key}`}
                group={it.group}
                collapsed={it.collapsed}
                onToggle={onToggleGroup}
              />
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

function GroupRow({
  group,
  collapsed,
  onToggle,
}: {
  group: TableGroup;
  collapsed: boolean;
  onToggle: (key: string) => void;
}) {
  const t = useT();
  return (
    <tr style={{ height: GROUP_H }} className="bg-canvas">
      <th scope="colgroup" colSpan={COLS.length} className="border-b border-line px-3 text-start font-normal">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onToggle(group.key)}
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? 'visitors.live.expandGroup' : 'visitors.live.collapseGroup', {
              group: group.label,
            })}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-fg-2 hover:bg-surface-3 hover:text-fg"
          >
            <ChevronDown
              className={cn('size-4 transition-transform', !collapsed && 'rotate-180')}
              aria-hidden
            />
          </button>
          <span className="min-w-0 truncate text-[15px] font-medium text-fg" dir="auto">
            {group.label}
          </span>
          {group.hint && <span className="hidden truncate text-xs text-fg-2 lg:inline">{group.hint}</span>}
          <span className="ms-auto shrink-0 pe-1 text-sm text-fg-2">
            {t('visitors.live.groupCount', { count: formatNumber(group.total) })}
            {group.total > group.rows.length && (
              <span className="ms-1.5 text-xs">
                {t('visitors.live.groupLoaded', { count: group.rows.length })}
              </span>
            )}
          </span>
        </div>
      </th>
    </tr>
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
  const device = v.deviceCategory ? DEVICE[v.deviceCategory] : undefined;
  const deviceText = [device ? t(device.label) : null, v.browser, v.os].filter(Boolean).join(' · ');
  const activity = ACTIVITY[v.group];
  const page = v.browsingHidden ? null : v.currentTitle || (v.currentUrl ? urlLabel(v.currentUrl) : null);
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
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-md', activity.cls)}
            title={t(GROUP_LABEL[v.group])}
            aria-hidden
          >
            <activity.Icon className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
            {v.tags.length > 0 && (
              <span className="flex min-w-0 gap-1 overflow-hidden">
                {v.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag.id}
                    className="truncate rounded-sm bg-surface-3 px-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-2"
                    dir="auto"
                  >
                    {tag.label}
                  </span>
                ))}
              </span>
            )}
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-fg-3">
            {flag && (
              <span
                className="text-base leading-none"
                title={country ?? undefined}
                role="img"
                aria-label={country ?? ''}
              >
                {flag}
              </span>
            )}
            {device && (
              <span title={deviceText} role="img" aria-label={deviceText}>
                <device.Icon className="size-4" aria-hidden />
              </span>
            )}
          </span>
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
      <td className={cn(cell, 'whitespace-nowrap tabular')}>
        {onSite === null ? null : t('visitors.live.minutes', { count: Math.floor(onSite / 60_000) })}
      </td>
      <td className={cell}>
        {page ? (
          <div className="flex min-w-0 items-center gap-2">
            {v.pageViews !== null && v.pageViews > 0 && (
              <span
                className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-sm bg-fg-3 px-1 text-[11px] font-semibold text-surface tabular"
                title={t('visitors.live.pagesViewed', { count: v.pageViews })}
                role="img"
                aria-label={t('visitors.live.pagesViewed', { count: v.pageViews })}
              >
                {v.pageViews}
              </span>
            )}
            <span
              className="min-w-0 truncate"
              dir="auto"
              title={v.currentUrl ? urlLabel(v.currentUrl) : undefined}
            >
              {page}
            </span>
          </div>
        ) : v.browsingHidden ? (
          <span className="text-xs text-fg-3">{t('visitors.display.pageHidden')}</span>
        ) : null}
      </td>
      <td className={cell}>
        {!v.browsingHidden && v.referrerOrigin ? (
          <span className="block truncate" title={v.referrerOrigin} dir="auto">
            {originLabel(v.referrerOrigin)}
          </span>
        ) : null}
      </td>
      <td className={cn(cell, 'tabular')}>{v.sessionCount === null ? '' : formatNumber(v.sessionCount)}</td>
      <td className={cell}>
        {v.chat ? (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 font-medium',
              v.group === 'incoming' ? 'text-warning' : 'text-success',
            )}
          >
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
