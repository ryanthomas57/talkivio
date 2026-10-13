/** Locale, catalog and translator for server components (layout <html lang dir>, generateMetadata). */
import { cookies, headers } from 'next/headers';
import { acceptLanguageTags, isLocale, LOCALE_COOKIE, negotiateLocale, type Locale } from './locales';
import { ar } from './messages/ar';
import { makeT, registerCatalog, type Catalog, type Translate } from './translate';

registerCatalog('ar', ar);

/** Last explicit choice in this browser (cookie), else Accept-Language, else English. */
export async function requestLocale(): Promise<Locale> {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(chosen)) return chosen;
  return negotiateLocale(acceptLanguageTags((await headers()).get('accept-language')));
}

/** The non-English catalog the client needs for its first paint (English is in the client bundle). */
export function initialCatalog(locale: Locale): Catalog | undefined {
  return locale === 'ar' ? ar : undefined;
}

export async function serverT(): Promise<Translate> {
  return makeT(await requestLocale());
}
