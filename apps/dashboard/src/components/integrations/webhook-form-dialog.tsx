'use client';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { BRAND_NAME } from '@/components/brand';
import { Banner, Button, Checkbox, Dialog, DialogContent, Field, Input, Skeleton, Textarea } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { uuid } from '@/lib/ids';
import { isRecentAuthCancelled } from './recent-auth';
import { integrationKeys, type WebhookEndpoint, type WebhookEventTypes, type WebhookWithSecret } from './types';
import { eventDescription, eventLabel } from './webhook-shared';

/** Sample address used in the URL hint and placeholder (not copy). */
const EXAMPLE_URL = 'https://example.com/talkivio/webhooks';

type Guard = <T>(fn: () => Promise<T>, action: string) => Promise<T>;

export function useWebhookEventTypes() {
  return useQuery({ queryKey: integrationKeys.eventTypes, queryFn: () => api.get<WebhookEventTypes>('/webhooks/event-types'), staleTime: 5 * 60_000 });
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  guard: Guard;
  /** Present when editing. */
  endpoint?: WebhookEndpoint;
  onCreated?: (w: WebhookWithSecret) => void;
  onSaved?: (w: WebhookEndpoint) => void;
  /** Re-read the endpoint after a version conflict. */
  onReload?: () => Promise<unknown>;
}

export function WebhookFormDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && <WebhookForm key={props.endpoint ? `${props.endpoint.id}:${props.endpoint.version}` : 'new'} {...props} />}
    </Dialog>
  );
}

