'use client';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Banner, Card, CardBody, CardHeader, PanelError, Skeleton, Spinner } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { qk } from '@/lib/queries';
import type { Site } from '@/lib/types';
import { CodeBlock } from './copy-button';
import { InstallStatus } from './install-status';
import { richT, slots } from './rich-text';

interface Installation {
  siteKey: string;
  snippet: string;
  loaderUrl: string;
  apiOrigin: string;
  installedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerifiedOrigin: string | null;
  status: 'verified' | 'seen_before' | 'not_detected';
  diagnostics: string[];
  csp: { scriptSrc: string; frameSrc: string; connectSrc: string };
}

/**
 * Install snippet, live installation check (polled every 5 s while this tab is
 * visible and the browser tab is in the foreground), checklist, diagnostics and
 * the CSP sources a strict host page must allow.
 */
export function SiteInstallation({ site, active }: { site: Site; active: boolean }) {
  const t = useT();
  const q = useQuery({
    queryKey: [...qk.sites, site.id, 'installation'],
    queryFn: () => api.get<Installation>(`/sites/${site.id}/installation-status`),
    enabled: active,
    refetchInterval: active ? 5000 : false,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  if (q.isLoading)
    return (
      <div className="flex flex-col gap-4" aria-busy>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  if (q.isError && !q.data)
    return (
      <Card>
        <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      </Card>
    );
  const info = q.data;
  if (!info) return null;

  const verified = info.status === 'verified';
  const csp = [
    `script-src ${info.csp.scriptSrc}`,
    `frame-src ${info.csp.frameSrc}`,
    `connect-src ${info.csp.connectSrc}`,
  ];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title={t('sites.install.snippetTitle')}
          description={richT(t('sites.install.snippetHint', slots(1)), [
            <code key="tag" className="font-mono" dir="ltr">&lt;/body&gt;</code>, // i18n-ignore: HTML tag name
          ])}
        />
        <CardBody className="flex flex-col gap-3">
          <CodeBlock code={info.snippet} what={t('sites.install.whatSnippet')} />
          {site.previousKeyExpiresAt && new Date(site.previousKeyExpiresAt).getTime() > Date.now() && (
            <Banner tone="warning">
              {t('sites.install.rotatedBanner', { time: formatDateTime(site.previousKeyExpiresAt) })}
            </Banner>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('sites.install.checkTitle')}
          description={t('sites.install.checkDescription')}
          action={
            <span className="inline-flex items-center gap-2 text-xs text-fg-2">
              {q.isFetching ? <Spinner className="size-3.5" label={t('sites.install.checking')} /> : null}
              {active ? t('sites.install.checkingEvery', { seconds: 5 }) : t('sites.install.paused')}
            </span>
          }
        />
        <CardBody className="flex flex-col gap-5">
          <div role="status" aria-live="polite">
            <InstallStatus
              state={info.status}
              lastVerifiedAt={info.lastVerifiedAt}
              origin={info.lastVerifiedOrigin}
            />
          </div>
          <ul className="flex flex-col gap-2.5" aria-label={t('sites.install.checklist')}>
            <CheckItem
              done={site.origins.length > 0}
              label={
                site.origins.length ? t('sites.install.originsConfigured', { count: site.origins.length }) : t('sites.install.addOrigin')
              }
            />
            <CheckItem
              done={site.enabled}
              label={site.enabled ? t('sites.general.widgetEnabled') : t('sites.install.widgetDisabled')}
              warn={!site.enabled}
            />
            <CheckItem
              done={site.configRevision > 0}
              label={t('sites.install.published', { revision: site.configRevision })}
            />
            <CheckItem
              done={verified}
              pending={!verified}
              label={
                verified
                  ? info.lastVerifiedOrigin
                    ? t('sites.install.loadedOn', { origin: isolate(info.lastVerifiedOrigin), time: formatRelative(info.lastVerifiedAt) })
                    : t('sites.install.loadedOnYourSite', { time: formatRelative(info.lastVerifiedAt) })
                  : info.status === 'seen_before'
                    ? info.lastVerifiedOrigin
                      ? t('sites.install.lastSeenOn', { origin: isolate(info.lastVerifiedOrigin), time: formatRelative(info.lastVerifiedAt) })
                      : t('sites.install.lastSeen', { time: formatRelative(info.lastVerifiedAt) })
                    : t('sites.install.waiting')
              }
            />
          </ul>
          {info.diagnostics.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t('sites.install.diagnostics')}</h3>
              {info.diagnostics.map((d) => (
                <Banner key={d} tone="warning">
                  {d}
                </Banner>
              ))}
            </div>
          )}
          {!verified && (
            <div className="flex flex-col gap-1.5 text-sm">
              <h3 className="font-semibold">{t('sites.install.troubleTitle')}</h3>
              <ul className="ms-4 list-disc text-fg-2">
                <li>{t('sites.install.troubleOrigin')}</li>
                <li>{t('sites.install.troubleHttp')}</li>
                <li>{t('sites.install.troubleCsp')}</li>
                <li>{t('sites.install.troubleVisibility')}</li>
              </ul>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('sites.install.cspTitle')}
          description={t('sites.install.cspDescription')}
        />
        <CardBody className="flex flex-col gap-3">
          <CodeBlock code={csp.join(';\n') + ';'} what={t('sites.install.whatCsp')} />
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-fg-2">{t('sites.install.loader')}</dt>
            <dd className="break-all font-mono text-xs leading-5" dir="ltr">
              {info.loaderUrl}
            </dd>
            <dt className="text-fg-2">{t('sites.install.apiOrigin')}</dt>
            <dd className="break-all font-mono text-xs leading-5" dir="ltr">
              {info.apiOrigin}
            </dd>
            <dt className="text-fg-2">{t('sites.install.siteKey')}</dt>
            <dd className="break-all font-mono text-xs leading-5" dir="ltr">
              {info.siteKey}
            </dd>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}

function CheckItem({
  done,
  label,
  pending,
  warn,
}: {
  done: boolean;
  label: ReactNode;
  pending?: boolean;
  warn?: boolean;
}) {
  const t = useT();
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <span className="mt-0.5 shrink-0">
        {done ? (
          <CheckCircle2 className="size-5 text-success" aria-hidden />
        ) : warn ? (
          <CircleAlert className="size-5 text-warning" aria-hidden />
        ) : pending ? (
          <Spinner className="size-5" label={t('sites.install.checkingShort')} />
        ) : (
          <Circle className="size-5 text-fg-3" aria-hidden />
        )}
      </span>
      <span className={done ? 'text-fg' : 'text-fg-2'}>
        {label}
        <span className="sr-only"> {done ? t('sites.install.complete') : t('sites.install.notYet')}</span>
      </span>
    </li>
  );
}
