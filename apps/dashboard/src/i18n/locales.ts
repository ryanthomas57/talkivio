/** Dashboard locales (ch. 29: English default, Arabic initial; the design supports more). */
export const LOCALES = ['en', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'rd_locale';

export const LOCALE_META: Record<Locale, { dir: 'ltr' | 'rtl'; label: string; intl: string }> = {
  en: { dir: 'ltr', label: 'English', intl: 'en' },
  ar: { dir: 'rtl', label: 'العربية', intl: 'ar' },
};

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/** Best supported match for a list of BCP 47 tags (navigator.languages or Accept-Language), else English. */
export function negotiateLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const base = tag.trim().toLowerCase().split(/[-_;]/)[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

/** Parse an Accept-Language header into tags ordered by q. */
export function acceptLanguageTags(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = Number(params.find((p) => p.trim().startsWith('q='))?.trim().slice(2) ?? 1);
      return { tag: tag!.trim(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((x) => x.tag);
}
