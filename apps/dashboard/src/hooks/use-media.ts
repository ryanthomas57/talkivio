'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';

/** Breakpoints (ch. 06): mobile < 640, compact 640–1023, desktop 1024–1439, wide ≥ 1440. */
export function useMediaQuery(query: string, serverDefault = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => serverDefault,
  );
}

export const useIsMobile = () => useMediaQuery('(max-width: 639px)');
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)', true);

/** Re-render every `ms` (wait timers, countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
