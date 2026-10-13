'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, CircleHelp, CircleX, Plug, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { BRAND_NAME } from '@/components/brand';
import { Badge, Banner, Button, Card, CardHeader, EmptyState, PanelError, Skeleton, type BadgeTone } from '@/components/ui';
import { isolate, useT, type MessageKey, type Translate } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { richT } from './rich';
import { integrationKeys, type Connector, type ConnectorHealth } from './types';

const CATEGORY: Record<string, MessageKey> = {
  ticketing: 'integrations.connectors.category.ticketing',
  crm: 'integrations.connectors.category.crm',
  notification: 'integrations.connectors.category.notification',
  warehouse: 'integrations.connectors.category.warehouse',
  test: 'integrations.connectors.category.test',
};
const CAPABILITY: Record<string, MessageKey> = {
  createTicket: 'integrations.connectors.capability.createTicket',
  updateTicket: 'integrations.connectors.capability.updateTicket',
  exportChat: 'integrations.connectors.capability.exportChat',
  eraseSubject: 'integrations.connectors.capability.eraseSubject',
};
const FIELD: Record<string, MessageKey> = {
  subdomain: 'integrations.connectors.field.subdomain',
  email: 'integrations.connectors.field.email',
  api_token: 'integrations.connectors.field.apiToken',
  private_app_token: 'integrations.connectors.field.privateAppToken',
  webhook_url: 'integrations.connectors.field.webhookUrl',
};

/** Known codes are translated; codes this release doesn't know are shown as-is. */
const labelOr = (t: Translate, map: Record<string, MessageKey>, code: string): string => (map[code] ? t(map[code]!) : code);

/**
 * Honest status (ch. 56): nothing is shown as working without credentials and a passing
 * health check. A connector whose adapter is missing from this release reports
 * `adapter_not_available` whatever its credentials, and cannot be checked.
 */
function statusOf(c: Connector): { label: MessageKey; tone: BadgeTone; Icon: typeof CircleCheck } {
  if (c.statusReason === 'adapter_not_available') return { label: 'integrations.connectors.status.notAvailable', tone: 'neutral', Icon: CircleDashed };
  if (c.status === 'healthy') return { label: 'integrations.connectors.status.healthy', tone: 'success', Icon: CircleCheck };
  if (c.status === 'unhealthy') return { label: 'integrations.connectors.status.unhealthy', tone: 'danger', Icon: CircleX };
  if (c.status === 'configured_unverified') return { label: 'integrations.connectors.status.unverified', tone: 'warning', Icon: CircleHelp };
  return { label: 'integrations.connectors.status.notConfigured', tone: 'neutral', Icon: CircleDashed };
}

/** Why the health check can't run yet (null = it can). */
function checkBlocked(t: Translate, c: Connector): string | null {
  if (c.statusReason === 'adapter_not_available' || !c.adapterAvailable) return t('integrations.connectors.blockedAdapter');
  if (c.statusReason === 'no_credentials') return t('integrations.connectors.blockedCredentials', { name: isolate(c.displayName) });
  return null;
}

type CheckResult = { kind: 'ran'; health: ConnectorHealth } | { kind: 'error'; tone: 'warning' | 'danger'; message: string };

