'use client';
import { ShieldOff } from 'lucide-react';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { SiteDetail } from '@/components/sites/site-detail';
import { EmptyState, Page, Skeleton } from '@/components/ui';
import { useCan } from '@/stores/session';
import { useT } from '@/i18n';

export default function SiteDetailRoute() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const canView = useCan('sites.view');
  if (!canView)
    return (
      <Page>
        <EmptyState
          icon={<ShieldOff />}
          title={t('pages.noAccess.sites')}
          description={t('pages.noAccess.sitesBody')}
        />
      </Page>
    );
  return (
    <Suspense
      fallback={
        <Page>
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-96 w-full" />
        </Page>
      }
    >
      <SiteDetail key={id} id={id} />
    </Suspense>
  );
}
