import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { LOCALE_META } from '@/i18n/locales';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';
import { initialCatalog, requestLocale, serverT } from '@/i18n/server';
import { SkipToContent } from './skip-link';
import './globals.css';
import { Providers } from './providers';

const brand = process.env.NEXT_PUBLIC_BRAND_NAME || 'Talkivio';

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return {
    title: { default: brand, template: `%s · ${brand}` },
    description: t('pages.title.description', { brand }),
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#07778A',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await requestLocale();
  return (
    <html lang={locale} dir={LOCALE_META[locale].dir} suppressHydrationWarning>
      <head>
        {/* Light or dark before the first paint, so a dark page never flashes white. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <Providers locale={locale} catalog={initialCatalog(locale)}>
          <SkipToContent />
          {children}
        </Providers>
      </body>
    </html>
  );
}
