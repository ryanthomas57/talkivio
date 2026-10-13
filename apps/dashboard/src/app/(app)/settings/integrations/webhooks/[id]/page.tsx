'use client';
import { ShieldOff } from 'lucide-react';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { WebhookDetail } from '@/components/integrations/webhook-detail';
import { EmptyState, Page } from '@/components/ui';
import { useCan } from '@/stores/session';
import { useT } from '@/i18n';

export default function WebhookEndpointPage() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const canManage = useCan('integrations.manage');
  if (!canManage)
    return (
      <Page>
        <EmptyState icon={<ShieldOff />} title={t('pages.noAccess.integrations')} description={t('pages.noAccess.integrationsBody')} />
      </Page>
    );
  return (
    <Suspense>
      <WebhookDetail key={id} id={id} />
    </Suspense>
  );
}
