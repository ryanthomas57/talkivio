'use client';
import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { rememberTheme } from '@/lib/theme';
import type { AgentMe } from '@/lib/types';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';

/** Whether the page is currently dark (follows the class ThemeSync and the boot script set on <html>). */
function useIsDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setDark(root.classList.contains('dark'));
    read();
    const mo = new MutationObserver(read);
    mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/**
 * Switches between light and dark mode. The choice is stored in this browser and, when signed in, saved to the
 * member's preferences so every page and device follows it.
 */
export function ThemeToggle({
  className,
  labels,
}: {
  className?: string;
  labels?: { toLight: string; toDark: string };
}) {
  const t = useT();
  const dark = useIsDark();
  const agent = useSession((s) => s.agent);
  const setAgent = useSession((s) => s.setAgent);
  const label = dark
    ? (labels?.toLight ?? t('common.theme.toLight'))
    : (labels?.toDark ?? t('common.theme.toDark'));

  const flip = () => {
    const next = dark ? 'light' : 'dark';
    rememberTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    if (!agent) return;
    const previous = agent.preferences;
    setAgent({ ...agent, preferences: { ...previous, theme: next } });
    api.patch<AgentMe>('/agents/me/preferences', { theme: next }).then(setAgent, (e: unknown) => {
      setAgent({ ...agent, preferences: previous });
      toast.error(errorMessage(e));
    });
  };

  return (
    <button
      type="button"
      onClick={flip}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-line text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg',
        className,
      )}
    >
      {dark ? <Sun className="size-[18px]" aria-hidden /> : <Moon className="size-[18px]" aria-hidden />}
    </button>
  );
}
