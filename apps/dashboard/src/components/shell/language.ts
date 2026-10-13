'use client';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useI18n, type Locale } from '@/i18n';
import { negotiateLocale } from '@/i18n/locales';
import { api, errorMessage } from '@/lib/api';
import type { AgentMe } from '@/lib/types';
import { useSession } from '@/stores/session';

/** The signed-in agent's saved language wins over this browser's cookie and Accept-Language (ch. 29). */
export function useAccountLocaleSync(): void {
  const { locale, setLocale } = useI18n();
  const saved = useSession((s) => s.agent?.preferences.locale ?? null);
  useEffect(() => {
    if (saved && saved !== locale) setLocale(saved);
    // Only when the saved preference changes; a local switch is followed by a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
}

/** Choose a language (null = same as the browser), apply it now and save it to the account. */
export function useLanguageChoice(): { choice: Locale | null; choose: (next: Locale | null) => Promise<void> } {
  const { setLocale, t } = useI18n();
  const agent = useSession((s) => s.agent);
  const setAgent = useSession((s) => s.setAgent);
  const choice = agent?.preferences.locale ?? null;
  const choose = async (next: Locale | null) => {
    setLocale(next ?? negotiateLocale(typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]), next !== null);
    if (!agent) return;
    try {
      setAgent(await api.patch<AgentMe>('/agents/me/preferences', { locale: next }));
    } catch (e) {
      toast.error(t('shell.language.saveFailed', { error: errorMessage(e) }));
    }
  };
  return { choice, choose };
}
