'use client';
import { Globe, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Page,
  PageHeader,
  PanelError,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { useNow } from '@/hooks/use-media';
import { useT } from '@/i18n';
import { errorMessage } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useSites } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { CreateSiteDialog } from './create-site-dialog';
import { InstallStatus, installStateOf } from './install-status';

export function SitesList() {
  const t = useT();
  const router = useRouter();
  const sites = useSites();
  const canManage = useCan('sites.manage');
  const [creating, setCreating] = useState(false);
  const now = useNow(30_000);

  return (
    <Page>
      <PageHeader
        title={t('sites.list.title')}
        description={t('sites.list.description')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              {t('sites.list.add')}
            </Button>
          )
        }
      />
      <Card>
        {sites.isLoading ? (
          <div className="flex flex-col gap-3 p-4" aria-busy>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : sites.isError ? (
          <PanelError message={errorMessage(sites.error)} onRetry={() => void sites.refetch()} />
        ) : !sites.data?.length ? (
          <EmptyState
            icon={<Globe />}
            title={t('sites.list.emptyTitle')}
            description={t('sites.list.emptyBody')}
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  {t('sites.list.add')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <TableScroll className="hidden sm:block">
              <Table>
                <THead>
                  <tr>
                    <TH>{t('sites.list.colWebsite')}</TH>
                    <TH>{t('sites.list.colOrigins')}</TH>
                    <TH>{t('sites.list.colInstallation')}</TH>
                    <TH>{t('sites.list.colWidget')}</TH>
                  </tr>
                </THead>
                <tbody>
                  {sites.data.map((s) => (
                    <TR key={s.id} interactive onClick={() => router.push(`/settings/sites/${s.id}`)}>
                      <TD>
                        <div className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-2">
                            <Link
                              href={`/settings/sites/${s.id}`}
                              className="font-medium text-fg hover:underline"
                              onClick={(e) => e.stopPropagation()}
                              dir="auto"
                            >
                              {s.name}
                            </Link>
                            {!s.enabled && <Badge tone="warning">{t('common.disabled')}</Badge>}
                            {s.identityVerificationEnabled && (
                              <Badge tone="info">{t('sites.list.identityVerification')}</Badge>
                            )}
                          </span>
                          <span className="font-mono text-xs text-fg-2" dir="ltr">
                            {s.publicKey}
                          </span>
                        </div>
                      </TD>
                      <TD>
                        <div className="flex flex-col gap-0.5">
                          <span className="tabular">{t('sites.list.originCount', { count: s.origins.length })}</span>
                          {s.origins[0] && (
                            <span
                              className="max-w-[240px] truncate text-xs text-fg-2"
                              title={s.origins.map((o) => o.origin).join('\n')}
                            >
                              <bdi>{s.origins[0].origin}</bdi>
                              {s.origins.length > 1 ? ` +${formatNumber(s.origins.length - 1)}` : ''}
                            </span>
                          )}
                        </div>
                      </TD>
                      <TD>
                        <InstallStatus
                          state={installStateOf(s, now)}
                          lastVerifiedAt={s.lastVerifiedAt}
                          origin={s.lastVerifiedOrigin}
                          compact
                        />
                      </TD>
                      <TD>
                        <span className="tabular">{t('sites.list.revision', { revision: s.configRevision })}</span>
                        <span className="block text-xs text-fg-2">{t('sites.list.published')}</span>
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
            <ul className="flex flex-col sm:hidden" aria-label={t('sites.list.title')}>
              {sites.data.map((s) => (
                <li key={s.id} className="border-b border-line-subtle last:border-b-0">
                  <Link
                    href={`/settings/sites/${s.id}`}
                    className="flex flex-col gap-2 px-4 py-3 hover:bg-surface-2"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium" dir="auto">
                        {s.name}
                      </span>
                      {!s.enabled && <Badge tone="warning">{t('common.disabled')}</Badge>}
                    </span>
                    <span className="text-xs text-fg-2">{t('sites.list.mobileMeta', { count: s.origins.length, revision: s.configRevision })}</span>
                    <InstallStatus state={installStateOf(s, now)} lastVerifiedAt={s.lastVerifiedAt} compact />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      {canManage && <CreateSiteDialog open={creating} onOpenChange={setCreating} />}
    </Page>
  );
}
