'use client';
/**
 * Email a transcript (ch. 20): only to the visitor's address on record or to the
 * agent's own verified address (the API enforces both). Shows "accepted by the
 * mail provider" separately from "delivered"; retries reuse the idempotency key
 * so a second email is never created.
 */
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, Mail, MailCheck, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Banner, Button, CheckboxField, Dialog, DialogContent, RadioGroup } from '@/components/ui';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { useSession } from '@/stores/session';
import type { VisitorProfile } from '../visitors/types';
import { visitorKeys } from '../visitors/types';
import type { TranscriptEmailJob, TranscriptEmailState } from './types';

const STATE: Record<TranscriptEmailState, { label: MessageKey; tone: 'info' | 'success' | 'danger' | 'warning'; Icon: typeof Mail; final?: boolean }> = {
  queued: { label: 'history.emailState.queued', tone: 'info', Icon: Clock },
  rendering: { label: 'history.emailState.rendering', tone: 'info', Icon: Clock },
  sending: { label: 'history.emailState.sending', tone: 'info', Icon: Mail },
  accepted: { label: 'history.emailState.accepted', tone: 'success', Icon: MailCheck },
  delivered: { label: 'history.emailState.delivered', tone: 'success', Icon: CheckCircle2, final: true },
  retrying: { label: 'history.emailState.retrying', tone: 'warning', Icon: Clock },
  failed: { label: 'history.emailState.failed', tone: 'danger', Icon: XCircle, final: true },
};

export function EmailTranscriptDialog({ open, onOpenChange, chatId, visitorId }: { open: boolean; onOpenChange: (o: boolean) => void; chatId: string; visitorId: string }) {
  const t = useT();
  const me = useSession((s) => s.me?.user ?? null);
  const perms = useSession((s) => s.permissions);
  const canInternal = perms.has('exports.internal') && perms.has('notes.view');
  const visitor = useQuery({
    queryKey: visitorKeys.profile(visitorId),
    queryFn: () => api.get<VisitorProfile>(`/visitors/${visitorId}`),
    enabled: open && perms.has('visitors.view'),
    staleTime: 30_000,
    retry: false,
  });
  const visitorEmail = visitor.data?.fields.email?.value ?? null;
  const selfEmail = me?.emailVerified ? me.email : null;
  const [to, setTo] = useState<'visitor' | 'self'>('visitor');
  const [format, setFormat] = useState<'txt' | 'pdf'>('pdf');
  const [includeInternal, setIncludeInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<TranscriptEmailJob | null>(null);
  const idem = useRef<{ sig: string; key: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setFormat('pdf');
    setIncludeInternal(false);
    setError(null);
    setJob(null);
    idem.current = null;
  }, [open]);
  useEffect(() => {
    if (open) setTo(visitorEmail ? 'visitor' : 'self');
  }, [open, visitorEmail]);

  const status = useQuery({
    queryKey: ['transcript-email', chatId, job?.id],
    queryFn: () => api.get<TranscriptEmailJob>(`/chats/${chatId}/transcript-emails/${job!.id}`),
    enabled: !!job,
    initialData: job ?? undefined,
    refetchInterval: (q) => (q.state.data && !STATE[q.state.data.state]?.final && Date.now() - Date.parse(q.state.data.createdAt) < 5 * 60_000 ? 2000 : false),
    refetchIntervalInBackground: true,
  });

  const recipient = to === 'visitor' ? visitorEmail : selfEmail;
  const internalAllowed = canInternal && to === 'self';

  const send = async () => {
    if (!recipient) return;
    setBusy(true);
    setError(null);
    const body = { recipient, format, includeInternal: internalAllowed && includeInternal };
    const sig = JSON.stringify(body);
    if (!idem.current || idem.current.sig !== sig) idem.current = { sig, key: uuid() };
    try {
      setJob(await api.post<TranscriptEmailJob>(`/chats/${chatId}/transcript-email`, body, { idempotencyKey: idem.current.key }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const s = status.data ?? job;
  const meta = s ? STATE[s.state] : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="md"
        title={t('history.email.title')}
        description={t('history.email.description')}
        footer={
          s ? (
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t('common.close')}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void send()} loading={busy} disabled={!recipient}>
                <Mail className="size-4" aria-hidden /> {t('history.email.send')}
              </Button>
            </>
          )
        }
      >
        {s && meta ? (
          <div className="flex flex-col gap-3" aria-live="polite">
            {s.duplicate && <Banner tone="info">{t('history.email.duplicate')}</Banner>}
            <Banner tone={meta.tone === 'warning' ? 'warning' : meta.tone === 'danger' ? 'danger' : meta.tone === 'success' ? 'success' : 'info'} title={t(meta.label)}>
              {s.acceptedAt && <span className="block">{t('history.email.acceptedAt', { date: formatDateTime(s.acceptedAt) })}</span>}
              {s.deliveredAt && <span className="block">{t('history.email.deliveredAt', { date: formatDateTime(s.deliveredAt) })}</span>}
              {!meta.final && <span className="block text-fg-2">{t('history.email.background')}</span>}
            </Banner>
          </div>
        ) : (
          <form
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <RadioGroup<'visitor' | 'self'>
              legend={t('history.email.recipient')}
              name="tx-recipient"
              value={to}
              onChange={setTo}
              options={[
                {
                  value: 'visitor',
                  label: visitorEmail ? t('history.email.visitorWithEmail', { email: isolate(visitorEmail) }) : t('common.visitor'),
                  description: visitor.isLoading ? t('history.email.checkingVisitor') : visitorEmail ? t('history.email.visitorHint') : t('history.email.visitorNoEmail'),
                  disabled: !visitorEmail,
                },
                {
                  value: 'self',
                  label: selfEmail ? t('history.email.meWithEmail', { email: isolate(selfEmail) }) : t('history.email.me'),
                  description: selfEmail ? t('history.email.meHint') : t('history.email.meUnverified'),
                  disabled: !selfEmail,
                },
              ]}
            />
            <RadioGroup<'txt' | 'pdf'>
              legend={t('history.export.format')}
              name="tx-format"
              value={format}
              onChange={setFormat}
              options={[
                { value: 'pdf', label: t('history.email.pdf') },
                { value: 'txt', label: t('history.email.txt') },
              ]}
            />
            {internalAllowed && <CheckboxField checked={includeInternal} onCheckedChange={(c) => setIncludeInternal(c === true)} label={t('history.export.includeNotes')} description={t('history.email.notesHint')} />}
            {error && <Banner tone="danger">{error}</Banner>}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
