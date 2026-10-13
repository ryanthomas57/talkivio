'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BRAND_NAME, BrandLockup } from '@/components/brand';
import { CountBadge, Tooltip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { hasAny } from '@/lib/permissions';
import { useI18n } from '@/i18n';
import { useSession } from '@/stores/session';
import { useInboxBadge } from './inbox-badge';
import { NAV_ITEMS } from './nav';

/**
 * Primary navigation. Desktop: 224 px with labels. Compact (640–1023 px): 64 px
 * icon rail with accessible labels and tooltips. Mobile uses the drawer variant.
 */
export function Sidebar({ variant, onNavigate }: { variant: 'full' | 'rail' | 'drawer'; onNavigate?: () => void }) {
  const { t, dir } = useI18n();
  const pathname = usePathname();
  const perms = useSession((s) => s.permissions);
  const badge = useInboxBadge();
  const items = NAV_ITEMS.filter((i) => hasAny(perms, i.any));
  const rail = variant === 'rail';

  return (
    <nav aria-label={t('shell.nav.primary')} className={cn('flex h-full flex-col bg-nav', variant !== 'drawer' && 'border-e border-line', rail ? 'w-16' : 'w-56')}>
      <div className={cn('flex h-16 shrink-0 items-center', rail ? 'justify-center' : 'px-5')}>
        <Link href="/inbox" onClick={onNavigate} aria-label={t('shell.nav.home', { brand: BRAND_NAME })} className="rounded-md">
          <BrandLockup compact={rail} />
        </Link>
      </div>
      <ul className={cn('flex flex-1 flex-col gap-0.5 overflow-y-auto pb-4 scroll-thin', rail ? 'px-2' : 'px-3')}>
        {items.map((item) => {
          const label = t(item.label);
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const count = item.badge === 'inbox' ? badge : 0;
          const link = (
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              aria-label={rail ? (count ? t('shell.nav.withWaiting', { label, count }) : label) : undefined}
              className={cn(
                'relative flex h-11 items-center gap-3 rounded-[var(--radius-control)] text-sm font-medium transition-colors',
                rail ? 'justify-center' : 'px-3',
                active ? 'bg-nav-active text-nav-active-fg' : 'text-fg-2 hover:bg-surface-3 hover:text-fg',
              )}
            >
              {active && <span aria-hidden className="absolute inset-y-2.5 start-0 w-[3px] rounded-full [background:var(--brand-gradient)]" />}
              <item.icon className="size-[18px] shrink-0" aria-hidden />
              {!rail && <span className="flex-1 truncate">{label}</span>}
              {!rail && <CountBadge count={count} label={t('shell.nav.waitingOrUnread')} />}
              {rail && count > 0 && <span className="absolute end-2 top-2 size-2 rounded-full bg-danger" aria-hidden />}
            </Link>
          );
          return (
            <li key={item.href}>
              {rail ? (
                <Tooltip content={label} side={dir === 'rtl' ? 'left' : 'right'}>
                  {link}
                </Tooltip>
              ) : (
                link
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
