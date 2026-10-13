'use client';
import { ShieldOff } from 'lucide-react';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { HistoryDetail } from '@/components/history/history-detail';
import { EmptyState, Page, Skeleton } from '@/components/ui';
import { useCan } from '@/stores/session';
import { useT } from '@/i18n';

export default function HistoryDetailRoute() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const canView = useCan('history.view');
  if (!canView)
    return (
      <Page>
        <EmptyState icon={<ShieldOff />} title={t('pages.noAccess.history')} description={t('pages.noAccess.historyReadBody')} />
      </Page>
    );
  return (
    <Suspense
      fallback={
        <Page>
          <Skeleton className="h-10 w-72" />
        </Page>
      }
    >
      <HistoryDetail key={id} id={id} />
    </Suspense>
  );
}
