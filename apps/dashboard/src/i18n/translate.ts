/**
 * Catalog lookup shared by the client provider and server components (no React, no browser APIs).
 * English is always bundled (source of truth and fallback). Other catalogs are registered when needed:
 * the server passes the active one to the provider for the first paint, and a language switch in the
 * browser loads its chunk on demand (dashboard initial-route budget, ch. 60).
 */
import { formatMessage, type MessageValues } from './format-message';
import { LOCALE_META, type Locale } from './locales';
import { en, type MessageKey } from './messages/en';

export type Catalog = Record<MessageKey, string>;
const CATALOGS: Partial<Record<Locale, Catalog>> = { en };

export type Translate = (key: MessageKey, values?: MessageValues) => string;

export function registerCatalog(locale: Locale, catalog: Catalog): void {
  CATALOGS[locale] ??= catalog;
}

export function hasCatalog(locale: Locale): boolean {
  return !!CATALOGS[locale];
}

/** The catalog chunk for a locale (client: a separate lazily loaded chunk). */
export async function loadCatalog(locale: Locale): Promise<Catalog> {
  const loaded = CATALOGS[locale];
  if (loaded) return loaded;
  const catalog = locale === 'ar' ? (await import('./messages/ar')).ar : en;
  registerCatalog(locale, catalog);
  return catalog;
}

export function makeT(locale: Locale): Translate {
  const catalog = CATALOGS[locale] ?? en;
  return (key, values) => formatMessage(catalog[key] ?? en[key] ?? key, values, LOCALE_META[locale].intl);
}
