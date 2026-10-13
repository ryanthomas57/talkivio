'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, RotateCw, ShieldCheck, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Banner, Button, ConfirmDialog, Dialog, DrawerContent, Field, Input, PanelError, Select, Skeleton, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { BRAND_NAME } from '@/components/brand';
import { isRecentAuthCancelled, useRecentAuth } from '@/components/integrations/recent-auth';
import { richT } from '@/components/integrations/rich';
import { isolate, useT, type MessageKey, type Translate } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { useAgents } from '@/lib/queries';
import { useSession } from '@/stores/session';
import { humanize, KindBadge, PrivacyStateBadge, ProgressBar, subjectLabel, useFallbackPoll, useListedSubject, useVisitorLabel } from './privacy-shared';
import { ACTIVE_STATES, privacyKeys, type PrivacyRequest } from './types';

const METHODS: ReadonlyArray<{ value: string; label: MessageKey }> = [
  { value: 'verified_identity', label: 'privacy.method.verifiedIdentity' },
  { value: 'email_confirmation', label: 'privacy.method.emailConfirmation' },
  { value: 'account_login', label: 'privacy.method.accountLogin' },
  { value: 'document_check', label: 'privacy.method.documentCheck' },
  { value: 'other', label: 'privacy.method.other' },
];

const POLICY_VALUES: Record<string, MessageKey> = {
  subject_chats: 'privacy.policy.subjectChats',
  subject_messages: 'privacy.policy.subjectMessages',
  retained: 'privacy.policy.retained',
};

const DOWNSTREAM: Record<string, MessageKey> = {
  not_configured: 'privacy.downstream.notConfigured',
  no_mapped_records: 'privacy.downstream.noMappedRecords',
  pending_manual: 'privacy.downstream.pendingManual',
  accepted: 'privacy.downstream.accepted',
  confirmed: 'privacy.downstream.confirmed',
  failed: 'privacy.downstream.failed',
};

/** The privacy.erased webhook event type (a protocol code, shown as-is). */
const ERASED_EVENT = 'privacy.erased';

function methodLabel(t: Translate, method: string): string {
  const m = METHODS.find((x) => x.value === method);
  return m ? t(m.label) : method;
}

export function RequestDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      {id && <DrawerBody id={id} />}
    </Dialog>
  );
}

