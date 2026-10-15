'use client';
import { tokenizeLinks } from '@talkivio/contracts';
import { AlertCircle, Bot, Check, CheckCheck, Copy, FileText, Lock, RotateCw, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';
import { toast } from 'sonner';
import { isolate, useT, type Translate } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes, formatDateTime, formatTime } from '@/lib/format';
import type { AttachmentRef, Message } from '@/lib/types';
import type { PendingSend } from '@/stores/inbox';
import { openAttachment } from './attachments';

/** Plain text with safe links; never renders HTML (ch. 13). */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {tokenizeLinks(text).map((t, i) =>
        t.kind === 'link' ? (
          <a
            key={i}
            href={t.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="underline underline-offset-2 break-anywhere"
          >
            {t.value}
          </a>
        ) : (
          <span key={i}>{t.value}</span>
        ),
      )}
    </>
  );
}

function AttachmentTile({ a }: { a: AttachmentRef }) {
  const t = useT();
  const clean = a.state === 'clean';
  const label = t(
    clean
      ? 'inbox.attachment.download'
      : a.state === 'rejected'
        ? 'inbox.attachment.downloadBlocked'
        : 'inbox.attachment.downloadScanning',
    { name: isolate(a.name) },
  );
  return (
    <button
      type="button"
      disabled={!clean}
      onClick={() => void openAttachment(a.id)}
      className="flex min-h-11 w-full max-w-[280px] items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-2 text-start text-sm text-fg hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-70"
      aria-label={label}
    >
      <FileText className="size-5 shrink-0 text-fg-2" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" dir="auto">
          {a.name}
        </span>
        <span className="block text-xs text-fg-2">
          {clean
            ? formatBytes(a.sizeBytes)
            : a.state === 'rejected'
              ? t('inbox.attachment.blocked')
              : t('inbox.attachment.scanning')}
        </span>
      </span>
    </button>
  );
}

/** System events (joined, transferred, ended…) render as centered timeline rows. */
export function SystemRow({ m }: { m: Message }) {
  const t = useT();
  return (
    <div className="flex justify-center py-1.5">
      <p
        className="max-w-[90%] rounded-full bg-surface-3 px-3 py-1 text-center text-xs text-fg-2"
        title={formatDateTime(m.sentAt)}
      >
        <span dir="auto">{systemText(t, m)}</span>
        <span className="ms-1.5 text-fg-3">{formatTime(m.sentAt)}</span>
      </p>
    </div>
  );
}

/**
 * A system line in the agent's language and from the team's point of view, built from the event's display
 * params (ch. 29). Lines stored before params existed keep the server's text.
 */
export function systemText(t: Translate, m: Message): string {
  const ev = m.systemEvent;
  const p = ev?.params ?? {};
  const has = Object.keys(p).length > 0;
  switch (ev?.kind) {
    case 'chat.rating_requested':
      return t('inbox.event.ratingRequested');
    case 'chat.agent_joined':
      if (has)
        return p.name ? t('inbox.event.joined', { name: isolate(p.name) }) : t('inbox.event.joinedAnon');
      break;
    case 'chat.agent_left':
      if (has) return p.name ? t('inbox.event.left', { name: isolate(p.name) }) : t('inbox.event.leftAnon');
      break;
    case 'chat.transferred':
      if (p.variant === 'department' && p.department)
        return t('inbox.event.transferredDepartment', { department: p.department });
      if (p.variant === 'reconnecting') return t('inbox.event.reassigning');
      if (p.variant === 'agent')
        return p.name
          ? t('inbox.event.transferredAgent', { name: isolate(p.name) })
          : t('inbox.event.transferredAnon');
      break;
    case 'chat.visitor_left':
      return t('inbox.event.visitorLeft');
    case 'chat.visitor_returned':
      return t('inbox.event.visitorReturned');
    case 'chat.closed':
      if (p.by === 'visitor') return t('inbox.event.closedVisitor');
      if (p.by === 'agent' && p.name) return t('inbox.event.closedBy', { name: isolate(p.name) });
      if (has) return t('inbox.event.closedAuto');
      break;
  }
  return m.body ?? '';
}

