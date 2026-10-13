'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Pencil, RefreshCw, Send, Trash2, Webhook } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { BRAND_NAME } from '@/components/brand';
import { Badge, Banner, Button, Card, CardBody, CardHeader, ConfirmDialog, Dialog, DialogContent, EmptyState, Field, Page, PageHeader, PanelError, Select, Skeleton, Switch } from '@/components/ui';
import { isolate, useT, type Translate } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { DeliveriesCard } from './deliveries';
import { isRecentAuthCancelled, useRecentAuth } from './recent-auth';
import { richT } from './rich';
import { OneTimeSecretDialog } from './secret-panel';
import { SignatureSnippet } from './signature-snippet';
import { integrationKeys, type DeliveryStatus, type WebhookDelivery, type WebhookEndpoint, type WebhookWithSecret } from './types';
import { WebhookFormDialog } from './webhook-form-dialog';
import { EndpointStateBadge } from './webhooks-panel';
import { DELIVERY_FILTERS, eventDescription, eventLabel, hostOf, SIGNATURE_HEADER } from './webhook-shared';

const BACK = '/settings/integrations?tab=webhooks';
const OVERLAPS = [0, 15, 60, 240, 1440];
const RECOMMENDED_OVERLAP = 60;

function overlapLabel(t: Translate, minutes: number): string {
  if (minutes === 0) return t('integrations.detail.overlapNone');
  if (minutes < 60) return t('integrations.detail.overlapMinutes', { count: minutes });
  return t(minutes === RECOMMENDED_OVERLAP ? 'integrations.detail.overlapHoursRecommended' : 'integrations.detail.overlapHours', { count: minutes / 60 });
}

