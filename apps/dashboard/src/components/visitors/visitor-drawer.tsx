'use client';
/**
 * Live visitor detail drawer (ch. 11): summary from the live projection (ticking
 * from the server baseline), open tabs with the most-recent marker, tags, custom
 * fields, session page timeline and prior chats, plus a link to the full profile.
 * Starting a chat is not offered: chats are visitor-initiated in this API.
 */
import { ArrowUpRight, MessageSquare, Radio, Star } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { Badge, Banner, Button, Dialog, DrawerContent, PanelError, Skeleton } from '@/components/ui';
import { CustomFieldValues } from '@/components/custom-fields/values-editor';
import { errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration, formatDurationLong, formatNumber } from '@/lib/format';
import { byId, useSites } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { ApproxCountry, DeviceLabel, Elapsed, IdentityBadge, originLabel, safeHref, ticking, urlLabel, useMonoNow } from './display';
import type { LiveRow } from './live-model';
import { PriorChats } from './prior-chats';
import { SessionsTimeline } from './sessions-timeline';
import { TagEditor } from './tag-editor';
import { GROUP_LABEL } from './types';
import { useVisitorProfile } from './use-visitor';

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-line-subtle px-5 py-4" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-2">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <dt className="shrink-0 text-fg-2">{label}</dt>
      <dd className="min-w-0 text-end text-fg break-anywhere">{children}</dd>
    </div>
  );
}

export function VisitorDrawer({ visitorId, live, onClose }: { visitorId: string | null; live: LiveRow | null; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog open={!!visitorId} onOpenChange={(o) => !o && onClose()}>
      {visitorId && (
        <DrawerContent title={live?.v.displayName ?? t('common.visitor')} description={live ? t(GROUP_LABEL[live.v.group]) : t('visitors.drawer.notInLive')} width={480}>
          <DrawerBody visitorId={visitorId} live={live} />
        </DrawerContent>
      )}
    </Dialog>
  );
}

