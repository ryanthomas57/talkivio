'use client';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Globe } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Page,
  PageHeader,
  PanelError,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { Site } from '@/lib/types';
import { InstallStatus, installStateOf } from './install-status';
import { SiteGeneral, siteKey } from './site-general';
import { SiteInstallation } from './site-installation';
import { SiteSecurity } from './site-security';
import { WidgetEditor } from './widget-editor';

const TABS: ReadonlyArray<{ id: 'general' | 'widget' | 'installation' | 'security'; label: MessageKey }> = [
  { id: 'general', label: 'sites.detail.tabs.general' },
  { id: 'widget', label: 'sites.detail.tabs.widget' },
  { id: 'installation', label: 'sites.detail.tabs.installation' },
  { id: 'security', label: 'sites.detail.tabs.security' },
];
type TabId = (typeof TABS)[number]['id'];

/**
 * Site detail with URL-addressable tabs. Visited tabs stay mounted (hidden) so
 * unsaved edits survive switching tabs; one dirty guard covers leaving the page
 * and offers to save every tab with pending edits.
 */
export function SiteDetail({ id }: { id: string }) {
  const t = useT();
  const pathname = usePathname();
  const params = useSearchParams();
  const raw = params.get('tab');
  const tab: TabId = TABS.some((x) => x.id === raw) ? (raw as TabId) : 'general';
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));

  const q = useQuery({ queryKey: siteKey(id), queryFn: () => api.get<Site>(`/sites/${id}`) });
  const site = q.data;

  const [dirtyTabs, setDirtyTabs] = useState<Partial<Record<TabId, boolean>>>({});
  const savers = useRef<Partial<Record<TabId, () => Promise<boolean>>>>({});
  const reporters = useMemo(() => {
    const make = (id: TabId) => (dirty: boolean, save: () => Promise<boolean>) => {
      savers.current[id] = save;
      setDirtyTabs((d) => (!!d[id] === dirty ? d : { ...d, [id]: dirty }));
    };
    return { general: make('general'), widget: make('widget') };
  }, []);
  const anyDirty = Object.values(dirtyTabs).some(Boolean);
  const guard = useDirtyGuard(anyDirty, {
    what: site ? isolate(site.name) : undefined,
    onSave: async () => {
      for (const id of Object.keys(dirtyTabs) as TabId[]) {
        if (!dirtyTabs[id]) continue;
        const ok = await savers.current[id]?.();
        if (ok === false) return false;
      }
      return true;
    },
  });

  const setTab = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params.toString());
      if (id === 'general') next.delete('tab');
      else next.set('tab', id);
      const s = next.toString();
      // Shallow URL update: Next syncs history.replaceState with useSearchParams, so
      // filters, tabs and the selected row change instantly without a server round-trip.
      window.history.replaceState(null, '', s ? `${pathname}?${s}` : pathname);
    },
    [params, pathname],
  );

  if (q.isLoading)
    return (
      <Page>
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-96 w-full" />
      </Page>
    );
  if (q.isError || !site)
    return (
      <Page>
        <BackLink />
        {isApiError(q.error, 'NOT_FOUND') ? (
          <EmptyState
            icon={<Globe />}
            title={t('sites.detail.notFoundTitle')}
            description={t('sites.detail.notFoundBody')}
            action={
              <Button asChild>
                <Link href="/settings/sites">{t('sites.detail.allWebsites')}</Link>
              </Button>
            }
          />
        ) : (
          <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        )}
      </Page>
    );

  return (
    <Page>
      <BackLink />
      <PageHeader
        className="-mt-3"
        title={
          <span className="flex flex-wrap items-center gap-2">
            <bdi>{site.name}</bdi>
            {site.archivedAt ? (
              <Badge tone="danger">{t('sites.detail.archived')}</Badge>
            ) : !site.enabled ? (
              <Badge tone="warning">{t('sites.detail.widgetDisabled')}</Badge>
            ) : null}
          </span>
        }
        description={t('sites.detail.meta', { date: formatDate(site.createdAt), count: site.origins.length, revision: site.configRevision })}
        actions={<InstallStatus state={installStateOf(site)} lastVerifiedAt={site.lastVerifiedAt} compact />}
      />
      {site.archivedAt && (
        <Banner tone="warning">
          {t('sites.detail.archivedBanner', { date: formatDate(site.archivedAt) })}
        </Banner>
      )}
      <Tabs value={tab} onValueChange={setTab} className="flex flex-col gap-6">
        <TabsList aria-label={t('sites.detail.tabsLabel')}>
          {TABS.map((x) => (
            <TabsTrigger key={x.id} value={x.id}>
              {t(x.label)}
              {dirtyTabs[x.id] && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-warning">
                  <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                  <span className="sr-only">{t('sites.detail.unsavedSr')}</span>
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {visited.has('general') && (
          <TabsContent value="general" forceMount className="data-[state=inactive]:hidden">
            <SiteGeneral site={site} onDirtyChange={reporters.general} />
          </TabsContent>
        )}
        {visited.has('widget') && (
          <TabsContent value="widget" forceMount className="data-[state=inactive]:hidden">
            <WidgetEditor site={site} onDirtyChange={reporters.widget} />
          </TabsContent>
        )}
        {visited.has('installation') && (
          <TabsContent value="installation" forceMount className="data-[state=inactive]:hidden">
            <SiteInstallation site={site} active={tab === 'installation'} />
          </TabsContent>
        )}
        {visited.has('security') && (
          <TabsContent value="security" forceMount className="data-[state=inactive]:hidden">
            <SiteSecurity site={site} />
          </TabsContent>
        )}
      </Tabs>
      {guard}
    </Page>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link
      href="/settings/sites"
      className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-fg-2 hover:text-fg"
    >
      <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
      {t('sites.list.title')}
    </Link>
  );
}
