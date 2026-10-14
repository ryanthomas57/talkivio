'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { BrandMark } from '@/components/brand';
import { Button, PanelError, Skeleton } from '@/components/ui';
import { realtime } from '@/lib/realtime';
import { useT } from '@/i18n';
import { useSession } from '@/stores/session';

/**
 * Loads the signed-in session once, redirects anonymous visitors to sign in
 * (keeping the destination), and opens the realtime connection for the tenant.
 */
export function SessionGate({
  children,
  requireTenant = true,
}: {
  children: ReactNode;
  requireTenant?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const status = useSession((s) => s.status);
  const tenantId = useSession((s) => s.tenant?.id);
  const load = useSession((s) => s.load);
  const error = useSession((s) => s.error);

  useEffect(() => {
    if (status === 'loading') void load();
  }, [status, load]);

  useEffect(() => {
    if (status === 'anonymous') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (status === 'no-tenant' && requireTenant) router.replace('/workspaces');
  }, [status, pathname, router, requireTenant]);

  useEffect(() => {
    if (status !== 'ready' || !tenantId) return;
    realtime.start();
  }, [status, tenantId]);

  if (status === 'error')
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="w-full max-w-md">
          <PanelError message={error ?? t('shell.gate.loadError')} onRetry={() => void load()} />
          <div className="mt-2 text-center">
            <Button variant="link" onClick={() => router.replace('/login')}>
              {t('shell.gate.goToSignIn')}
            </Button>
          </div>
        </div>
      </div>
    );

  if (status !== 'ready' && !(status === 'no-tenant' && !requireTenant)) return <ShellSkeleton />;
  return <>{children}</>;
}

/** Initial load skeleton shaped like the final layout (ch. 06). */
export function ShellSkeleton() {
  const t = useT();
  return (
    <div className="flex h-dvh bg-canvas" aria-busy="true" aria-label={t('shell.gate.loading')}>
      <div className="hidden w-56 flex-col gap-2 border-e border-line bg-nav p-3 sm:flex">
        <div className="flex h-12 items-center px-2">
          <BrandMark />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
      <div className="flex flex-1 flex-col">
        <div className="flex h-16 items-center justify-end gap-3 border-b border-line bg-surface px-6">
          <Skeleton className="h-10 w-28" />
          <Skeleton className="size-9 rounded-full" />
        </div>
        <div className="flex flex-col gap-4 p-6">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
