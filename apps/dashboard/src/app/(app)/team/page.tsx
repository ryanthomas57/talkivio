'use client';
import { Suspense } from 'react';
import { ShieldOff } from 'lucide-react';
import { EmptyState, Page, Skeleton } from '@/components/ui';
import { TeamPage } from '@/components/team/team-page';
import { useCan } from '@/stores/session';
import { useT } from '@/i18n';

export default function TeamRoute() {
  const t = useT();
  const canView = useCan('agents.view');
  if (!canView)
    return (
      <Page>
        <EmptyState
          icon={<ShieldOff />}
          title={t('pages.noAccess.team')}
          description={t('pages.noAccess.teamBody')}
        />
      </Page>
    );
  return (
    <Suspense
      fallback={
        <Page>
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-96 w-full" />
        </Page>
      }
    >
      <TeamPage />
    </Suspense>
  );
}
