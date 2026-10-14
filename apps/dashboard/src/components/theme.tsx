'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  isSiteRoute,
  rememberTheme,
  resolveDark,
  storedTheme,
  THEME_EVENT,
  THEME_KEY,
  type ThemeChoice,
} from '@/lib/theme';
import { useSession } from '@/stores/session';

/**
 * Applies light or dark mode: the signed-in member's preference first, then the choice stored in this browser,
 * then the page's default (dark for the website, light for the app).
 */
export function ThemeSync() {
  const pref = useSession((s) => s.agent?.preferences.theme as ThemeChoice | undefined);
  const path = usePathname();
  const local = useStoredTheme();
  const choice: ThemeChoice = pref ?? local ?? (isSiteRoute(path) ? 'dark' : 'light');

  // Mirror the member's preference into this browser so the next page load paints in it straight away.
  useEffect(() => {
    if (pref) rememberTheme(pref);
  }, [pref]);

  useEffect(() => {
    const root = document.documentElement;
    const apply = () => root.classList.toggle('dark', resolveDark(choice));
    apply();
    if (choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [choice]);
  return null;
}

/** The choice stored in this browser, kept current across tabs and toggles. */
export function useStoredTheme(): ThemeChoice | null {
  // Read straight away (not after mount), or the first pass would apply the default and flash the wrong colours.
  const [value, setValue] = useState<ThemeChoice | null>(() =>
    typeof window === 'undefined' ? null : storedTheme(),
  );
  useEffect(() => {
    const read = () => setValue(storedTheme());
    read();
    const onStorage = (e: StorageEvent) => e.key === THEME_KEY && read();
    window.addEventListener(THEME_EVENT, read);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(THEME_EVENT, read);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return value;
}
