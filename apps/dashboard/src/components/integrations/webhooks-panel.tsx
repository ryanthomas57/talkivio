'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CirclePause, CircleCheck, Plus, Webhook } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BRAND_NAME } from '@/components/brand';
import { Badge, Button, Card, CardHeader, EmptyState, PanelError, Skeleton } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useRecentAuth } from './recent-auth';
import { richT } from './rich';
import { OneTimeSecretDialog } from './secret-panel';
import { integrationKeys, type WebhookEndpoint, type WebhookListItem, type WebhookWithSecret } from './types';
import { WebhookFormDialog } from './webhook-form-dialog';
import { DeliveryStatusBadge, eventLabel, hostOf, IN_FLIGHT, SIGNATURE_HEADER } from './webhook-shared';

export function webhookHref(id: string): string {
  return `/settings/integrations/webhooks/${id}`;
}

export function EndpointStateBadge({ endpoint }: { endpoint: WebhookEndpoint }) {
  const t = useT();
  if (!endpoint.enabled)
    return (
      <Badge tone="neutral" icon={<CirclePause className="size-3.5" aria-hidden />}>
        {t('common.disabled')}
      </Badge>
    );
  return (
    <Badge tone="success" icon={<CircleCheck className="size-3.5" aria-hidden />}>
      {t('common.enabled')}
    </Badge>
  );
}

export function WebhooksPanel() {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const { guard, dialog } = useRecentAuth();
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<WebhookWithSecret | null>(null);
  // Each item carries its latest delivery attempt, so the list is one request; it is re-polled only while an attempt is in flight.
  const q = useQuery({
    queryKey: integrationKeys.webhooks,
    queryFn: () => api.get<WebhookListItem[]>('/webhooks'),
    refetchInterval: (query) => (query.state.data?.some((w) => w.lastDelivery && IN_FLIGHT.has(w.lastDelivery.status)) ? 5000 : false),
  });
  const items = q.data ?? [];

  return (
    <Card>
      <CardHeader
        title={t('integrations.webhooks.title')}
        description={t('integrations.webhooks.description', { brand: BRAND_NAME })}
        action={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            {t('integrations.webhooks.add')}
          </Button>
        }
      />
      {q.isPending ? (
        <div className="flex flex-col gap-3 p-4 sm:p-6" aria-busy>
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : q.error ? (
        <PanelError message={t('integrations.webhooks.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Webhook />}
          title={t('integrations.webhooks.emptyTitle')}
          description={t('integrations.webhooks.emptyBody')}
          action={
            <Button variant="secondary" onClick={() => setAdding(true)}>
              {t('integrations.webhooks.add')}
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-line-subtle" aria-label={t('integrations.webhooks.title')}>
          {items.map((w) => {
            const last = w.lastDelivery;
            return (
              <li key={w.id}>
                <Link href={webhookHref(w.id)} className="flex items-start gap-3 px-4 py-4 hover:bg-surface-2 sm:px-6">
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 break-all font-mono text-sm font-medium text-fg" dir="ltr">
                        {w.url}
                      </span>
                      <EndpointStateBadge endpoint={w} />
                      {w.enabled && w.failureCount > 0 && <Badge tone="warning">{t('integrations.webhooks.recentFailures', { count: w.failureCount })}</Badge>}
                    </span>
                    {w.description && (
                      <span className="text-sm text-fg-2" dir="auto">
                        {w.description}
                      </span>
                    )}
                    <span className="text-xs text-fg-2">
                      {t('integrations.webhooks.eventSummary', { count: w.eventTypes.length, events: w.eventTypes.map((ev) => eventLabel(t, ev)).join(t('integrations.listSeparator')) })}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
                      <span className="font-medium text-fg">{t('integrations.webhooks.lastDelivery')}</span>
                      {last ? (
                        <>
                          <DeliveryStatusBadge status={last.status} />
                          <span>{eventLabel(t, last.eventType)}</span>
                          {last.responseStatus !== null && <span dir="ltr">{t('integrations.http', { status: String(last.responseStatus) })}</span>}
                          {last.error && (
                            <span className="break-all text-danger" dir="auto">
                              {last.error.slice(0, 120)}
                            </span>
                          )}
                          <time dateTime={last.at} title={formatDateTime(last.at)}>
                            {formatRelative(last.at)}
                          </time>
                        </>
                      ) : (
                        <span>{t('integrations.webhooks.noDeliveryYet')}</span>
                      )}
                      {w.lastSuccessAt && (
                        <span>
                          {richT(t, 'integrations.webhooks.lastSuccess', {
                            time: (
                              <time dateTime={w.lastSuccessAt} title={formatDateTime(w.lastSuccessAt)}>
                                {formatRelative(w.lastSuccessAt)}
                              </time>
                            ),
                          })}
                        </span>
                      )}
                    </span>
                  </span>
                  <ChevronRight className="mt-1 size-4 shrink-0 text-fg-2 rtl:-scale-x-100" aria-hidden />
                  <span className="sr-only">{t('integrations.webhooks.openEndpoint', { host: isolate(hostOf(w.url)) })}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <WebhookFormDialog
        open={adding}
        onOpenChange={setAdding}
        guard={guard}
        onCreated={(w) => {
          void qc.invalidateQueries({ queryKey: integrationKeys.webhooks });
          setCreated(w);
        }}
      />
      <OneTimeSecretDialog
        open={!!created}
        title={t('integrations.webhooks.addedTitle')}
        description={
          created ? (
            <span className="break-all font-mono text-xs" dir="ltr">
              {created.url}
            </span>
          ) : undefined
        }
        label={t('integrations.secret.signingSecretLabel')}
        what={t('integrations.what.signingSecret')}
        value={created?.secret ?? null}
        onDone={() => {
          const id = created?.id;
          setCreated(null);
          if (id) router.push(webhookHref(id));
        }}
      >
        <p className="text-sm text-fg-2">
          {richT(t, 'integrations.webhooks.addedUsage', {
            header: (
              <code className="font-mono text-xs" dir="ltr">
                {SIGNATURE_HEADER}
              </code>
            ),
          })}
        </p>
      </OneTimeSecretDialog>
      {dialog}
    </Card>
  );
}
