'use client';
/**
 * Visitor profile (ch. 17/43): identity with verified vs unverified fields,
 * editable contact details and custom fields (If-Match), tags, session timeline,
 * chats, a reviewed merge request and a ban action.
 */
import { ArrowLeft, GitMerge, ShieldBan, UserX } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Page,
  PageHeader,
  PanelError,
  Skeleton,
} from '@/components/ui';
import { useT } from '@/i18n';
import { CustomFieldValues } from '@/components/custom-fields/values-editor';
import { BanDialog } from '@/components/bans/ban-dialog';
import { errorMessage, isApiError } from '@/lib/api';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { useCan } from '@/stores/session';
import { ApproxCountry, DeviceLabel } from './display';
import { IdentityCard } from './identity-card';
import { MergeDialog } from './merge-dialog';
import { PriorChats } from './prior-chats';
import { SessionsTimeline } from './sessions-timeline';
import { TagEditor } from './tag-editor';
import { useVisitorProfile } from './use-visitor';

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <dt className="shrink-0 text-fg-2">{label}</dt>
      <dd className="min-w-0 text-end text-fg break-anywhere">{children}</dd>
    </div>
  );
}

export function VisitorProfilePage({ id }: { id: string }) {
  const t = useT();
  const profile = useVisitorProfile(id);
  const canEdit = useCan('visitors.edit');
  const canPrivacy = useCan('privacy.manage');
  const canMerge = canEdit && canPrivacy;
  const canBan = useCan('bans.manage');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [banOpen, setBanOpen] = useState(false);
  const p = profile.data;

  if (profile.isLoading)
    return (
      <Page>
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      </Page>
    );
  if (profile.isError) {
    const notFound = isApiError(profile.error) && profile.error.status === 404;
    return (
      <Page>
        {notFound ? (
          <EmptyState
            icon={<UserX />}
            title={t('visitors.profile.notFoundTitle')}
            description={t('visitors.profile.notFoundBody')}
            action={
              <Button asChild variant="secondary">
                <Link href="/visitors">{t('visitors.profile.backToVisitors')}</Link>
              </Button>
            }
          />
        ) : (
          <PanelError
            message={t('visitors.profile.loadError', { error: errorMessage(profile.error) })}
            onRetry={() => void profile.refetch()}
          />
        )}
      </Page>
    );
  }
  if (!p) return null;

  return (
    <Page>
      <div className="flex flex-col gap-3">
        <Link
          href="/visitors"
          className="inline-flex min-h-8 items-center gap-1 self-start text-sm font-medium text-fg-2 hover:text-fg"
        >
          <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden /> {t('visitors.page.title')}
        </Link>
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              <Avatar name={p.displayName} size="md" color="var(--primary)" />
              <span className="min-w-0 truncate" dir="auto">
                {p.displayName}
              </span>
            </span>
          }
          description={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {p.online ? (
                <Badge tone="success">{t('visitors.profile.onlineNow')}</Badge>
              ) : (
                <span>{t('visitors.profile.lastSeenAgo', { time: formatRelative(p.lastSeenAt) })}</span>
              )}
              <span>{t('visitors.profile.visitsChats', { visits: p.visitCount, chats: p.chatCount })}</span>
            </span>
          }
          actions={
            !p.erased && (
              <>
                {canMerge && (
                  <Button variant="secondary" onClick={() => setMergeOpen(true)}>
                    <GitMerge className="size-4" aria-hidden /> {t('visitors.profile.requestMerge')}
                  </Button>
                )}
                {canBan && (
                  <Button variant="danger-ghost" onClick={() => setBanOpen(true)}>
                    <ShieldBan className="size-4" aria-hidden /> {t('visitors.profile.ban')}
                  </Button>
                )}
              </>
            )
          }
        />
      </div>

      {p.erased && (
        <Banner tone="warning" title={t('visitors.profile.erasedTitle')}>
          {t('visitors.profile.erasedBody')}
        </Banner>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader
              title={t('visitors.profile.identity')}
              description={t('visitors.profile.identityHint')}
            />
            <CardBody>
              <IdentityCard
                profile={p}
                onSaved={profile.setProfile}
                onReload={() => void profile.refetch()}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title={t('visitors.drawer.sessions')}
              description={t('visitors.profile.sessionsHint')}
            />
            <CardBody>
              <SessionsTimeline visitorId={id} pageSize={10} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t('common.chats')} description={t('visitors.profile.chatsHint')} />
            <CardBody>
              <PriorChats visitorId={id} pageSize={10} />
            </CardBody>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader title={t('visitors.live.col.tags')} />
            <CardBody>
              <TagEditor
                tags={p.tags}
                canEdit={canEdit && !p.erased}
                onSave={profile.saveTags}
                label={t('visitors.drawer.visitorTags')}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t('visitors.drawer.customFields')} />
            <CardBody>
              <CustomFieldValues
                visitor={p}
                onSaved={profile.setProfile}
                onReload={() => void profile.refetch()}
                compact
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t('common.details')} />
            <CardBody>
              <dl className="flex flex-col">
                <Detail label={t('visitors.drawer.firstSeen')}>{formatDateTime(p.firstSeenAt)}</Detail>
                <Detail label={t('visitors.profile.lastSeen')}>{formatDateTime(p.lastSeenAt)}</Detail>
                <Detail label={t('visitors.drawer.sessions')}>
                  {p.sessionSummary.open
                    ? t('visitors.profile.sessionsOpen', {
                        total: p.sessionSummary.total,
                        open: p.sessionSummary.open,
                      })
                    : formatNumber(p.sessionSummary.total)}
                </Detail>
                <Detail label={t('visitors.drawer.location')}>
                  {p.location ? (
                    <span className="inline-flex flex-col items-end">
                      <ApproxCountry code={p.location.countryCode} />
                      {(p.location.city || p.location.region) && (
                        <span className="text-xs text-fg-2" dir="auto">
                          ≈ {[p.location.city, p.location.region].filter(Boolean).join(', ')}
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-fg-3">{t('visitors.profile.notCollected')}</span>
                  )}
                </Detail>
                <Detail label={t('visitors.live.col.device')}>
                  <span className="inline-flex flex-col items-end">
                    <DeviceLabel category={p.device.category} />
                    {(p.device.browser || p.device.os) && (
                      <span className="text-xs text-fg-2" dir="auto">
                        {[p.device.browser, p.device.os].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                </Detail>
                <Detail label={t('common.language')}>
                  {p.language ? <span dir="ltr">{p.language}</span> : ''}
                </Detail>
                <Detail label={t('common.timezone')}>
                  {p.timezone ? <span dir="ltr">{p.timezone}</span> : ''}
                </Detail>
                <Detail label={t('visitors.profile.visitorId')}>
                  <span className="font-mono text-xs" dir="ltr">
                    {p.id}
                  </span>
                </Detail>
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>

      {canMerge && (
        <MergeDialog
          open={mergeOpen}
          onOpenChange={setMergeOpen}
          source={{ id: p.id, displayName: p.displayName }}
        />
      )}
      {canBan && (
        <BanDialog
          open={banOpen}
          onOpenChange={setBanOpen}
          visitor={{ id: p.id, displayName: p.displayName }}
        />
      )}
    </Page>
  );
}
