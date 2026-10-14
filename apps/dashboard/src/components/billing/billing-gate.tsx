'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { ShellSkeleton } from '@/components/shell/session-gate';
import { Banner } from '@/components/ui';
import { useT } from '@/i18n';
import { BLOCKED_STATES, useBillingStatus } from '@/lib/billing';
import { useSession } from '@/stores/session';
import { PausedScreen } from './paused-screen';

/**
 * Keeps a workspace that billing blocks (no card yet, paused for an unpaid balance, or ended) out of the dashboard:
 * the owner goes to the payment step, everyone else sees why the workspace is unavailable. The API enforces the same
 * rule (402); this only avoids a screen full of errors.
 */
export function BillingGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const status = useBillingStatus();
  const isOwner = useSession((s) => s.permissions.has('billing.manage'));
  const state = status.data?.enabled ? status.data.state : null;
  const blocked = !!state && BLOCKED_STATES.has(state);

  useEffect(() => {
    if (blocked && isOwner) router.replace('/billing/setup');
  }, [blocked, isOwner, router]);

  if (status.isLoading) return <ShellSkeleton />;
  if (blocked) return isOwner ? <ShellSkeleton /> : <PausedScreen state={state!} />;
  return <>{children}</>;
}

/** For the owner while a renewal charge is failing: the workspace still works, but not for long. */
export function PastDueBanner() {
  const t = useT();
  const status = useBillingStatus();
  const isOwner = useSession((s) => s.permissions.has('billing.manage'));
  if (!isOwner || status.data?.state !== 'past_due') return null;
  return (
    <Banner tone="warning" className="rounded-none border-x-0 border-t-0">
      {t('billing.banner.pastDue')}{' '}
      <Link href="/settings/billing" className="font-medium underline underline-offset-2">
        {t('billing.banner.action')}
      </Link>
    </Banner>
  );
}