export const MessageBubble = memo(function MessageBubble({
  m,
  own,
  grouped,
  readByVisitor,
  deliveredToVisitor = false,
  visitorName,
}: {
  m: Message;
  own: boolean;
  grouped: boolean;
  readByVisitor: boolean;
  deliveredToVisitor?: boolean;
  /** The visitor's current name, so a rename by the agent shows on earlier lines too. */
  visitorName?: string;
}) {
  const t = useT();
  if (m.type === 'system' || (m.sender.type === 'system' && !m.automated)) return <SystemRow m={m} />;
  const note = m.visibility === 'internal';
  const agentSide = m.sender.type !== 'visitor';
  const bubble = note
    ? 'border border-note-border bg-note text-fg'
    : agentSide
      ? own
        ? 'bg-primary text-primary-fg'
        : 'bg-primary-tint text-fg'
      : 'bg-bubble-visitor text-fg';
  return (
    <div
      className={cn(
        'group flex flex-col',
        agentSide ? 'items-end' : 'items-start',
        grouped ? 'mt-1' : 'mt-3',
      )}
    >
      {!grouped && (
        <div
          className={cn(
            'mb-1 flex items-center gap-1.5 px-1 text-xs text-fg-2',
            agentSide && 'flex-row-reverse',
          )}
        >
          <span className="font-medium text-fg" dir="auto">
            {(!agentSide && visitorName) || m.sender.displayName}
          </span>
          {m.automated && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-1.5 py-px text-[11px]">
              <Bot className="size-3" aria-hidden /> {t('inbox.message.automated')}
            </span>
          )}
          {note && (
            <span className="inline-flex items-center gap-1 rounded-full bg-note px-1.5 py-px text-[11px] font-medium text-note-fg">
              <Lock className="size-3" aria-hidden /> {t('inbox.message.privateNote')}
            </span>
          )}
          <time
            dateTime={m.sentAt}
            title={formatDateTime(m.sentAt)}
            tabIndex={0}
            className="rounded focus-visible:outline-2"
          >
            {formatTime(m.sentAt)}
          </time>
        </div>
      )}
      <div
        className={cn(
          'max-w-[min(76%,680px)] rounded-2xl px-3.5 py-2 text-sm leading-5',
          bubble,
          agentSide ? 'rounded-se-md' : 'rounded-ss-md',
        )}
      >
        {m.redacted ? (
          <p className="italic opacity-80">{t('inbox.message.redacted')}</p>
        ) : (
          <>
            {m.body && (
              <p className="whitespace-pre-wrap break-anywhere" dir="auto">
                <RichText text={m.body} />
              </p>
            )}
            {m.options.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t('inbox.message.quickReplies')}>
                {m.options.map((o) => (
                  <li
                    key={o}
                    className="rounded-full border border-current/30 px-2.5 py-0.5 text-xs"
                    dir="auto"
                  >
                    {o}
                  </li>
                ))}
              </ul>
            )}
            {m.attachments.length > 0 && (
              <div className={cn('flex flex-col gap-1.5', m.body && 'mt-2')}>
                {m.attachments.map((a) => (
                  <AttachmentTile key={a.id} a={a} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {own && !note && m.sender.type === 'agent' && (
        <span className="mt-0.5 inline-flex items-center gap-1 px-1 text-[11px] text-fg-2">
          {readByVisitor ? (
            <CheckCheck className="size-3.5 text-primary" aria-hidden />
          ) : deliveredToVisitor ? (
            <CheckCheck className="size-3.5" aria-hidden />
          ) : (
            <Check className="size-3.5" aria-hidden />
          )}
          {readByVisitor
            ? t('inbox.message.read')
            : deliveredToVisitor
              ? t('inbox.message.delivered')
              : t('inbox.message.sent')}
        </span>
      )}
    </div>
  );
});

/** What a message says: text with safe links, quick-reply options and attachments (or its redaction). */
function MessageContent({ m }: { m: Message }) {
  const t = useT();
  if (m.redacted) return <p className="italic opacity-80">{t('inbox.message.redacted')}</p>;
  return (
    <>
      {m.body && (
        <p className="whitespace-pre-wrap break-anywhere" dir="auto">
          <RichText text={m.body} />
        </p>
      )}
      {m.options.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label={t('inbox.message.quickReplies')}>
          {m.options.map((o) => (
            <li key={o} className="rounded-full border border-line px-2.5 py-0.5 text-xs" dir="auto">
              {o}
            </li>
          ))}
        </ul>
      )}
      {m.attachments.length > 0 && (
        <div className={cn('flex flex-col gap-1.5', m.body && 'mt-1.5')}>
          {m.attachments.map((a) => (
            <AttachmentTile key={a.id} a={a} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Chat-log line for docked chat windows (classic live chat): the sender's name and time on one line and the
 * text under it, no bubbles; staff names in the brand colour, notes on the note background.
 */
export const LogMessage = memo(function LogMessage({
  m,
  own,
  grouped,
  readByVisitor,
  deliveredToVisitor = false,
  visitorName,
}: {
  m: Message;
  own: boolean;
  grouped: boolean;
  readByVisitor: boolean;
  deliveredToVisitor?: boolean;
  /** The visitor's current name, so a rename by the agent shows on earlier lines too. */
  visitorName?: string;
}) {
  const t = useT();
  if (m.type === 'system' || (m.sender.type === 'system' && !m.automated))
    return (
      <p className="py-1.5 text-center text-xs text-fg-2" title={formatDateTime(m.sentAt)}>
        <span dir="auto">{systemText(t, m)}</span>
        <span className="ms-1.5 text-fg-3">{formatTime(m.sentAt)}</span>
      </p>
    );
  const note = m.visibility === 'internal';
  const staff = m.sender.type !== 'visitor';
  return (
    <div
      className={cn(
        'rounded-md px-2.5 text-sm leading-5 text-fg',
        grouped ? 'pb-1' : 'mt-2 pb-1 pt-1.5',
        note && 'bg-note',
      )}
    >
      {!grouped && (
        <div className="mb-0.5 flex items-baseline gap-2">
          <span className={cn('truncate font-semibold', staff ? 'text-primary' : 'text-fg')} dir="auto">
            {(!staff && visitorName) || m.sender.displayName}
          </span>
          {m.automated && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-fg-2">
              <Bot className="size-3" aria-hidden /> {t('inbox.message.automated')}
            </span>
          )}
          {note && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-note-fg">
              <Lock className="size-3" aria-hidden /> {t('inbox.message.privateNote')}
            </span>
          )}
          <time
            dateTime={m.sentAt}
            title={formatDateTime(m.sentAt)}
            className="ms-auto shrink-0 text-[11px] text-fg-3"
          >
            {formatTime(m.sentAt)}
          </time>
        </div>
      )}
      <MessageContent m={m} />
      {own && !note && m.sender.type === 'agent' && (
        <span className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-fg-3">
          {readByVisitor || deliveredToVisitor ? (
            <CheckCheck className={cn('size-3.5', readByVisitor && 'text-primary')} aria-hidden />
          ) : (
            <Check className="size-3.5" aria-hidden />
          )}
          {readByVisitor
            ? t('inbox.message.read')
            : deliveredToVisitor
              ? t('inbox.message.delivered')
              : t('inbox.message.sent')}
        </span>
      )}
    </div>
  );
});

/** Optimistic bubble for a send in flight or failed (ch. 13: Sending / Failed + Retry + Copy). */
export function PendingBubble({
  p,
  onRetry,
  onDiscard,
}: {
  p: PendingSend;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const note = p.visibility === 'internal';
  const failed = p.status === 'failed';
  return (
    <div className="mt-3 flex flex-col items-end">
      <div
        className={cn(
          'max-w-[min(76%,680px)] rounded-2xl rounded-se-md px-3.5 py-2 text-sm leading-5',
          note ? 'border border-note-border bg-note text-fg' : 'bg-primary text-primary-fg',
          p.status === 'sending' && 'opacity-75',
          failed && 'ring-2 ring-danger',
        )}
      >
        {p.body ? (
          <p className="whitespace-pre-wrap break-anywhere" dir="auto">
            {p.body}
          </p>
        ) : (
          <p className="whitespace-pre-wrap break-anywhere">{t('inbox.message.attachmentOnly')}</p>
        )}
      </div>
      {failed ? (
        <div
          className="mt-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-1 text-xs"
          role="alert"
        >
          <span className="inline-flex items-center gap-1 font-medium text-danger">
            <AlertCircle className="size-3.5" aria-hidden />
            {p.error ? t('inbox.pending.failedWithError', { error: p.error }) : t('inbox.pending.failed')}
          </span>
          {p.errorCode !== 'CHAT_CLOSED' && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex min-h-8 items-center gap-1 font-medium text-primary hover:underline"
            >
              <RotateCw className="size-3.5" aria-hidden /> {t('common.retry')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(p.body).then(() => {
                setCopied(true);
                toast.success(t('inbox.pending.copied'));
              });
            }}
            className="inline-flex min-h-8 items-center gap-1 font-medium text-fg-2 hover:text-fg"
          >
            <Copy className="size-3.5" aria-hidden />{' '}
            {copied ? t('common.copied') : t('inbox.pending.copyText')}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="inline-flex min-h-8 items-center gap-1 font-medium text-fg-2 hover:text-danger"
          >
            <Trash2 className="size-3.5" aria-hidden /> {t('inbox.pending.discard')}
          </button>
        </div>
      ) : (
        <span className="mt-0.5 px-1 text-[11px] text-fg-2" aria-live="polite">
          {t('inbox.pending.sending')}
        </span>
      )}
    </div>
  );
}
