'use client';
import { ShieldOff } from 'lucide-react';
import { Suspense } from 'react';
import { HistoryPage } from '@/components/history/history-page';
import { EmptyState, Page, Skeleton } from '@/components/ui';
import { useCan } from '@/stores/session';
import { useT } from '@/i18n';

export default function HistoryRoute() {
  const t = useT();
  const canView = useCan('history.view');
  if (!canView)
    return (
      <Page>
        <EmptyState icon={<ShieldOff />} title={t('pages.noAccess.history')} description={t('pages.noAccess.historySearchBody')} />
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
      <HistoryPage />
    </Suspense>
  );
}