function WebhookForm({ onOpenChange, guard, endpoint, onCreated, onSaved, onReload }: Props) {
  const t = useT();
  const types = useWebhookEventTypes();
  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [events, setEvents] = useState<string[]>(endpoint?.eventTypes ?? []);
  const [description, setDescription] = useState(endpoint?.description ?? '');
  const [idemKey] = useState(uuid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [fieldErr, setFieldErr] = useState<{ url?: string; events?: string; description?: string }>({});
  const editing = !!endpoint;
  const available = types.data?.eventTypes ?? [];
  // Keep subscribed types that are no longer offered visible so they can be removed.
  const listed = [...available, ...events.filter((e) => !available.includes(e))];
  const allOn = available.length > 0 && available.every((ev) => events.includes(ev));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: typeof fieldErr = {};
    const trimmed = url.trim();
    if (!trimmed) fe.url = t('integrations.webhookForm.urlRequired');
    else {
      try {
        new URL(trimmed);
      } catch {
        fe.url = t('integrations.webhookForm.urlInvalid', { example: isolate(EXAMPLE_URL) });
      }
    }
    if (!events.length) fe.events = t('integrations.webhookForm.eventsRequired');
    if (description.trim().length > 200) fe.description = t('integrations.form.maxChars', { max: 200 });
    setFieldErr(fe);
    if (fe.url || fe.events || fe.description) return;
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      if (!endpoint) {
        const res = await guard(
          () => api.post<WebhookWithSecret>('/webhooks', { url: trimmed, eventTypes: events, description: description.trim() || null }, { idempotencyKey: idemKey }),
          t('integrations.reauth.action.addWebhook'),
        );
        onCreated?.(res);
      } else {
        const patch: Record<string, unknown> = {};
        if (trimmed !== endpoint.url) patch.url = trimmed;
        if ([...events].sort().join() !== [...endpoint.eventTypes].sort().join()) patch.eventTypes = events;
        if ((description.trim() || null) !== (endpoint.description ?? null)) patch.description = description.trim() || null;
        if (!Object.keys(patch).length) {
          onOpenChange(false);
          return;
        }
        const res = await api.patch<WebhookEndpoint>(`/webhooks/${endpoint.id}`, patch, { ifMatch: endpoint.version });
        onSaved?.(res);
      }
      onOpenChange(false);
    } catch (err) {
      if (isRecentAuthCancelled(err)) setError(err.message);
      else if (isApiError(err, 'VERSION_CONFLICT') || isApiError(err, 'PRECONDITION_FAILED')) setConflict(true);
      else if (isApiError(err)) {
        const urlErr = err.field('url');
        setFieldErr({ url: urlErr, events: err.field('event_types'), description: err.field('description') });
        if (!urlErr) setError(err.message);
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent
      size="lg"
      title={editing ? t('integrations.webhookForm.editTitle') : t('integrations.webhookForm.addTitle')}
      description={t('integrations.webhookForm.description', { brand: BRAND_NAME })}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="webhook-form" loading={busy}>
            {editing ? t('common.saveChanges') : t('integrations.webhooks.add')}
          </Button>
        </>
      }
    >
      <form id="webhook-form" onSubmit={submit} className="flex flex-col gap-5" noValidate>
        {conflict && (
          <Banner
            tone="warning"
            title={t('integrations.webhookForm.conflictTitle')}
            action={
              onReload && (
                <Button size="sm" variant="secondary" onClick={() => void onReload()}>
                  {t('common.reload')}
                </Button>
              )
            }
          >
            {t('integrations.webhookForm.conflictBody')}
          </Banner>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label={t('integrations.webhookForm.url')} required description={t('integrations.webhookForm.urlHelp')} error={fieldErr.url}>
          <Input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={EXAMPLE_URL} maxLength={2048} autoFocus autoComplete="off" spellCheck={false} dir="ltr" className="font-mono" />
        </Field>

        <fieldset className="flex flex-col gap-2" aria-describedby={fieldErr.events ? 'webhook-events-err' : undefined}>
          <legend className="text-sm font-medium text-fg">
            {t('integrations.webhookForm.events')}
            <span className="ms-0.5 text-danger" aria-hidden>
              *
            </span>
          </legend>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-fg-2">{t('integrations.webhookForm.eventsHelp')}</p>
            {available.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setEvents(allOn ? [] : [...new Set([...events, ...available])])}>
                {allOn ? t('integrations.webhookForm.clearAll') : t('integrations.webhookForm.selectAll')}
              </Button>
            )}
          </div>
          {types.isPending ? (
            <div className="flex flex-col gap-2" aria-busy>
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : types.error ? (
            <Banner
              tone="danger"
              action={
                <Button size="sm" variant="secondary" onClick={() => void types.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            >
              {t('integrations.webhookForm.typesLoadError', { error: errorMessage(types.error) })}
            </Banner>
          ) : (
            <div className="grid gap-x-4 sm:grid-cols-2">
              {listed.map((ev) => {
                const id = `wh-ev-${ev.replace(/\W/g, '-')}`;
                return (
                  <div key={ev} className="flex min-h-11 items-start gap-3 py-2">
                    <Checkbox id={id} checked={events.includes(ev)} onCheckedChange={(v) => setEvents((cur) => (v === true ? [...new Set([...cur, ev])] : cur.filter((x) => x !== ev)))} aria-describedby={`${id}-d`} className="mt-0.5" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <label htmlFor={id} className="text-sm font-medium text-fg">
                        {eventLabel(t, ev)}{' '}
                        <code className="font-mono text-xs font-normal text-fg-2" dir="ltr">
                          {ev}
                        </code>
                      </label>
                      <p id={`${id}-d`} className="text-xs text-fg-2">
                        {available.includes(ev) ? (eventDescription(t, ev) ?? t('integrations.webhookForm.eventFallback', { brand: BRAND_NAME })) : t('integrations.webhookForm.eventRetired')}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {fieldErr.events && (
            <p id="webhook-events-err" role="alert" className="text-xs font-medium text-danger">
              {fieldErr.events}
            </p>
          )}
        </fieldset>

        <Field label={t('common.description')} description={t('integrations.webhookForm.descriptionHelp')} error={fieldErr.description}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} rows={2} dir="auto" className="min-h-16" />
        </Field>
      </form>
    </DialogContent>
  );
}
