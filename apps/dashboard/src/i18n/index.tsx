'use client';
/**
 * Dashboard localization (ch. 29/59): every visible string comes from a typed catalog
 * (src/i18n/messages/<locale>/<area>.ts, English is the source of truth and the fallback).
 *
 *   const t = useT();             t('inbox.offers.accept', { name })
 *   tStatic('common.saved')       outside React (toasts in callbacks), uses the active locale
 *
 * Locale precedence: the agent's saved preference, then the rd_locale cookie (last explicit
 * choice in this browser), then Accept-Language / navigator.languages, then English. The root
 * layout renders <html lang dir> from the same inputs so the first paint is already mirrored.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MessageValues } from './format-message';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_META, type Locale } from './locales';
import type { MessageKey } from './messages/en';
import { hasCatalog, loadCatalog, makeT, registerCatalog, type Catalog, type Translate } from './translate';

export type { Locale } from './locales';
export type { MessageKey } from './messages/en';
export { LOCALES, LOCALE_META, isLocale } from './locales';

export type { Translate } from './translate';

let active: Locale = DEFAULT_LOCALE;
let activeT: Translate = makeT(DEFAULT_LOCALE);

/** The active locale outside React (formatters, toasts fired from callbacks). */
export function activeLocale(): Locale {
  return active;
}

/**
 * The Intl tag for dates, numbers and relative times: the browser's own regional variant when it speaks
 * the UI language (en-GB keeps 24-hour times, ar-AE its conventions), else the bare UI language.
 */
export function intlLocale(): string {
  if (typeof navigator !== 'undefined') {
    const regional = (navigator.languages ?? [navigator.language]).find((tag) => tag?.toLowerCase().split('-')[0] === active);
    if (regional) return regional;
  }
  return LOCALE_META[active].intl;
}

/**
 * Unicode first-strong isolate (FSI … PDI) around user content interpolated into a translated sentence, so
 * an English name inside Arabic copy (or the reverse) cannot reorder its neighbours. Visible text only — not
 * for file names, URLs or values that are copied/sent.
 */
export function isolate(value: string | null | undefined): string {
  return value ? `\u2068${value}\u2069` : '';
}

export function tStatic(key: MessageKey, values?: MessageValues): string {
  return activeT(key, values);
}

interface I18nValue {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: Translate;
  /**
   * Switch the UI language in this browser. remember=true keeps it for the next visit (cookie read by the
   * server for the first paint); false forgets it so Accept-Language decides. Saving to the account is the
   * caller's job.
   */
  setLocale: (l: Locale, remember?: boolean) => void;
}

const I18nContext = createContext<I18nValue>({ locale: DEFAULT_LOCALE, dir: 'ltr', t: makeT(DEFAULT_LOCALE), setLocale: () => undefined });

export function I18nProvider({ initialLocale, catalog, children }: { initialLocale: Locale; catalog?: Catalog; children: ReactNode }) {
  // The server hands over the active non-English catalog for the first paint (no flash, no extra request).
  if (catalog) registerCatalog(initialLocale, catalog);
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  // Module state follows the provider during render so tStatic() matches what is on screen.
  if (active !== locale) {
    active = locale;
    activeT = makeT(locale);
  }
  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = LOCALE_META[locale].dir;
  }, [locale]);
  const setLocale = useCallback((l: Locale, remember = true) => {
    // Switch once the catalog chunk is in, so the UI never renders half-translated.
    if (hasCatalog(l)) setLocaleState(l);
    else void loadCatalog(l).then(() => setLocaleState(l));
    document.cookie = remember ? `${LOCALE_COOKIE}=${l}; Path=/; Max-Age=31536000; SameSite=Lax` : `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }, []);
  const value = useMemo<I18nValue>(() => ({ locale, dir: LOCALE_META[locale].dir, t: makeT(locale), setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  return useContext(I18nContext).t;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
