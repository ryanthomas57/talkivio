'use client';
/**
 * Minimal list windowing (no dependency): rows have known heights (one per row
 * kind), offsets are prefix sums, and only rows intersecting the viewport (plus
 * overscan) render. Spacer elements keep the scroll height exact so the
 * scrollbar and keyboard scrolling behave like a full list.
 */
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';

export interface WindowRange {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  total: number;
  offsets: Float64Array;
}

/** Index of the last row whose top offset is ≤ y. */
function rowAt(offsets: Float64Array, count: number, y: number): number {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

export function prefixOffsets(heights: number[]): Float64Array {
  const out = new Float64Array(heights.length + 1);
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i]! + heights[i]!;
  return out;
}

/**
 * @param scrollRef  scroll container
 * @param heights    height of every row in px
 * @param headerPx   space above the first row inside the container (sticky header)
 * @param overscanPx extra px rendered above and below the viewport
 */
export function useWindowedRows(scrollRef: RefObject<HTMLElement | null>, heights: number[], headerPx = 0, overscanPx = 600) {
  const offsets = useMemo(() => prefixOffsets(heights), [heights]);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setViewport((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    };
    const onScroll = () => {
      // Hidden documents get no animation frames; read synchronously there.
      if (document.visibilityState === 'hidden') return read();
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef]);

  const count = heights.length;
  const total = offsets[count] ?? 0;
  const range: WindowRange = useMemo(() => {
    if (!count) return { start: 0, end: 0, padTop: 0, padBottom: 0, total: 0, offsets };
    const top = Math.max(0, viewport.top - headerPx - overscanPx);
    const bottom = viewport.top - headerPx + viewport.height + overscanPx;
    const start = rowAt(offsets, count, top);
    const end = Math.min(count, rowAt(offsets, count, Math.max(0, bottom)) + 1);
    return { start, end, padTop: offsets[start]!, padBottom: total - offsets[end]!, total, offsets };
  }, [count, offsets, total, viewport.top, viewport.height, headerPx, overscanPx]);

  /** Scroll so row `i` is fully visible (keyboard navigation, restored selection). */
  const scrollToIndex = useCallback(
    (i: number) => {
      const el = scrollRef.current;
      if (!el || i < 0 || i >= count) return;
      const rowTop = offsets[i]! + headerPx;
      const rowBottom = offsets[i + 1]! + headerPx;
      if (rowTop - headerPx < el.scrollTop) el.scrollTop = rowTop - headerPx;
      else if (rowBottom > el.scrollTop + el.clientHeight) el.scrollTop = rowBottom - el.clientHeight;
    },
    [scrollRef, count, offsets, headerPx],
  );

  /** First row intersecting the viewport and how far its top sits above the viewport top. */
  const anchor = useCallback((): { index: number; delta: number } | null => {
    const el = scrollRef.current;
    if (!el || !count) return null;
    const y = Math.max(0, el.scrollTop);
    const index = rowAt(offsets, count, y);
    return { index, delta: y - offsets[index]! };
  }, [scrollRef, count, offsets]);

  return { range, scrollToIndex, anchor, offsets };
}
