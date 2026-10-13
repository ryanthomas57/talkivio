'use client';
import { useSyncExternalStore } from 'react';
import { intlLocale } from '@/i18n';

/** True while the dashboard renders in dark mode (`.dark` on <html>, set by ThemeSync). */
export function useIsDark(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const obs = new MutationObserver(cb);
      obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => obs.disconnect();
    },
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );
}

/**
 * Categorical chart slots validated with the dataviz palette checker (adjacent
 * CVD ΔE ≥ 9.2, normal-vision ≥ 26 in both modes against our surfaces). Slot 3
 * is below 3:1 on white, so every chart also ships a legend, line patterns,
 * marker shapes and a table view (never color alone).
 */
export const SERIES_COLORS = {
  light: ['#2a78d6', '#eb6834', '#1baf7a'],
  dark: ['#3987e5', '#d95926', '#199e70'],
} as const;

/** Time in a given IANA timezone: "2:04:11 AM". */
export function timeIn(v: string | Date | null | undefined, timeZone?: string): string {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleTimeString(intlLocale(), { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone });
  } catch {
    return d.toLocaleTimeString(intlLocale());
  }
}