export function WebhookDetail({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const statusParam = sp.get('status');
  const status = DELIVERY_FILTERS.some((f) => f.value && f.value === statusParam) ? (statusParam as DeliveryStatus) : null;
  const { guard, dialog } = useRecentAuth();
  // Once deleted, stop every query for this endpoint: refetching a deleted id would 404 and be
  // recorded server side as a denied probe in the audit log.
  const [deletedHost, setDeletedHost] = useState<string | null>(null);
  const q = useQuery({ queryKey: integrationKeys.webhook(id), queryFn: () => api.get<WebhookEndpoint>(`/webhooks/${id}`), enabled: !deletedHost, retry: (n, e) => !isApiError(e) || (e.status >= 500 && n < 2) });
  const w = q.data;
  const [editing, setEditing] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [secret, setSecret] = useState<WebhookWithSecret | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; conflict?: boolean } | null>(null);

  const setStatus = (s: DeliveryStatus | null) => {
    const next = new URLSearchParams(sp.toString());
    if (s) next.set('status', s);
    else next.delete('status');
    router.replace(next.toString() ? `${pathname}?${next}` : pathname, { scroll: false });
  };

  const apply = (updated: WebhookEndpoint) => {
    qc.setQueryData(integrationKeys.webhook(id), updated);
    void qc.invalidateQueries({ queryKey: integrationKeys.webhooks });
  };

  const reload = async () => {
    setActionError(null);
    await q.refetch();
  };

  const toggleEnabled = async (enabled: boolean) => {
    if (!w) return;
    setToggleBusy(true);
    setActionError(null);
    try {
      apply(await api.patch<WebhookEndpoint>(`/webhooks/${id}`, { enabled }, { ifMatch: w.version }));
      toast.success(enabled ? t('integrations.detail.enabledToast') : t('integrations.detail.disabledToast'));
    } catch (e) {
      setActionError(
        isApiError(e, 'VERSION_CONFLICT')
          ? { message: t('integrations.detail.conflict'), conflict: true }
          : { message: t(enabled ? 'integrations.detail.enableFailed' : 'integrations.detail.disableFailed', { error: errorMessage(e) }) },
      );
    } finally {
      setToggleBusy(false);
    }
  };

  const sendTest = async () => {
    setTestBusy(true);
    setActionError(null);
    try {
      const d = await api.post<WebhookDelivery>(`/webhooks/${id}/test`, {}, { idempotencyKey: uuid() });
      toast.success(t('integrations.detail.testQueued', { id: isolate(d.eventId.slice(0, 8)) }));
      await qc.invalidateQueries({ queryKey: integrationKeys.deliveriesFor(id) });
      void qc.invalidateQueries({ queryKey: integrationKeys.webhooks, exact: true }); // list shows the latest delivery
    } catch (e) {
      setActionError({ message: t('integrations.detail.testFailed', { error: errorMessage(e) }) });
    } finally {
      setTestBusy(false);
    }
  };

  if (deletedHost) {
    return (
      <Page>
        <BackLink />
        <Banner tone="success">{t('integrations.detail.deletedReturning', { host: isolate(deletedHost) })}</Banner>
      </Page>
    );
  }

  if (q.isPending) {
    return (
      <Page>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-full max-w-lg" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  }

  if (q.error || !w) {
    const missing = isApiError(q.error) && (q.error.status === 404 || q.error.status === 400 || q.error.code === 'NOT_FOUND');
    return (
      <Page>
        <BackLink />
        {missing ? (
          <Card>
            <EmptyState
              icon={<Webhook />}
              title={t('integrations.detail.notFoundTitle')}
              description={t('integrations.detail.notFoundBody')}
              action={
                <Button asChild variant="secondary">
                  <Link href={BACK}>{t('integrations.detail.backToWebhooks')}</Link>
                </Button>
              }
            />
          </Card>
        ) : (
          <Card>
            <PanelError message={t('integrations.detail.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
          </Card>
        )}
      </Page>
    );
  }

  const overlapActive = w.previousSecretExpiresAt && new Date(w.previousSecretExpiresAt).getTime() > Date.now();

  return (
    <Page>
      <BackLink />
      <PageHeader
        title={<bdi dir="ltr">{hostOf(w.url)}</bdi>}
        description={w.description ? <span dir="auto">{w.description}</span> : undefined}
        actions={
          <>
            <Button variant="secondary" onClick={() => void sendTest()} loading={testBusy}>
              <Send className="size-4" aria-hidden />
              {t('integrations.detail.sendTest')}
            </Button>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="size-4" aria-hidden />
              {t('common.edit')}
            </Button>
          </>
        }
      />

      {actionError && (
        <Banner
          tone={actionError.conflict ? 'warning' : 'danger'}
          action={
            actionError.conflict ? (
              <Button size="sm" variant="secondary" onClick={() => void reload()}>
                {t('common.reload')}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setActionError(null)}>
                {t('common.dismiss')}
              </Button>
            )
          }
        >
          {actionError.message}
        </Banner>
      )}

      <Card>
        <CardHeader title={t('integrations.detail.endpoint')} />
        <CardBody>
          <dl className="grid gap-x-8 gap-y-4 text-sm md:grid-cols-[max-content_1fr]">
            <dt className="font-medium text-fg-2">{t('integrations.detail.url')}</dt>
            <dd className="break-all font-mono" dir="ltr">
              {w.url}
            </dd>
            <dt className="font-medium text-fg-2">{t('common.status')}</dt>
            <dd className="flex flex-wrap items-center gap-3">
              <Switch id="wh-enabled" checked={w.enabled} disabled={toggleBusy} onCheckedChange={(v) => void toggleEnabled(v)} aria-describedby="wh-enabled-d" aria-label={t('integrations.detail.deliverLabel')} />
              <EndpointStateBadge endpoint={w} />
              <span id="wh-enabled-d" className="text-xs text-fg-2">
                {w.enabled ? t('integrations.detail.deliveringOn') : t('integrations.detail.deliveringOff')}
              </span>
              {w.enabled && w.failureCount > 0 && <Badge tone="warning">{t('integrations.webhooks.recentFailures', { count: w.failureCount })}</Badge>}
            </dd>
            <dt className="font-medium text-fg-2">{t('integrations.detail.events')}</dt>
            <dd className="flex flex-wrap gap-1.5">
              {w.eventTypes.map((ev) => (
                <Badge key={ev} tone="neutral" title={eventDescription(t, ev)}>
                  {eventLabel(t, ev)}
                </Badge>
              ))}
            </dd>
            <dt className="font-medium text-fg-2">{t('integrations.detail.signingSecret')}</dt>
            <dd className="flex flex-col gap-2">
              <span className="flex flex-wrap items-center gap-3">
                <code className="font-mono" dir="ltr">
                  {w.secretHint}
                </code>
                <span className="text-xs text-fg-2">{t('integrations.detail.generation', { n: w.signingGeneration })}</span>
                <Button size="sm" variant="secondary" onClick={() => setRotateOpen(true)}>
                  <RefreshCw className="size-4" aria-hidden />
                  {t('integrations.detail.rotateSecret')}
                </Button>
              </span>
              {overlapActive && (
                <span className="text-xs text-fg-2">
                  {richT(
                    t,
                    'integrations.detail.overlapUntil',
                    { time: <time dateTime={w.previousSecretExpiresAt!}>{formatDateTime(w.previousSecretExpiresAt)}</time> },
                    { relative: formatRelative(w.previousSecretExpiresAt) },
                  )}
                </span>
              )}
            </dd>
            <dt className="font-medium text-fg-2">{t('integrations.detail.lastSuccess')}</dt>
            <dd>
              {w.lastSuccessAt ? (
                <time dateTime={w.lastSuccessAt} title={formatDateTime(w.lastSuccessAt)}>
                  {formatRelative(w.lastSuccessAt)}
                </time>
              ) : (
                <span className="text-fg-2">{t('integrations.detail.noSuccessYet')}</span>
              )}
            </dd>
            <dt className="font-medium text-fg-2">{t('common.created')}</dt>
            <dd>{formatDateTime(w.createdAt)}</dd>
          </dl>
        </CardBody>
      </Card>

      <DeliveriesCard endpointId={id} status={status} onStatus={setStatus} enabled={w.enabled} />

      <SignatureSnippet />

      <Card className="border-danger/40">
        <CardHeader
          title={t('integrations.detail.deleteTitle')}
          description={t('integrations.detail.deleteBody')}
          action={
            <Button variant="danger" onClick={() => setDeleting(true)}>
              <Trash2 className="size-4" aria-hidden />
              {t('integrations.detail.deleteTitle')}
            </Button>
          }
        />
      </Card>

      <WebhookFormDialog
        open={editing}
        onOpenChange={setEditing}
        guard={guard}
        endpoint={w}
        onSaved={(u) => {
          apply(u);
          toast.success(t('integrations.detail.saved'));
        }}
        onReload={() => q.refetch()}
      />

      <RotateSecretDialog
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        host={hostOf(w.url)}
        onRotate={async (overlapMinutes) => {
          const res = await guard(
            () => api.post<WebhookWithSecret>(`/webhooks/${id}/rotate-secret`, { overlapMinutes }, { idempotencyKey: uuid() }),
            t('integrations.reauth.action.rotateWebhookSecret'),
          );
          const { secret: _s, secretShownOnce: _o, ...resource } = res;
          apply(resource);
          setSecret(res);
        }}
      />

      <ConfirmDialog
        open={deleting}
        danger
        onOpenChange={setDeleting}
        title={t('integrations.detail.deleteConfirmTitle')}
        description={richT(
          t,
          'integrations.detail.deleteConfirmBody',
          {
            url: (
              <span className="break-all font-mono text-xs" dir="ltr">
                {w.url}
              </span>
            ),
          },
          { brand: BRAND_NAME },
        )}
        confirmLabel={t('integrations.detail.deleteTitle')}
        onConfirm={async () => {
          try {
            await api.delete(`/webhooks/${id}`, { ifMatch: w.version });
          } catch (e) {
            if (isApiError(e, 'VERSION_CONFLICT')) void q.refetch();
            throw e;
          }
          const host = hostOf(w.url);
          setDeletedHost(host);
          // Drop the endpoint from the cached list right away so the list never asks for its deliveries.
          qc.setQueryData<WebhookEndpoint[]>(integrationKeys.webhooks, (list) => list?.filter((x) => x.id !== id));
          setTimeout(() => {
            qc.removeQueries({ queryKey: integrationKeys.webhook(id), exact: true });
            qc.removeQueries({ queryKey: integrationKeys.deliveriesFor(id) });
            void qc.invalidateQueries({ queryKey: integrationKeys.webhooks, exact: true });
          }, 0);
          toast.success(t('integrations.detail.deleted', { host: isolate(host) }));
          router.replace(BACK);
        }}
      />

      <OneTimeSecretDialog
        open={!!secret}
        title={t('integrations.detail.newSecretTitle')}
        description={
          secret?.previousSecretExpiresAt
            ? t('integrations.detail.newSecretOverlap', { date: formatDateTime(secret.previousSecretExpiresAt) })
            : t('integrations.detail.newSecretNoOverlap')
        }
        label={t('integrations.secret.signingSecretLabel')}
        what={t('integrations.what.signingSecret')}
        value={secret?.secret ?? null}
        onDone={() => setSecret(null)}
      />
      {dialog}
    </Page>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link href={BACK} className="inline-flex min-h-11 w-fit items-center gap-1.5 text-sm font-medium text-primary hover:underline">
      <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
      {t('integrations.detail.back')}
    </Link>
  );
}

function RotateSecretDialog({ open, onOpenChange, host, onRotate }: { open: boolean; onOpenChange: (o: boolean) => void; host: string; onRotate: (overlapMinutes: number) => Promise<void> }) {
  const t = useT();
  const [overlap, setOverlap] = useState(RECOMMENDED_OVERLAP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onRotate(overlap);
      onOpenChange(false);
    } catch (err) {
      setError(isRecentAuthCancelled(err) ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setError(null);
        onOpenChange(o);
      }}
    >
      {open && (
        <DialogContent
          size="md"
          title={t('integrations.detail.rotateTitle', { host: isolate(host) })}
          description={t('integrations.detail.rotateBody')}
          footer={
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" type="submit" form="rotate-secret-form" loading={busy}>
                <KeyRound className="size-4" aria-hidden />
                {t('integrations.detail.rotateSecret')}
              </Button>
            </>
          }
        >
          <form id="rotate-secret-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
            {error && <Banner tone="danger">{error}</Banner>}
            <Field
              label={t('integrations.detail.overlap')}
              description={overlap > 0 ? t('integrations.detail.overlapHelp', { header: isolate(`${SIGNATURE_HEADER}: v1=<new>,v1=<previous>`) }) : t('integrations.detail.overlapNoneHelp')}
            >
              <Select value={String(overlap)} onChange={(e) => setOverlap(Number(e.target.value))}>
                {OVERLAPS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {overlapLabel(t, minutes)}
                  </option>
                ))}
              </Select>
            </Field>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
