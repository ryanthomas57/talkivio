'use client';
import { PauseCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { BrandLockup } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button, Card, CardBody } from '@/components/ui';
import { useT, type MessageKey } from '@/i18n';
import type { BillingState } from '@/lib/billing';
import { useSession } from '@/stores/session';

const TITLE: Partial<Record<BillingState, MessageKey>> = {
  incomplete: 'billing.paused.title.incomplete',
  suspended: 'billing.paused.title.suspended',
  ended: 'billing.paused.title.ended',
};

/** What agents see while billing blocks the workspace: only the owner can fix it. */
export function PausedScreen({ state }: { state: BillingState }) {
  const t = useT();
  const router = useRouter();
  const logout = useSession((s) => s.logout);
  const workspaces = useSession((s) => s.me?.memberships.length ?? 0);
  return (
    <main
      id="main"
      className="relative flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10"
    >
      <ThemeToggle className="absolute end-4 top-4 bg-surface" />
      <BrandLockup className="mb-8" />
      <Card className="w-full max-w-[460px]">
        <CardBody className="flex flex-col items-center gap-3 text-center">
          <PauseCircle className="size-10 text-primary" aria-hidden />
          <h1 className="text-lg font-semibold text-fg">
            {t(TITLE[state] ?? 'billing.paused.title.suspended')}
          </h1>
          <p className="text-sm text-fg-2">{t('billing.paused.body')}</p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {workspaces > 1 && (
              <Button variant="secondary" onClick={() => router.push('/workspaces')}>
                {t('billing.paused.switch')}
              </Button>
            )}
            <Button variant="ghost" onClick={() => void logout().then(() => router.replace('/login'))}>
              {t('billing.setup.signOut')}
            </Button>
          </div>
        </CardBody>
      </Card>
    </main>
  );
}
