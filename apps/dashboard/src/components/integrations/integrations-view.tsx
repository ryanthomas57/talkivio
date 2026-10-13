'use client';
import { ShieldOff } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { BRAND_NAME } from '@/components/brand';
import { EmptyState, Page, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useT } from '@/i18n';
import { useCan } from '@/stores/session';
import { ConnectorsPanel } from './connectors-panel';
import { TokensPanel } from './tokens-panel';
import { WebhooksPanel } from './webhooks-panel';

const TABS = ['tokens', 'webhooks', 'connectors'] as const;
type Tab = (typeof TABS)[number];

/** Settings → Integrations (ch. 55/56). The active tab and list options live in the URL. */
export function IntegrationsView() {
  const t = useT();
  const canManage = useCan('integrations.manage');
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = sp.get('tab');
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'tokens';
  const showRevoked = sp.get('revoked') === '1';

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    router.replace(next.toString() ? `${pathname}?${next}` : pathname, { scroll: false });
  };

  if (!canManage) {
    return (
      <Page>
        <EmptyState icon={<ShieldOff />} title={t('integrations.view.noAccessTitle')} description={t('integrations.view.noAccessBody')} />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader title={t('integrations.view.title')} description={t('integrations.view.description', { brand: BRAND_NAME })} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v === 'tokens' ? null : v, revoked: v === 'tokens' ? sp.get('revoked') : null })}>
        <TabsList aria-label={t('integrations.view.tabsLabel')}>
          <TabsTrigger value="tokens">{t('integrations.view.tabTokens')}</TabsTrigger>
          <TabsTrigger value="webhooks">{t('integrations.view.tabWebhooks')}</TabsTrigger>
          <TabsTrigger value="connectors">{t('integrations.view.tabConnectors')}</TabsTrigger>
        </TabsList>
        <TabsContent value="tokens" className="pt-6">
          <TokensPanel showRevoked={showRevoked} onShowRevoked={(v) => setParams({ revoked: v ? '1' : null })} />
        </TabsContent>
        <TabsContent value="webhooks" className="pt-6">
          <WebhooksPanel />
        </TabsContent>
        <TabsContent value="connectors" className="pt-6">
          <ConnectorsPanel />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
