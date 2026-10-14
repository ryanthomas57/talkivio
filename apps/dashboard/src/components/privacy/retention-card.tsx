'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  PanelError,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { useRecentAuth } from '@/components/integrations/recent-auth';
import { richT } from '@/components/integrations/rich';
import { useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { useCan, useSession } from '@/stores/session';
import { privacyKeys, type RetentionReport } from './types';

type TargetKey = keyof RetentionReport['targets'];
const TARGETS: Array<{
  key: TargetKey;
  label: MessageKey;
  cutoff?: keyof RetentionReport['cutoffs'];
  what: MessageKey;
}> = [
  {
    key: 'closedChats',
    label: 'privacy.retention.target.closedChats',
    cutoff: 'transcripts',
    what: 'privacy.retention.target.closedChatsWhat',
  },
  {
    key: 'messages',
    label: 'privacy.retention.target.messages',
    cutoff: 'transcripts',
    what: 'privacy.retention.target.messagesWhat',
  },
  {
    key: 'attachments',
    label: 'privacy.retention.target.attachments',
    cutoff: 'transcripts',
    what: 'privacy.retention.target.attachmentsWhat',
  },
  {
    key: 'transcriptExports',
    label: 'privacy.retention.target.transcriptExports',
    cutoff: 'transcripts',
    what: 'privacy.retention.target.transcriptExportsWhat',
  },
  {
    key: 'pageEvents',
    label: 'privacy.retention.target.pageEvents',
    cutoff: 'pageEvents',
    what: 'privacy.retention.target.pageEventsWhat',
  },
  {
    key: 'webhookDeliveries',
    label: 'privacy.retention.target.webhookDeliveries',
    cutoff: 'webhookDeliveries',
    what: 'privacy.retention.target.webhookDeliveriesWhat',
  },
  {
    key: 'verificationEvidence',
    label: 'privacy.retention.target.verificationEvidence',
    cutoff: 'verificationEvidence',
    what: 'privacy.retention.target.verificationEvidenceWhat',
  },
  {
    key: 'expiredPrivacyExports',
    label: 'privacy.retention.target.expiredExports',
    what: 'privacy.retention.target.expiredExportsWhat',
  },
];

/** Plural variables for the per-target counts in the result and confirmation copy. */
function targetCounts(targets: RetentionReport['targets']) {
  return {
    closedChats: targets.closedChats,
    messages: targets.messages,
    attachments: targets.attachments,
    pageEvents: targets.pageEvents,
    webhookDeliveries: targets.webhookDeliveries,
    evidence: targets.verificationEvidence,
    exports: targets.expiredPrivacyExports,
  };
}

export function RetentionCard() {
  const t = useT();
  const qc = useQueryClient();
  const tenant = useSession((s) => s.tenant);
  const canEditTenant = useCan('tenant.manage');
  const { guard, dialog } = useRecentAuth();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<RetentionReport | null>(null);
  const q = useQuery({
    queryKey: privacyKeys.retention,
    queryFn: () => api.get<RetentionReport>('/privacy/retention/preview'),
  });
  const p = q.data;
  const total = p ? Object.values(p.targets).reduce((a, b) => a + b, 0) : 0;
  const tracking = tenant?.settings?.tracking;

  return (
    <Card>
      <CardHeader
        title={t('privacy.retention.title')}
        description={t('privacy.retention.description')}
        action={
          <Button variant="secondary" onClick={() => setConfirming(true)} disabled={!p}>
            <Play className="size-4" aria-hidden />
            {t('privacy.retention.runNow')}
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-6">
        <section aria-labelledby="ret-settings" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="ret-settings" className="text-sm font-semibold">
              {t('privacy.retention.currentSettings')}
            </h3>
            {canEditTenant && (
              <Link href="/settings/general" className="text-sm font-medium text-primary hover:underline">
                {t('privacy.retention.changeInGeneral')}
              </Link>
            )}
          </div>
          {tenant ? (
            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="text-fg-2">{t('privacy.retention.transcripts')}</dt>
              <dd>{t('privacy.retention.transcriptsKept', { days: tenant.retentionDays })}</dd>
              <dt className="text-fg-2">{t('privacy.retention.pageEvents')}</dt>
              <dd>
                {tracking
                  ? t('privacy.retention.pageEventsKept', { days: tracking.pageEventRetentionDays })
                  : ''}
              </dd>
              <dt className="text-fg-2">{t('privacy.retention.ipAddresses')}</dt>
              <dd>
                {tracking
                  ? tracking.retainIp
                    ? t('privacy.retention.ipStored')
                    : t('privacy.retention.ipNotStored')
                  : ''}
              </dd>
              <dt className="text-fg-2">{t('privacy.retention.location')}</dt>
              <dd>
                {tracking
                  ? tracking.locationEnabled
                    ? t('privacy.retention.locationOn')
                    : t('common.off')
                  : ''}
              </dd>
              <dt className="text-fg-2">{t('privacy.retention.browsing')}</dt>
              <dd>
                {tracking
                  ? tracking.analyticsConsentRequired
                    ? t('privacy.retention.browsingConsent')
                    : t('privacy.retention.browsingNoConsent')
                  : ''}
              </dd>
              {p && (
                <>
                  <dt className="text-fg-2">{t('privacy.retention.webhookHistory')}</dt>
                  <dd>
                    {t('privacy.retention.webhookKept', { days: p.policy.webhookDeliveryRetentionDays })}
                  </dd>
                  <dt className="text-fg-2">{t('privacy.retention.evidence')}</dt>
                  <dd>
                    {t('privacy.retention.evidenceKept', {
                      days: p.policy.verificationEvidenceRetentionDays,
                    })}
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <Skeleton className="h-24 w-full" />
          )}
        </section>

        <section aria-labelledby="ret-preview" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 id="ret-preview" className="text-sm font-semibold">
              {t('privacy.retention.nextBatch')}
            </h3>
            {p && (
              <span className="text-xs text-fg-2">
                {richT(t, 'privacy.retention.checkedAt', {
                  time: (
                    <time dateTime={p.generatedAt} title={formatDateTime(p.generatedAt)}>
                      {formatRelative(p.generatedAt)}
                    </time>
                  ),
                })}{' '}
                <Button
                  variant="link"
                  className="text-xs"
                  onClick={() => void q.refetch()}
                  disabled={q.isFetching}
                >
                  {q.isFetching ? t('privacy.retention.checking') : t('privacy.retention.checkAgain')}
                </Button>
              </span>
            )}
          </div>
          {q.isPending ? (
            <Skeleton className="h-48 w-full" />
          ) : q.error || !p ? (
            <PanelError
              className="p-0"
              message={t('privacy.retention.previewError', { error: errorMessage(q.error) })}
              onRetry={() => void q.refetch()}
            />
          ) : (
            <>
              <TableScroll className="rounded-[var(--radius-control)] border border-line">
                <Table className="min-w-[520px]">
                  <THead>
                    <tr>
                      <TH>{t('privacy.retention.colData')}</TH>
                      <TH>{t('privacy.retention.colOlderThan')}</TH>
                      <TH className="text-end">{t('privacy.retention.colInNextBatch')}</TH>
                    </tr>
                  </THead>
                  <tbody>
                    {TARGETS.map((target) => (
                      <TR key={target.key}>
                        <TD className="h-auto py-2.5">
                          <span className="block font-medium">{t(target.label)}</span>
                          <span className="text-xs text-fg-2">{t(target.what)}</span>
                        </TD>
                        <TD className="h-auto whitespace-nowrap py-2.5">
                          {target.cutoff
                            ? formatDate(p.cutoffs[target.cutoff])
                            : t('privacy.retention.expiryPassed')}
                        </TD>
                        <TD className="h-auto py-2.5 text-end tabular">
                          {formatNumber(p.targets[target.key])}
                        </TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              </TableScroll>
              <p className="text-xs text-fg-2">
                {t('privacy.retention.batchSize', { count: p.policy.batchSize })}{' '}
                {p.remainingAfterBatch
                  ? t('privacy.retention.moreRemaining')
                  : total === 0
                    ? t('privacy.retention.nothingDue')
                    : t('privacy.retention.allCovered')}
              </p>
            </>
          )}
        </section>

        {result && (
          <Banner
            tone={result.failures.length ? 'warning' : 'success'}
            title={
              result.failures.length
                ? t('privacy.retention.resultProblemsTitle')
                : t('privacy.retention.resultTitle')
            }
          >
            {t('privacy.retention.resultBody', targetCounts(result.targets))}
            {result.failures.length > 0 &&
              ` ${t('privacy.retention.resultFailures', { failures: result.failures.join(t('privacy.listSeparator')) })}`}
          </Banner>
        )}

        <p className="text-xs text-fg-2">
          {p?.legalHolds.note ?? t('privacy.retention.legalHoldFallback')}{' '}
          {t('privacy.retention.preserveHint')}
        </p>
      </CardBody>

      <ConfirmDialog
        open={confirming}
        danger
        onOpenChange={setConfirming}
        title={t('privacy.retention.confirmTitle')}
        description={
          p
            ? t('privacy.retention.confirmBody', targetCounts(p.targets))
            : t('privacy.retention.confirmBodyFallback')
        }
        confirmLabel={t('privacy.retention.deleteNow')}
        onConfirm={async () => {
          const res = await guard(
            () => api.post<RetentionReport>('/privacy/retention/run'),
            t('privacy.reauth.runRetention'),
          );
          setResult(res);
          await qc.invalidateQueries({ queryKey: privacyKeys.retention });
        }}
      />
      {dialog}
    </Card>
  );
}
