'use client';
import * as D from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Menu as MenuIcon } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Banner, Button, Dialog, DialogContent } from '@/components/ui';
import { useMediaQuery } from '@/hooks/use-media';
import { ACCESS_REVOKED_EVENT, api, errorMessage, SESSION_EXPIRED_EVENT } from '@/lib/api';
import { realtime } from '@/lib/realtime';
import { toast } from 'sonner';
import { isolate, tStatic, useT } from '@/i18n';
import { useSession } from '@/stores/session';
import { AccountMenu } from './account-menu';
import { ConnectionBanner } from './connection-banner';
import { useInboxBadge, useTitleBadge } from './inbox-badge';
import { useAccountLocaleSync } from './language';
import { NAV_ITEMS } from './nav';
import { Sidebar } from './sidebar';
import { TopbarSlots } from './topbar-slots';
import { StatusMenu } from './status-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { PastDueBanner } from '@/components/billing/billing-gate';

/**
 * Responsive application shell (ch. 06). Desktop ≥ 1024 px: 224 px sidebar and
 * 64 px topbar. Compact 640–1023 px: 64 px icon rail. Mobile < 640 px: modal
 * navigation drawer with a 56 px topbar.
 */
export function AppShell({
  children,
  slots,
}: {
  children: ReactNode;
  slots?: { skip?: ReactNode; topbar?: ReactNode; global?: ReactNode };
}) {
  const t = useT();
  useAccountLocaleSync();
  const desktop = useMediaQuery('(min-width: 1024px)', true);
  const compact = useMediaQuery('(min-width: 640px)', true);
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  const badge = useInboxBadge();
  useTitleBadge(badge);
  const [titleSlot, setTitleSlot] = useState<HTMLDivElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const topbar = useMemo(
    () => ({ title: titleSlot, actions: actionsSlot, claim }),
    [titleSlot, actionsSlot, claim],
  );
  // Pages without their own header (Inbox, detail pages) show the section they belong to.
  const section = NAV_ITEMS.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`));
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <TopbarSlots.Provider value={topbar}>
      <div className="flex h-dvh overflow-hidden bg-canvas">
        {slots?.skip}
        {compact && <Sidebar variant={desktop ? 'full' : 'rail'} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:h-16 sm:px-4 lg:px-6">
            {!compact && (
              <D.Root open={drawer} onOpenChange={setDrawer}>
                <D.Trigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t('shell.drawer.open')}>
                    <MenuIcon className="size-5" />
                  </Button>
                </D.Trigger>
                <D.Portal>
                  <D.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
                  <D.Content className="fixed inset-y-0 start-0 z-50 shadow-[var(--shadow-dialog)] data-[state=open]:animate-slide-in-left rtl:data-[state=open]:animate-slide-in-right">
                    <D.Title className="sr-only">{t('shell.drawer.title')}</D.Title>
                    <D.Description className="sr-only">{t('shell.drawer.description')}</D.Description>
                    <Sidebar variant="drawer" onNavigate={() => setDrawer(false)} />
                  </D.Content>
                </D.Portal>
              </D.Root>
            )}
            {/* Each page puts its title (and its actions) here through <PageHeader>, leaving the page to its content. */}
            <div className="flex min-w-0 flex-1 items-center">
              <div ref={setTitleSlot} className="contents" />
              {claims === 0 && section && (
                <span className="min-w-0 truncate rounded-md bg-primary px-3 py-1 text-base font-semibold leading-6 text-primary-fg">
                  {t(section.label)}
                </span>
              )}
            </div>
            <div ref={setActionsSlot} className="hidden min-w-0 items-center gap-2 md:flex" />
            {slots?.topbar}
            <ThemeToggle />
            <StatusMenu />
            <AccountMenu />
          </header>
          <ConnectionBanner />
          <PastDueBanner />
          <VerificationNotice />
          <main id="main" className="min-h-0 min-w-0 flex-1 overflow-y-auto scroll-thin" tabIndex={-1}>
            {children}
          </main>
        </div>
        {slots?.global}
        <SessionGuards />
      </div>
    </TopbarSlots.Provider>
  );
}

/** Unverified owners see why inviting is blocked, with a resend action (ch. 07). */
function VerificationNotice() {
  const t = useT();
  const me = useSession((s) => s.me);
  const [sent, setSent] = useState<'idle' | 'sending' | 'sent' | string>('idle');
  if (!me || me.user.emailVerified) return null;
  const resend = async () => {
    setSent('sending');
    try {
      await api.post('/auth/verify-email/resend');
      setSent('sent');
    } catch (e) {
      setSent(errorMessage(e));
    }
  };
  return (
    <div className="border-b border-line bg-surface px-4 py-2 lg:px-6">
      <Banner
        tone="info"
        className="border-0 bg-transparent px-0 py-0"
        action={
          sent === 'sent' ? (
            <span className="text-sm font-medium text-success">{t('shell.verify.sent')}</span>
          ) : (
            <Button size="sm" variant="secondary" onClick={resend} loading={sent === 'sending'}>
              {t('shell.verify.resend')}
            </Button>
          )
        }
      >
        {t('shell.verify.notice', { email: isolate(me.user.email) })}
        {sent !== 'idle' && sent !== 'sending' && sent !== 'sent' ? ` ${sent}` : ''}
      </Banner>
    </div>
  );
}

/**
 * Session expiry and access revocation: prompt to sign in again without sending
 * anything automatically; drafts stay in this browser (ch. 06).
 */
function SessionGuards() {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  const reset = useSession((s) => s.reset);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const onExpired = () => {
      realtime.stop();
      setExpired(true);
    };
    const onRevoked = (e: Event) => {
      const detail = (e as CustomEvent<{ reason?: string; reloginRequired?: boolean }>).detail ?? {};
      if (detail.reason === 'tenant_switch') return;
      if (detail.reloginRequired === false) {
        // Permissions or department scope changed; the realtime client reconnects by itself.
        void useSession
          .getState()
          .refreshAgent()
          .then(() => {
            void qc.invalidateQueries();
            toast.info(tStatic('shell.session.accessUpdated'));
          })
          .catch(() => undefined);
        return;
      }
      realtime.stop();
      qc.clear();
      reset();
      router.replace(`/login?reason=revoked`);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    window.addEventListener(ACCESS_REVOKED_EVENT, onRevoked);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      window.removeEventListener(ACCESS_REVOKED_EVENT, onRevoked);
    };
  }, [qc, reset, router]);

  const relogin = () => {
    qc.clear();
    reset();
    const next = `${window.location.pathname}${window.location.search}`;
    router.replace(`/login?reason=expired&next=${encodeURIComponent(next)}`);
  };

  return (
    <Dialog open={expired} onOpenChange={() => undefined}>
      <DialogContent
        size="sm"
        hideClose
        onEscapeKeyDown={(e) => e.preventDefault()}
        title={t('shell.session.endedTitle')}
        description={t('shell.session.endedBody')}
        footer={
          <Button variant="primary" onClick={relogin}>
            {t('shell.session.signInAgain')}
          </Button>
        }
      />
    </Dialog>
  );
}
