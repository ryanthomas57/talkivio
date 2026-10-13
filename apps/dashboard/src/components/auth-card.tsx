'use client';
import type { ReactNode } from 'react';
import { LOCALE_META, LOCALES, useI18n } from '@/i18n';
import { cn } from '@/lib/cn';

/** Login-style card: max width 420 px with 24 px padding (ch. 07), with a language switch for signed-out pages. */
export function AuthCard({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <section className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
        <header className="mb-6 flex flex-col gap-1.5">
          <h1 className="text-lg font-semibold leading-7">{title}</h1>
          {description && <p className="text-sm text-fg-2">{description}</p>}
        </header>
        {children}
      </section>
      {footer && <div className="mt-6 text-center text-sm text-fg-2">{footer}</div>}
      <LanguageSwitch />
    </>
  );
}

/** Signed out, the choice lives in this browser only (cookie); signed in, the account menu saves it. */
function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <nav aria-label={t('auth.language.switch')} className="mt-4 flex justify-center gap-1 text-sm">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          dir={LOCALE_META[l].dir}
          aria-current={l === locale ? 'true' : undefined}
          onClick={() => setLocale(l)}
          className={cn('min-h-11 rounded-md px-3 font-medium', l === locale ? 'text-fg' : 'text-primary hover:underline')}
        >
          {LOCALE_META[l].label}
        </button>
      ))}
    </nav>
  );
}