function DrawerBody({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  // Each job step arrives as privacy.updated (patched into this query by the page's usePrivacyLive); polling is a slow fallback.
  const fallbackPollMs = useFallbackPoll();
  const q = useQuery({
    queryKey: privacyKeys.detail(id),
    queryFn: () => api.get<PrivacyRequest>(`/privacy/requests/${id}`),
    refetchInterval: (query) => fallbackPollMs(!!query.state.data && ACTIVE_STATES.has(query.state.data.state), 15_000),
  });
  const r = q.data;
  // The list already resolved the subject; look it up only when the request isn't listed (e.g. a deep link past a filter).
  const listed = useListedSubject(id);
  const looked = useVisitorLabel(listed ? null : (r?.visitorId ?? null));
  const subject = listed ? { label: subjectLabel(t, r?.visitorId ?? null, listed), loading: false } : looked;
  // After an erasure completes the visitor keeps only an anonymous label; refresh the cached name.
  const erasedVisitor = r && r.kind === 'erase' && r.state === 'completed' ? r.visitorId : null;
  useEffect(() => {
    if (erasedVisitor) void qc.invalidateQueries({ queryKey: privacyKeys.visitor(erasedVisitor) });
  }, [erasedVisitor, qc]);

  return (
    <DrawerContent
      title={r ? t('privacy.drawer.title', { kind: r.kind, subject: isolate(subject.label) }) : t('privacy.drawer.titleFallback')}
      description={r ? t('privacy.drawer.createdAt', { date: formatDateTime(r.createdAt) }) : undefined}
      width={600}
    >
      {q.isPending ? (
        <div className="flex flex-col gap-3 p-5" aria-busy>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : q.error || !r ? (
        <PanelError message={t('privacy.drawer.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
      ) : (
        <RequestBody r={r} subject={subject.label} />
      )}
    </DrawerContent>
  );
}

function RequestBody({ r, subject }: { r: PrivacyRequest; subject: string }) {
  const t = useT();
  const qc = useQueryClient();
  const meId = useSession((s) => s.me?.user.id);
  const agents = useAgents();
  const byUser = new Map((agents.data ?? []).map((a) => [a.userId, a.displayName]));
  const { guard, dialog } = useRecentAuth();
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const report = r.report ?? {};
  const counts = Object.entries(report.counts ?? {}).filter(([, n]) => typeof n === 'number');
  const person = (uid: string | null | undefined) => (!uid ? t('privacy.person.system') : uid === meId ? t('privacy.person.you') : (byUser.get(uid) ?? t('privacy.person.former')));

  const resume = async () => {
    setResuming(true);
    setResumeError(null);
    try {
      const updated = await guard(() => api.post<PrivacyRequest>(`/privacy/requests/${r.id}/resume`), t('privacy.reauth.resume'));
      qc.setQueryData(privacyKeys.detail(r.id), updated);
      void qc.invalidateQueries({ queryKey: privacyKeys.all });
      toast.success(t('privacy.drawer.resumed'));
    } catch (e) {
      setResumeError(isRecentAuthCancelled(e) ? e.message : t('privacy.drawer.resumeFailed', { error: errorMessage(e) }));
    } finally {
      setResuming(false);
    }
  };

  const exportInfo = report.export;
  const exportExpired = exportInfo ? new Date(exportInfo.expiresAt).getTime() < Date.now() : false;
  const progressValue = r.state === 'completed' ? 100 : (r.job?.progress ?? null);

  return (
    <div className="flex flex-col gap-6 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind={r.kind} />
        <PrivacyStateBadge state={r.state} />
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-fg-2">{t('privacy.drawer.subject')}</dt>
        <dd className="font-medium" dir="auto">
          {subject}
        </dd>
        <dt className="text-fg-2">{t('privacy.drawer.requestedBy')}</dt>
        <dd dir="auto">{person(r.requestedBy)}</dd>
        <dt className="text-fg-2">{t('privacy.drawer.evidence')}</dt>
        <dd>{r.hasProof ? t('privacy.drawer.evidenceRecorded') : t('privacy.drawer.evidenceCleared')}</dd>
        {r.verifiedAt && (
          <>
            <dt className="text-fg-2">{t('privacy.drawer.verified')}</dt>
            <dd>
              {formatDateTime(r.verifiedAt)}
              {report.verification ? ` · ${methodLabel(t, report.verification.method)}` : ''}
            </dd>
          </>
        )}
        {r.completedAt && (
          <>
            <dt className="text-fg-2">{t('privacy.drawer.completed')}</dt>
            <dd>{formatDateTime(r.completedAt)}</dd>
          </>
        )}
        <dt className="text-fg-2">{t('privacy.drawer.requestId')}</dt>
        <dd className="break-all font-mono text-xs" dir="ltr">
          {r.id}
        </dd>
      </dl>

      {r.state === 'pending_verification' && <VerifyStep r={r} subject={subject} guard={guard} onDone={(u) => qc.setQueryData(privacyKeys.detail(r.id), u)} />}

      {(ACTIVE_STATES.has(r.state) || r.state === 'completed' || (r.state === 'failed' && r.job)) && (
        <section aria-labelledby="pr-progress" className="flex flex-col gap-2">
          <h3 id="pr-progress" className="text-sm font-semibold">
            {t('privacy.drawer.progress')}
          </h3>
          <ProgressBar value={progressValue} label={t('privacy.drawer.progressLabel', { kind: r.kind })} />
          <p className="text-xs text-fg-2" aria-live="polite">
            {r.state === 'queued'
              ? r.job?.errorCode
                ? t('privacy.drawer.waitingRetry', { error: humanize(t, r.job.errorCode), attempt: r.job.attempts })
                : t('privacy.drawer.waitingWorker')
              : r.state === 'running'
                ? report.progress?.totalSteps
                  ? t('privacy.drawer.runningStep', { step: humanize(t, report.progress?.step ?? 'started'), done: report.progress.completedSteps ?? 0, total: report.progress.totalSteps })
                  : t('privacy.drawer.running', { step: humanize(t, report.progress?.step ?? 'started') })
                : r.state === 'completed'
                  ? t('privacy.drawer.finished', { relative: formatRelative(r.completedAt) })
                  : t('privacy.drawer.stoppedAfter', { count: r.job?.attempts ?? 0 })}
          </p>
        </section>
      )}

      {r.state === 'failed' && (
        <Banner
          tone="danger"
          title={t('privacy.drawer.failedTitle')}
          action={
            <Button size="sm" variant="secondary" onClick={() => void resume()} loading={resuming}>
              <RotateCw className="size-4" aria-hidden />
              {t('privacy.drawer.resume')}
            </Button>
          }
        >
          {report.errorCode ? `${t('privacy.drawer.failedReason', { reason: humanize(t, report.errorCode) })} ` : ''}
          {report.failedTargets?.length ? `${t('privacy.drawer.failedTargets', { targets: report.failedTargets.map((k) => humanize(t, k)).join(t('privacy.listSeparator')) })} ` : ''}
          {t('privacy.drawer.failedHint')}
        </Banner>
      )}
      {resumeError && <Banner tone="danger">{resumeError}</Banner>}

      {counts.length > 0 && (
        <section aria-labelledby="pr-counts" className="flex flex-col gap-2">
          <h3 id="pr-counts" className="text-sm font-semibold">
            {r.kind === 'erase' ? t('privacy.drawer.countsErase') : t('privacy.drawer.countsAccess')}
          </h3>
          <TableScroll className="rounded-[var(--radius-control)] border border-line">
            <Table>
              <THead>
                <tr>
                  <TH>{r.kind === 'erase' ? t('privacy.drawer.colStore') : t('privacy.drawer.colData')}</TH>
                  <TH className="text-end">{r.kind === 'erase' ? t('privacy.drawer.colRowsChanged') : t('privacy.drawer.colItems')}</TH>
                </tr>
              </THead>
              <tbody>
                {counts.map(([k, n]) => (
                  <TR key={k}>
                    <TD className="h-10">{humanize(t, k)}</TD>
                    <TD className="h-10 text-end tabular">{formatNumber(n)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </section>
      )}

      {report.stores && report.stores.length > 0 && (
        <section aria-labelledby="pr-stores" className="flex flex-col gap-2">
          <h3 id="pr-stores" className="text-sm font-semibold">
            {t('privacy.drawer.storeConfirmations')}
          </h3>
          <ul className="flex flex-col gap-2">
            {report.stores.map((s) => (
              <li key={s.store} className="flex items-start gap-2 text-sm">
                {s.status === 'confirmed' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}
                <span>
                  {richT(t, s.status === 'confirmed' ? 'privacy.drawer.storeConfirmed' : 'privacy.drawer.storeNotConfirmed', { store: <span className="font-medium">{humanize(t, s.store)}</span> })}
                  <span className="block text-xs text-fg-2" dir="auto">
                    {s.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.kind === 'access' && r.state === 'completed' && exportInfo && (
        <section aria-labelledby="pr-export" className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-line p-4">
          <h3 id="pr-export" className="text-sm font-semibold">
            {t('privacy.kind.access')}
          </h3>
          <p className="text-sm text-fg-2">
            {[
              t('privacy.drawer.exportFile', { size: formatBytes(exportInfo.sizeBytes) }),
              exportInfo.includesStaffNotes ? t('privacy.drawer.exportNotesIncluded') : t('privacy.drawer.exportNotesExcluded'),
              t(exportExpired ? 'privacy.drawer.exportExpiredAt' : 'privacy.drawer.exportAvailableUntil', { date: formatDateTime(exportInfo.expiresAt) }),
              t('privacy.drawer.exportAudited'),
            ].join(' ')}
          </p>
          {exportInfo.sha256 && (
            <p className="break-all text-xs text-fg-2">
              {richT(t, 'privacy.drawer.sha256', {
                hash: (
                  <code className="font-mono" dir="ltr">
                    {exportInfo.sha256}
                  </code>
                ),
              })}
            </p>
          )}
          {exportExpired ? (
            <Banner tone="warning">{t('privacy.drawer.exportExpired')}</Banner>
          ) : (
            <Button asChild variant="primary" className="w-fit">
              <a href={api.url(`/privacy/requests/${r.id}/export`)} download={`subject-access-${r.id}.json`}>
                <Download className="size-4" aria-hidden />
                {t('privacy.drawer.downloadExport')}
              </a>
            </Button>
          )}
        </section>
      )}

      {r.kind === 'erase' && r.state === 'completed' && (
        <section aria-labelledby="pr-outcome" className="flex flex-col gap-2">
          <h3 id="pr-outcome" className="text-sm font-semibold">
            {t('privacy.drawer.whatWasKept')}
          </h3>
          {report.policy && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
              {Object.entries(report.policy).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-fg-2">{humanize(t, k)}</dt>
                  <dd>{typeof v === 'string' ? (POLICY_VALUES[v] ? t(POLICY_VALUES[v]!) : humanize(t, v)) : String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {report.downstream && report.downstream.length > 0 && (
            <>
              <h4 className="pt-2 text-sm font-medium">{t('privacy.drawer.connectedTools')}</h4>
              <ul className="flex flex-col gap-1 text-sm">
                {report.downstream.map((d) => (
                  <li key={d.provider}>
                    <bdi className="font-medium">{d.provider}</bdi>: {DOWNSTREAM[d.status] ? t(DOWNSTREAM[d.status]!) : d.status}
                    {d.detail ? (
                      <span className="block text-xs text-fg-2" dir="auto">
                        {d.detail}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
          {report.webhookNotification && (
            <p className="text-sm text-fg-2">{t(report.webhookNotification === 'queued' ? 'privacy.drawer.webhookQueued' : 'privacy.drawer.webhookNone', { event: isolate(ERASED_EVENT) })}</p>
          )}
          {report.legalHold && (
            <p className="text-sm text-fg-2" dir="auto">
              {report.legalHold.note}
            </p>
          )}
        </section>
      )}
      {dialog}
    </div>
  );
}

type Guard = <T>(fn: () => Promise<T>, action: string) => Promise<T>;

function VerifyStep({ r, subject, guard, onDone }: { r: PrivacyRequest; subject: string; guard: Guard; onDone: (u: PrivacyRequest) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [method, setMethod] = useState<string>('verified_identity');
  const [proof, setProof] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    const updated = await guard(
      () => api.post<PrivacyRequest>(`/privacy/requests/${r.id}/verify`, { method, proofReference: proof.trim() || undefined }),
      r.kind === 'erase' ? t('privacy.reauth.startErasure') : t('privacy.reauth.startExport'),
    );
    onDone(updated);
    void qc.invalidateQueries({ queryKey: privacyKeys.all });
    toast.success(r.kind === 'erase' ? t('privacy.verify.erasureStarted') : t('privacy.verify.exportStarted'));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (proof.trim().length > 200) {
      setError(t('privacy.verify.evidenceTooLong', { max: 200 }));
      return;
    }
    setConfirming(true);
  };

  return (
    <section aria-labelledby="pr-verify" className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-warning/40 bg-warning-tint/40 p-4">
      <h3 id="pr-verify" className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-4 text-warning" aria-hidden />
        {t('privacy.verify.title')}
      </h3>
      <p className="text-sm text-fg-2">{t('privacy.verify.body', { kind: r.kind, subject: isolate(subject) })}</p>
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label={t('privacy.verify.method')} required>
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {t(m.label)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('privacy.verify.updatedEvidence')} description={t('privacy.verify.updatedEvidenceHelp')}>
          <Input value={proof} onChange={(e) => setProof(e.target.value)} maxLength={200} autoComplete="off" dir="auto" />
        </Field>
        <Button type="submit" variant={r.kind === 'erase' ? 'danger' : 'primary'} className="w-fit" loading={busy}>
          {r.kind === 'erase' ? t('privacy.verify.submitErase') : t('privacy.verify.submitExport')}
        </Button>
      </form>
      <ConfirmDialog
        open={confirming}
        danger={r.kind === 'erase'}
        onOpenChange={setConfirming}
        title={r.kind === 'erase' ? t('privacy.verify.confirmEraseTitle', { subject: isolate(subject) }) : t('privacy.verify.confirmExportTitle', { subject: isolate(subject) })}
        description={
          r.kind === 'erase'
            ? t('privacy.verify.confirmEraseBody', { subject: isolate(subject) })
            : t('privacy.verify.confirmExportBody', { subject: isolate(subject), brand: BRAND_NAME })
        }
        confirmLabel={r.kind === 'erase' ? t('privacy.verify.confirmErase') : t('privacy.verify.confirmExport')}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await run();
          } finally {
            setBusy(false);
          }
        }}
      />
    </section>
  );
}
