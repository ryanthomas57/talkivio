'use client';
import { ShieldOff } from 'lucide-react';
import { useParams } from 'next/navigation';
import { EmptyState, Page } from '@/components/ui';
import { VisitorProfilePage } from '@/components/visitors/visitor-profile';
import { useCan } from '@/stores/session';
import { useT } from '@/i18n';

export default function VisitorProfileRoute() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const canView = useCan('visitors.view');
  if (!canView)
    return (
      <Page>
        <EmptyState icon={<ShieldOff />} title={t('pages.noAccess.visitorRecords')} description={t('pages.noAccess.visitorRecordsBody')} />
      </Page>
    );
  return <VisitorProfilePage key={id} id={id} />;
}
