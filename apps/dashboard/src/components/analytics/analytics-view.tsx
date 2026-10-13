'use client';
import { BarChart3 } from 'lucide-react';
import { Card, CardBody, EmptyState, Page, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { useT } from '@/i18n';
import { useCan } from '@/stores/session';
import { AgentsReportView } from './agents-report';
import { ChatsReportView } from './chats-report';
import { ExportControl } from './export-control';
import { FiltersBar } from './filters-bar';
import { InvitationsReportView } from './invitations-report';
import { rangeLabel } from './range';
import { chatsQuery, useAnalyticsParams, type AnalyticsTab } from './use-analytics-params';

/** Analytics (ch. 51): chats report, agent activity and invitation funnel with CSV export. */
export function AnalyticsView() {
  const t = useT();
  const canView = useCan('analytics.view');
  const canAgents = useCan('analytics.agents');
  const [p, update] = useAnalyticsParams();

  if (!canView) {
    return (
      <Page>
        <EmptyState icon={<BarChart3 />} title={t('analytics.view.noAccessTitle')} description={t('analytics.view.noAccessBody')} />
      </Page>
    );
  }
  const tab: AnalyticsTab = p.tab === 'agents' && !canAgents ? 'chats' : p.tab;
  const { reconcile: _r, ...exportFilters } = chatsQuery(p);
  void _r;

  return (
    <Page>
      <PageHeader
        title={t('analytics.view.title')}
        description={t('analytics.view.description', { range: rangeLabel(p.range), timezone: p.timezone })}
        actions={tab === 'chats' && !p.range.error ? <ExportControl report="chats" filters={exportFilters} label={t('analytics.view.exportCsv')} /> : undefined}
      />
      <Card>
        <CardBody>
          <FiltersBar params={{ ...p, tab }} update={update} />
        </CardBody>
      </Card>
      <Tabs value={tab} onValueChange={(v) => update({ tab: v === 'chats' ? null : v })} className="flex flex-col gap-6">
        <TabsList aria-label={t('analytics.view.reports')}>
          <TabsTrigger value="chats">{t('common.chats')}</TabsTrigger>
          {canAgents && <TabsTrigger value="agents">{t('analytics.view.agents')}</TabsTrigger>}
          <TabsTrigger value="invitations">{t('analytics.view.invitations')}</TabsTrigger>
        </TabsList>
        <TabsContent value="chats">
          {tab === 'chats' && <ChatsReportView params={p} update={update} />}
        </TabsContent>
        {canAgents && (
          <TabsContent value="agents">
            {tab === 'agents' && <AgentsReportView params={p} />}
          </TabsContent>
        )}
        <TabsContent value="invitations">
          {tab === 'invitations' && <InvitationsReportView params={p} />}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
