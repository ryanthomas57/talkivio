'use client';
import { DirectionProvider } from '@radix-ui/react-direction';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { isApiError } from '@/lib/api';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeSync } from '@/components/theme';
import { I18nProvider, useI18n, type Locale } from '@/i18n';
import type { Catalog } from '@/i18n/translate';

export function Providers({ children, locale, catalog }: { children: ReactNode; locale: Locale; catalog?: Catalog }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            retry: (count, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && count < 2,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <I18nProvider initialLocale={locale} catalog={catalog}>
      <RadixDirection>
        <QueryClientProvider client={client}>
          <TooltipProvider>
            <ThemeSync />
            {children}
            <LocalizedToaster />
          </TooltipProvider>
        </QueryClientProvider>
      </RadixDirection>
    </I18nProvider>
  );
}

/** Toasts sit at the end of the reading direction and use localized close labels. */
function LocalizedToaster() {
  const { dir, t } = useI18n();
  return <Toaster dir={dir} position={dir === 'rtl' ? 'bottom-left' : 'bottom-right'} closeButton richColors={false} containerAriaLabel={t('common.notificationsRegion')} toastOptions={{ className: 'rd-toast', closeButtonAriaLabel: t('common.closeNotification') }} />;
}

/** Radix menus, selects and tooltips follow the UI direction (submenu side, arrow-key order). */
function RadixDirection({ children }: { children: ReactNode }) {
  const { dir } = useI18n();
  return <DirectionProvider dir={dir}>{children}</DirectionProvider>;
}
