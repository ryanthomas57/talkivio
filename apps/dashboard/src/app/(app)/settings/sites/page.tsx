'use client';
import { ShieldOff } from 'lucide-react';
import { SitesList } from '@/components/sites/sites-list';
import { EmptyState, Page } from '@/components/ui';
import { useCan } from '@/stores/session';
import { useT } from '@/i18n';

export default function SitesRoute() {
  const t = useT();
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
  return <SitesList />;
}