function DrawerBody({ visitorId, live }: { visitorId: string; live: LiveRow | null }) {
  const t = useT();
  const now = useMonoNow(1000);
  const profile = useVisitorProfile(visitorId);
  const canEdit = useCan('visitors.edit');
  const canServe = useCan('chats.serve');
  const sites = byId(useSites().data);
  const v = live?.v ?? null;
  const p = profile.data;
  const waitMs = v?.chat ? ticking(v.chat.waitMs, live!.recv, now) : null;

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 border-b border-line-subtle px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <IdentityBadge verified={v?.identity.verified ?? p?.identityVerified ?? false} identified={v?.identity.identified ?? !!(p?.fields.name?.value || p?.fields.email?.value)} />
          {v ? (
            <Badge tone={v.group === 'incoming' ? 'warning' : v.group === 'served' ? 'success' : v.group === 'idle' ? 'neutral' : 'info'} icon={<Radio className="size-3" aria-hidden />}>
              {t(GROUP_LABEL[v.group])}
            </Badge>
          ) : (
            <Badge tone="neutral">{t('visitors.drawer.noLongerLive')}</Badge>
          )}
          {v?.siteId && sites.get(v.siteId) && (
            <span className="text-xs text-fg-2" dir="auto">
              {sites.get(v.siteId)!.name}
            </span>
          )}
        </div>
        {!v && <p className="text-sm text-fg-2">{t('visitors.drawer.leftLive')}</p>}
        <Button asChild variant="secondary" size="sm" className="self-start">
          <Link href={`/visitors/${visitorId}`}>
            {t('visitors.drawer.openProfile')} <ArrowUpRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
          </Link>
        </Button>
      </div>

      {v && (
        <Section title={t('visitors.drawer.rightNow')}>
          {v.browsingHidden ? (
            <p className="text-sm text-fg-2">{t('visitors.drawer.browsingHidden')}</p>
          ) : (
            <dl className="flex flex-col gap-1.5">
              <Row label={t('visitors.live.col.page')}>
                {v.currentUrl ? (
                  <span className="flex flex-col items-end">
                    {v.currentTitle && (
                      <span className="font-medium" dir="auto">
                        {v.currentTitle}
                      </span>
                    )}
                    {safeHref(v.currentUrl) ? (
                      <a href={safeHref(v.currentUrl)!} target="_blank" rel="noopener noreferrer nofollow" dir="auto" className="break-all text-xs text-primary hover:underline">
                        {urlLabel(v.currentUrl)}
                      </a>
                    ) : (
                      <span className="break-all text-xs" dir="auto">
                        {urlLabel(v.currentUrl)}
                      </span>
                    )}
                  </span>
                ) : (
                  '—'
                )}
              </Row>
              <Row label={t('visitors.drawer.onThisPage')}>
                <Elapsed ms={ticking(v.pageDwellMs, live!.recv, now)} />
              </Row>
              <Row label={t('visitors.drawer.timeOnSite')}>
                <Elapsed ms={ticking(v.timeOnSiteMs, live!.recv, now)} />
              </Row>
              <Row label={t('visitors.live.col.referrer')}>{v.referrerOrigin ? <span dir="auto">{originLabel(v.referrerOrigin)}</span> : t('visitors.live.direct')}</Row>
              <Row label={t('visitors.drawer.location')}>
                <ApproxCountry code={v.country} />
              </Row>
              <Row label={t('visitors.live.col.device')}>
                <DeviceLabel category={v.deviceCategory} />
              </Row>
              <Row label={t('visitors.live.col.visits')}>{v.sessionCount === null ? '—' : formatNumber(v.sessionCount)}</Row>
            </dl>
          )}
          {v.chat && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <MessageSquare className="size-4 text-fg-2" aria-hidden />
                {v.group === 'incoming' ? (
                  <span aria-label={waitMs === null ? undefined : t('visitors.live.waiting', { duration: formatDurationLong(waitMs) })}>
                    {t('visitors.live.waiting', { duration: waitMs === null ? '—' : formatDuration(waitMs) })}
                  </span>
                ) : (
                  t('visitors.drawer.inActiveChat')
                )}
                <span className="text-fg-2">
                  · <bdi>{v.chat.departmentName ?? t('visitors.live.noDepartment')}</bdi>
                </span>
              </span>
              {canServe && (
                <Link href={`/inbox/${v.chat.id}`} className="font-medium text-primary hover:underline">
                  {t('visitors.drawer.openChat')}
                </Link>
              )}
            </div>
          )}
          {v.sessions.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-fg-2">{t('visitors.live.tabsOpen', { count: v.sessions.length })}</p>
              <ul className="flex flex-col gap-1">
                {v.sessions.map((s) => (
                  <li key={s.sessionId} className="flex items-center gap-2 rounded-md border border-line-subtle px-2.5 py-1.5 text-xs">
                    {s.mostRecent && <Star className="size-3.5 shrink-0 fill-current text-warning" aria-label={t('visitors.drawer.mostRecentTab')} />}
                    <span className="min-w-0 flex-1 truncate" dir={s.browsingHidden ? undefined : 'auto'}>
                      {s.browsingHidden ? t('visitors.drawer.hiddenNoConsent') : urlLabel(s.currentUrl) || '—'}
                    </span>
                    {!s.browsingHidden && (
                      <span className="shrink-0 text-fg-2">
                        <Elapsed ms={ticking(s.pageDwellMs, live!.recv, now)} />
                      </span>
                    )}
                    {!s.visible && <span className="shrink-0 text-fg-3">{t('visitors.drawer.background')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {profile.isError ? (
        <PanelError message={t('visitors.drawer.recordLoadError', { error: errorMessage(profile.error) })} onRetry={() => void profile.refetch()} />
      ) : !p ? (
        <div className="flex flex-col gap-3 px-5 py-4" aria-busy="true">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <>
          {p.erased && (
            <div className="px-5 pt-4">
              <Banner tone="warning">{t('visitors.drawer.erased')}</Banner>
            </div>
          )}
          <Section title={t('visitors.drawer.contact')}>
            <dl className="flex flex-col gap-1.5">
              <Row label={t('common.name')}>
                <bdi>{p.fields.name?.value ?? '—'}</bdi> {p.fields.name?.value && !p.fields.name.verified && <span className="text-xs text-fg-2">{t('visitors.drawer.unverifiedParen')}</span>}
              </Row>
              <Row label={t('common.email')}>
                <bdi>{p.fields.email?.value ?? '—'}</bdi> {p.fields.email?.value && !p.fields.email.verified && <span className="text-xs text-fg-2">{t('visitors.drawer.unverifiedParen')}</span>}
              </Row>
              <Row label={t('visitors.drawer.firstSeen')}>{formatDateTime(p.firstSeenAt)}</Row>
            </dl>
          </Section>
          <Section title={t('visitors.live.col.tags')}>
            <TagEditor tags={p.tags} canEdit={canEdit && !p.erased} onSave={profile.saveTags} label={t('visitors.drawer.visitorTags')} />
          </Section>
          <Section title={t('visitors.drawer.customFields')}>
            <CustomFieldValues compact visitor={p} onSaved={profile.setProfile} onReload={() => void profile.refetch()} />
          </Section>
        </>
      )}

      <Section title={t('visitors.drawer.sessions')}>
        <SessionsTimeline visitorId={visitorId} pageSize={5} maxPagesShown={15} />
      </Section>
      <Section title={t('visitors.drawer.previousChats')}>
        <PriorChats visitorId={visitorId} pageSize={5} />
      </Section>
    </div>
  );
}
