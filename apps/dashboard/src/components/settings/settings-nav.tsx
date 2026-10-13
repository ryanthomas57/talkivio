'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useSession } from '@/stores/session';
import { isActiveSection, visibleSections } from './nav';

/**
 * Settings secondary navigation: a vertical list on ≥ 1024 px and horizontally
 * scrollable tabs below. Entries are filtered by permission; the active entry
 * carries aria-current="page".
 */
export function SettingsNav() {
  const t = useT();
  const pathname = usePathname();
  const perms = useSession((s) => s.permissions);
  const sections = useMemo(() => visibleSections(perms), [perms]);
  const stripRef = useRef<HTMLUListElement>(null);

  // Keep the active tab visible in the horizontal strip.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);

  return (
    <>
      <nav aria-label={t('settings.nav.label')} className="hidden w-60 shrink-0 lg:block">
        <div className="sticky top-0 flex flex-col gap-1 px-3 py-6">
          <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-fg-2">{t('settings.nav.label')}</p>
          <ul className="flex flex-col gap-0.5">
            {sections.map((s) => {
              const active = isActiveSection(pathname, s.href);
              return (
                <li key={s.href}>
                  <Link
                    href={s.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-10 items-center gap-3 rounded-[var(--radius-control)] px-3 text-sm font-medium transition-colors',
                      active ? 'bg-nav-active text-nav-active-fg' : 'text-fg-2 hover:bg-surface-3 hover:text-fg',
                    )}
                  >
                    <s.icon className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">{t(s.label)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>
      <nav aria-label={t('settings.nav.label')} className="border-b border-line bg-surface lg:hidden">
        <ul ref={stripRef} className="relative flex gap-1 overflow-x-auto px-2 scroll-thin sm:px-4">
          {sections.map((s) => {
            const active = isActiveSection(pathname, s.href);
            return (
              <li key={s.href} className="shrink-0">
                <Link
                  href={s.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    '-mb-px inline-flex h-11 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors',
                    active ? 'border-primary text-fg' : 'border-transparent text-fg-2 hover:text-fg',
                  )}
                >
                  <s.icon className="size-4 shrink-0" aria-hidden />
                  {t(s.label)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
