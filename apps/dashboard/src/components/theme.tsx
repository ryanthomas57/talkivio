'use client';
import { useEffect } from 'react';
import { useSession } from '@/stores/session';

/** Applies the member's theme preference (light / dark / system). */
export function ThemeSync() {
  const theme = useSession((s) => (s.agent?.preferences.theme as 'light' | 'dark' | 'system' | undefined) ?? 'light');
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => root.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches));
    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  return null;
}
