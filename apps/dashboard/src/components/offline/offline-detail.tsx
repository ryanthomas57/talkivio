'use client';
/**
 * One offline message (ch. 23): contact details (decrypted, shown only here),
 * the message and form fields, the source chat when converted from a queue wait,
 * the email reply form (plain text, Idempotency-Key) with sent replies, and the
 * handled / needs-reply toggle guarded by the entity version.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  Link2,
  Mail,
  MailCheck,
  MailWarning,
  Phone,
  RotateCcw,
  Send,
} from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Page,
  PanelError,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { useRealtimeEvent, useResync, useScopes } from '@/hooks/use-realtime';
import { isolate, useT, type MessageKey, type Translate } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { byId, useDepartments, useSites } from '@/lib/queries';
import { useCan } from '@/stores/session';
import { OfflineStatusBadge, offlineKeys } from './shared';
import { CONVERSION_REASONS, type OfflineDetail, type OfflineEventPayload } from './types';

const MAX_REPLY = 8000;
const codePoints = (s: string) => [...s].length;

function fieldValue(t: Translate, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
  if (Array.isArray(v)) return v.map((x) => fieldValue(t, x)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function fieldLabel(k: string): string {
  const s = k.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const REPLY_STATUS: Record<string, { label: MessageKey; Icon: typeof Mail; cls: string }> = {
  pending: { label: 'offline.reply.queued', Icon: Mail, cls: 'text-fg-2' },
  queued: { label: 'offline.reply.queued', Icon: Mail, cls: 'text-fg-2' },
  sending: { label: 'offline.reply.sending', Icon: Mail, cls: 'text-fg-2' },
  accepted: { label: 'offline.reply.accepted', Icon: MailCheck, cls: 'text-success' },
  sent: { label: 'offline.reply.sent', Icon: MailCheck, cls: 'text-success' },
  delivered: { label: 'offline.reply.delivered', Icon: MailCheck, cls: 'text-success' },
  failed: { label: 'offline.reply.failed', Icon: MailWarning, cls: 'text-danger' },
  cancelled: { label: 'offline.reply.cancelled', Icon: MailWarning, cls: 'text-fg-2' },
  bounced: { label: 'offline.reply.bounced', Icon: MailWarning, cls: 'text-danger' },
};

export function OfflineDetailView({ id }: { id: string }) {
  const t = useT();
  const canView = useCan('offline.view');
  const qc = useQueryClient();
  const departments = useDepartments(canView);
  const sites = useSites(canView);
  const q = useQuery({
    queryKey: offlineKeys.detail(id),
    queryFn: () => api.get<OfflineDetail>(`/offline-submissions/${id}`),
    enabled: canView,
    retry: (n, e) => !(isApiError(e) && e.status < 500) && n < 2,
  });
  const d = q.data;

  useScopes(d ? [{ kind: 'queue', id: d.departmentId ?? 'none' }] : null);
  useRealtimeEvent<OfflineEventPayload>('offline.updated', (e) => {
    const s = e.payload?.submission;
    if (s?.id === id && (!d || s.version !== d.version)) void q.refetch();
  });
  useResync(() => void q.refetch());

  const [body, setBody] = useState('');
  const [replyError, setReplyError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);
  const idem = useRef<{ body: string; key: string } | null>(null);
  const guard = useDirtyGuard(body.trim().length > 0, { what: t('offline.detail.dirtyWhat') });

  if (!canView)
    return (
      <Page>
        <EmptyState title={t('offline.noAccessTitle')} description={t('offline.detail.noAccessBody')} />
      </Page>
    );

  const back = (
    <Link
      href="/offline-messages"
      className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-primary hover:underline"
    >
      <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
      {t('offline.detail.back')}
    </Link>
  );

  if (q.isPending) {
    return (
      <Page>
        {back}
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <Skeleton className="h-80 rounded-[var(--radius-card)]" />
          <Skeleton className="h-60 rounded-[var(--radius-card)]" />
        </div>
      </Page>
    );
  }
  if (q.error || !d) {
    const missing = isApiError(q.error) && [400, 403, 404].includes(q.error.status);
    return (
      <Page>
        {back}
        {missing ? (
          <EmptyState
            title={t('offline.detail.notFoundTitle')}
            description={t('offline.detail.notFoundBody')}
            action={
              <Button asChild variant="secondary">
                <Link href="/offline-messages">{t('offline.detail.backToList')}</Link>
              </Button>
            }
          />
        ) : (
          <Card>
            <PanelError
              message={t('offline.detail.loadFailed', { error: errorMessage(q.error) })}
              onRetry={() => void q.refetch()}
            />
          </Card>
        )}
      </Page>
    );
  }

  const erased = d.status === 'erased';
  const deptName = d.departmentId ? byId(departments.data).get(d.departmentId)?.name : undefined;
  const dept = deptName ? (
    <bdi>{deptName}</bdi>
  ) : d.departmentId ? (
    t('common.department')
  ) : (
    t('offline.noDepartment')
  );
  const site = byId(sites.data).get(d.siteId)?.name;
  const len = codePoints(body.trim());
  const fields = Object.entries(d.customFields ?? {});

  const sendReply = async () => {
    const text = body.trim();
    if (!text) return setReplyError(t('offline.detail.replyEmpty'));
    if (codePoints(text) > MAX_REPLY)
      return setReplyError(t('offline.detail.replyTooLong', { max: MAX_REPLY }));
    if (!idem.current || idem.current.body !== text) idem.current = { body: text, key: uuid() };
    setSending(true);
    setReplyError(null);
    try {
      const next = await api.post<OfflineDetail>(
        `/offline-submissions/${id}/reply`,
        { body: text },
        { idempotencyKey: idem.current.key },
      );
      qc.setQueryData(offlineKeys.detail(id), next);
      void qc.invalidateQueries({ queryKey: offlineKeys.listAll });
      setBody('');
      idem.current = null;
      setSentNote(
        d.email
          ? t('offline.detail.replyQueuedTo', { email: isolate(d.email) })
          : t('offline.detail.replyQueued'),
      );
      toast.success(t('offline.detail.replySent', { reference: isolate(d.reference) }));
    } catch (e) {
      setReplyError(isApiError(e) ? (e.field('body') ?? errorMessage(e)) : errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const setStatus = async (status: 'received' | 'handled') => {
    setStatusBusy(true);
    setStatusError(null);
    setConflict(null);
    try {
      const next = await api.patch<OfflineDetail>(`/offline-submissions/${id}`, {
        status,
        expectedVersion: d.version,
      });
      qc.setQueryData(offlineKeys.detail(id), next);
      void qc.invalidateQueries({ queryKey: offlineKeys.listAll });
      toast.success(
        status === 'handled'
          ? t('offline.detail.markedHandled', { reference: isolate(d.reference) })
          : t('offline.detail.markedReceived', { reference: isolate(d.reference) }),
      );
    } catch (e) {
      if (isApiError(e, 'VERSION_CONFLICT')) setConflict(errorMessage(e));
      else setStatusError(errorMessage(e));
    } finally {
      setStatusBusy(false);
    }
  };

  return (
    <Page>
      {guard}
      {back}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex flex-wrap items-center gap-3 text-xl">
            <span className="font-mono" dir="ltr">
              {d.reference}
            </span>
            <OfflineStatusBadge status={d.status} />
          </h1>
          <p className="text-sm text-fg-2">
            <time dateTime={d.createdAt} title={formatDateTime(d.createdAt)}>
              {t('offline.detail.received', {
                time: formatDateTime(d.createdAt),
                relative: formatRelative(d.createdAt),
              })}
            </time>{' '}
            · {dept}
            {site && (
              <>
                {' · '}
                <bdi>{site}</bdi>
              </>
            )}
          </p>
        </div>
        {!erased && (
          <div className="flex flex-col items-end gap-1">
            {d.status === 'handled' ? (
              <Button variant="secondary" onClick={() => void setStatus('received')} loading={statusBusy}>
                <RotateCcw className="size-4" aria-hidden />
                {t('offline.detail.markReceived')}
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => void setStatus('handled')} loading={statusBusy}>
                <CheckCircle2 className="size-4" aria-hidden />
                {t('offline.detail.markHandled')}
              </Button>
            )}
          </div>
        )}
      </div>

      {conflict && (
        <Banner
          tone="warning"
          title={t('offline.detail.conflictTitle')}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setConflict(null);
                void q.refetch();
              }}
            >
              {t('common.reload')}
            </Button>
          }
        >
          {t('offline.detail.conflictBody', { error: conflict })}
        </Banner>
      )}
      {statusError && (
        <Banner tone="danger">{t('offline.detail.statusFailed', { error: statusError })}</Banner>
      )}
      {erased && <Banner tone="info">{t('offline.detail.erased')}</Banner>}
      {d.status === 'handled' && d.handledAt && (
        <p className="flex items-center gap-1.5 text-sm text-fg-2">
          <CheckCircle2 className="size-4 text-success" aria-hidden />
          <time dateTime={d.handledAt} title={formatDateTime(d.handledAt)}>
            {d.handledBy
              ? t('offline.detail.handledBy', {
                  name: isolate(d.handledBy.displayName),
                  time: formatRelative(d.handledAt),
                })
              : t('offline.detail.handled', { time: formatRelative(d.handledAt) })}
          </time>
        </p>
      )}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader title={t('offline.detail.message')} />
            <CardBody className="flex flex-col gap-4">
              <p className="whitespace-pre-wrap break-anywhere text-base leading-6 text-fg" dir="auto">
                {d.message}
              </p>
              {fields.length > 0 && (
                <dl className="grid gap-x-6 gap-y-2 border-t border-line-subtle pt-4 text-sm sm:grid-cols-[180px_1fr]">
                  {fields.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="font-medium text-fg-2" dir="auto">
                        {fieldLabel(k)}
                      </dt>
                      <dd className="break-anywhere text-fg" dir="auto">
                        {fieldValue(t, v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={t('offline.detail.replyTitle')}
              description={
                d.email ? t('offline.detail.replyDescription', { email: isolate(d.email) }) : undefined
              }
            />
            <CardBody className="flex flex-col gap-4">
              {sentNote && <Banner tone="success">{sentNote}</Banner>}
              {erased ? (
                <p className="text-sm text-fg-2">{t('offline.detail.replyErased')}</p>
              ) : !d.email ? (
                <Banner tone="info">{t('offline.detail.noEmail')}</Banner>
              ) : (
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendReply();
                  }}
                >
                  <Field
                    label={t('offline.detail.yourReply')}
                    error={replyError}
                    description={t('common.characterCount', { count: len, max: MAX_REPLY })}
                  >
                    <Textarea
                      value={body}
                      onChange={(e) => {
                        setBody(e.target.value);
                        if (replyError) setReplyError(null);
                        if (sentNote) setSentNote(null);
                      }}
                      rows={6}
                      maxLength={MAX_REPLY * 2}
                      dir="auto"
                    />
                  </Field>
                  <div className="flex justify-end">
                    <Button type="submit" variant="primary" loading={sending} disabled={!body.trim()}>
                      <Send className="size-4 rtl:-scale-x-100" aria-hidden />
                      {t('offline.detail.sendReply')}
                    </Button>
                  </div>
                </form>
              )}
              <section
                aria-labelledby="replies-h"
                className="flex flex-col gap-2 border-t border-line-subtle pt-4"
              >
                <h3 id="replies-h" className="text-sm font-semibold">
                  {t('offline.detail.sentReplies', { count: d.replies.length })}
                </h3>
                {d.replies.length === 0 ? (
                  <p className="text-sm text-fg-2">{t('offline.detail.noReplies')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {d.replies.map((r) => {
                      const st = REPLY_STATUS[r.status];
                      const StatusIcon = st?.Icon ?? Mail;
                      return (
                        <li
                          key={r.id}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-control)] bg-surface-2 px-3 py-2 text-sm"
                        >
                          <span
                            className={`inline-flex items-center gap-1.5 font-medium ${st?.cls ?? 'text-fg-2'}`}
                          >
                            <StatusIcon className="size-4" aria-hidden />
                            {st ? t(st.label) : r.status}
                          </span>
                          <span className="text-fg-2">
                            <time dateTime={r.createdAt} title={formatDateTime(r.createdAt)}>
                              {t('offline.reply.sentAt', { time: formatDateTime(r.createdAt) })}
                            </time>
                            {r.acceptedAt && (
                              <> · {t('offline.reply.acceptedAgo', { time: formatRelative(r.acceptedAt) })}</>
                            )}
                          </span>
                          {r.emailText && (
                            <details className="w-full">
                              <summary className="cursor-pointer text-xs font-medium text-primary">
                                {t('offline.reply.showEmail')}
                              </summary>
                              <pre
                                dir="auto"
                                className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-anywhere rounded-md bg-surface px-3 py-2 font-sans text-sm text-fg scroll-thin"
                              >
                                {r.emailText}
                              </pre>
                            </details>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </CardBody>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader title={t('offline.detail.contact')} />
            <CardBody>
              <dl className="flex flex-col gap-3 text-sm">
                <div>
                  <dt className="text-xs font-medium text-fg-2">{t('common.name')}</dt>
                  <dd className="break-anywhere text-fg" dir={d.name ? 'auto' : undefined}>
                    {d.name || t('offline.detail.notGiven')}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-fg-2">{t('common.email')}</dt>
                  <dd className="break-anywhere">
                    {d.email ? (
                      <a
                        href={`mailto:${d.email}`}
                        className="inline-flex min-h-8 items-center gap-1.5 text-primary hover:underline"
                      >
                        <Mail className="size-4 shrink-0" aria-hidden />
                        <bdi>{d.email}</bdi>
                      </a>
                    ) : (
                      <span className="text-fg-2">{t('offline.detail.notGiven')}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-fg-2">{t('offline.detail.phone')}</dt>
                  <dd className="break-anywhere">
                    {d.phone ? (
                      <a
                        href={`tel:${d.phone.replace(/[^\d+]/g, '')}`}
                        className="inline-flex min-h-8 items-center gap-1.5 text-primary hover:underline"
                      >
                        <Phone className="size-4 shrink-0" aria-hidden />
                        <bdi dir="ltr">{d.phone}</bdi>
                      </a>
                    ) : (
                      <span className="text-fg-2">{t('offline.detail.notGiven')}</span>
                    )}
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>
          {d.sourceChatId && (
            <Card>
              <CardHeader title={t('offline.detail.sourceChat')} />
              <CardBody className="flex flex-col gap-2 text-sm">
                <p className="text-fg-2">
                  {d.conversionReason
                    ? CONVERSION_REASONS[d.conversionReason]
                      ? t(CONVERSION_REASONS[d.conversionReason]!)
                      : d.conversionReason.replace(/_/g, ' ')
                    : t('offline.detail.converted')}
                </p>
                <Link
                  href={`/inbox/${d.sourceChatId}`}
                  className="inline-flex min-h-10 items-center gap-1.5 font-medium text-primary hover:underline"
                >
                  <Link2 className="size-4" aria-hidden />
                  {t('offline.detail.openChat')}
                </Link>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}