export function ConnectorsPanel() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: integrationKeys.connectors, queryFn: () => api.get<Connector[]>('/integrations/connectors') });
  const [checking, setChecking] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, CheckResult>>({});

  const check = async (c: Connector) => {
    setChecking(c.key);
    try {
      const health = await api.post<ConnectorHealth>(`/integrations/connectors/${c.key}/health-check`);
      setResults((r) => ({ ...r, [c.key]: { kind: 'ran', health } }));
      void qc.invalidateQueries({ queryKey: integrationKeys.connectors });
    } catch (e) {
      setResults((r) => ({
        ...r,
        [c.key]: isApiError(e, 'INTEGRATION_UNAVAILABLE')
          ? { kind: 'error', tone: 'warning', message: t('integrations.connectors.unavailable', { message: e.message, name: isolate(c.displayName) }) }
          : { kind: 'error', tone: 'danger', message: t('integrations.connectors.checkFailed', { error: errorMessage(e) }) },
      }));
    } finally {
      setChecking(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title={t('integrations.connectors.title')}
        description={t('integrations.connectors.description', { brand: BRAND_NAME })}
      />
      {q.isPending ? (
        <div className="grid gap-4 p-4 sm:p-6 md:grid-cols-2" aria-busy>
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      ) : q.error ? (
        <PanelError message={t('integrations.connectors.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <EmptyState icon={<Plug />} title={t('integrations.connectors.emptyTitle')} description={t('integrations.connectors.emptyBody')} />
      ) : (
        <div className="flex flex-col gap-4 p-4 sm:p-6">
          <Banner tone="info">{t('integrations.connectors.credentialsNotice')}</Banner>
          <ul className="grid gap-4 md:grid-cols-2" aria-label={t('integrations.connectors.title')}>
            {q.data.map((c) => {
              const result = results[c.key];
              // The list never caches a check result; the latest check run here is the freshest status.
              const s = statusOf(result?.kind === 'ran' ? result.health : c);
              const blocked = checkBlocked(t, c);
              return (
                <li key={c.key} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <h3 className="text-base font-semibold" dir="auto">
                        {c.displayName}
                      </h3>
                      <p className="text-xs text-fg-2">{labelOr(t, CATEGORY, c.category)}</p>
                    </div>
                    <Badge tone={s.tone} icon={<s.Icon className="size-3.5" aria-hidden />}>
                      {t(s.label)}
                    </Badge>
                  </div>
                  <p className="text-sm text-fg-2" dir="auto">
                    {c.note}
                  </p>
                  <dl className="grid gap-2 text-sm">
                    <div>
                      <dt className="font-medium text-fg">{t('integrations.connectors.wouldDo')}</dt>
                      <dd className="text-fg-2">{c.capabilities.length ? c.capabilities.map((k) => labelOr(t, CAPABILITY, k)).join(t('integrations.listSeparator')) : t('integrations.connectors.sendNotifications')}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-fg">{t('integrations.connectors.needs')}</dt>
                      <dd className="text-fg-2">{c.credentialFields.map((f) => labelOr(t, FIELD, f)).join(t('integrations.listSeparator'))}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-fg">{t('integrations.connectors.wouldSend')}</dt>
                      <dd className="text-fg-2" dir="auto">
                        {c.transmits.join('; ')}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-auto flex flex-col gap-2 pt-1">
                    <Button variant="secondary" className="w-fit" onClick={() => void check(c)} loading={checking === c.key} disabled={!!blocked} aria-describedby={blocked ? `connector-${c.key}-blocked` : undefined}>
                      <Stethoscope className="size-4" aria-hidden />
                      {t('integrations.connectors.runCheck')}
                    </Button>
                    {blocked && (
                      <p id={`connector-${c.key}-blocked`} className="text-xs text-fg-2">
                        {blocked}
                      </p>
                    )}
                    {result?.kind === 'ran' ? (
                      <Banner tone={result.health.status === 'healthy' ? 'success' : 'danger'} title={result.health.status === 'healthy' ? t('integrations.connectors.checkPassed') : t('integrations.connectors.checkFailedTitle')} live="polite">
                        {result.health.detail && (
                          <span className="block break-words" dir="auto">
                            {result.health.detail}
                          </span>
                        )}
                        <span className="block text-xs text-fg-2">
                          {richT(
                            t,
                            result.health.status !== 'healthy' ? 'integrations.connectors.checkedUnhealthy' : 'integrations.connectors.checked',
                            {
                              time: (
                                <time dateTime={result.health.checkedAt} title={formatDateTime(result.health.checkedAt)}>
                                  {formatRelative(result.health.checkedAt)}
                                </time>
                              ),
                            },
                            { name: isolate(c.displayName) },
                          )}
                        </span>
                      </Banner>
                    ) : (
                      result && (
                        <Banner tone={result.tone} live="polite">
                          {result.message}
                        </Banner>
                      )
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}
