'use client';
import { ShieldOff } from 'lucide-react';
import { Suspense } from 'react';
import { EmptyState, Page, Skeleton } from '@/components/ui';
import { VisitorsPage } from '@/components/visitors/visitors-page';
import { useCan } from '@/stores/session';
import { useT } from '@/i18n';

export default function VisitorsRoute() {
  const t = useT();
  const canView = useCan('visitors.view');
  if (!canView)
    return (
      <Page>
        <EmptyState icon={<ShieldOff />} title={t('pages.noAccess.visitors')} description={t('pages.noAccess.visitorsBody')} />
      </Page>
    );
  return (
    <Suspense
      fallback={
        <Page>
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-[480px] w-full" />
        </Page>
      }
    >
      <VisitorsPage />
    </Suspense>
  );
}
