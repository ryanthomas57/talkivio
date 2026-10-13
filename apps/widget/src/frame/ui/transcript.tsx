import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { tokenizeLinks, type Rating } from '@talkivio/contracts/protocol';
import type { StringKey, Translator } from '../i18n';
import { isAgentText, openConversation, type PanelView, type UiAttachment, type UiMessage } from '../state';
import { dayKey, dayLabel, EMAIL_RE, formatBytes, formatFull, formatTime } from '../util';
import { Avatar, cls, useUi } from './common';
import { IconAlert, IconCheck, IconCheckDouble, IconClock, IconFile, IconMail, IconThumbDown, IconThumbUp } from './icons';

/** Safe link rendering: message content is never injected as HTML. */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {tokenizeLinks(text).map((tok, i) =>
        tok.kind === 'link' ? (
          <a key={i} href={tok.href} target="_blank" rel="noopener noreferrer nofollow" dir="ltr">
            {tok.value}
          </a>
        ) : (
          tok.value
        ),
      )}
    </>
  );
}

/** Scroll the transcript so a newly expanded inline form is fully visible (it sits at the end). */
function revealInTranscript(el: Element | null) {
  const scroller = el?.closest('.rd-scroll');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

const ERROR_KEYS: Record<string, StringKey> = {
  FILE_TOO_LARGE: 'file_too_large',
  FILE_TYPE: 'file_type',
  ATTACHMENTS_DISABLED: 'attachments_disabled',
  UPLOAD_FAILED: 'upload_failed',
  UPLOAD_UNAVAILABLE: 'upload_failed',
  FILE_REJECTED: 'file_rejected',
  FILE_TYPE_BLOCKED: 'file_type',
  FILE_SCAN_PENDING: 'file_pending',
  RATE_LIMITED: 'rate_limited',
};
const FINAL_FILE_ERRORS = ['FILE_TOO_LARGE', 'FILE_TYPE', 'FILE_TYPE_BLOCKED', 'FILE_REJECTED', 'ATTACHMENTS_DISABLED'];

type Item =
  | { type: 'day'; key: string; label: string }
  | { type: 'event'; key: string; m: UiMessage }
  | { type: 'group'; key: string; mine: boolean; name: string; avatar: string | null; seed: string; msgs: UiMessage[] };

function authorKey(m: UiMessage): string {
  return m.authorType === 'VISITOR' ? 'visitor' : `${m.authorType}:${m.agentId ?? m.authorName}`;
}

function buildItems(messages: UiMessage[], dayFmt: (iso: string) => string): Item[] {
  const items: Item[] = [];
  let lastDay = '';
  let group: Extract<Item, { type: 'group' }> | null = null;
  let lastAt = 0;
  for (const m of messages) {
    const day = dayKey(m.createdAt);
    if (day !== lastDay) {
      items.push({ type: 'day', key: `d-${day}`, label: dayFmt(m.createdAt) });
      lastDay = day;
      group = null;
    }
    const at = new Date(m.createdAt).getTime();
    if (m.type === 'EVENT') {
      items.push({ type: 'event', key: m.id, m });
      group = null;
      continue;
    }
    const k = authorKey(m);
    if (group && authorKey(group.msgs[0]) === k && at - lastAt < 5 * 60_000) {
      group.msgs.push(m);
    } else {
      group = { type: 'group', key: `g-${m.clientId ?? m.id}`, mine: m.authorType === 'VISITOR', name: m.authorName, avatar: m.authorAvatarUrl, seed: m.agentId ?? m.authorName, msgs: [m] };
      items.push(group);
    }
    lastAt = at;
  }
  return items;
}

function FileChip({ a, note, tone }: { a: UiAttachment; note?: string; tone?: 'error' }) {
  const { t } = useUi();
  return (
    <>
      <span class="rd-att-icon">
        <IconFile size={18} />
      </span>
      <span class="rd-att-meta">
        <bdi class="rd-att-name">{a.name}</bdi>
        <span class={cls('rd-att-size', tone === 'error' && 'rd-att-error')}>{note ?? <bdi>{formatBytes(t.locale, a.size)}</bdi>}</span>
      </span>
    </>
  );
}

/** Inline preview of a clean image through a short-lived download grant. */
function AttachmentImage({ a }: { a: UiAttachment }) {
  const { c, t } = useUi();
  const [src, setSrc] = useState<string | null>(a.url || null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (a.url || a.id.startsWith('preview-')) return;
    let live = true;
    c.attachmentUrl(a.id).then(
      (url) => live && setSrc(url),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [a.id, a.url]);
  if (failed || !src) {
    return (
      <button type="button" class="rd-att-file" onClick={() => c.openAttachment(a.id, a.name)} aria-label={t('open_image', { name: a.name })}>
        <FileChip a={a} />
      </button>
    );
  }
  return (
    <button type="button" class="rd-att-img" onClick={() => (a.url ? window.open(a.url, '_blank', 'noopener') : c.openAttachment(a.id, a.name))} aria-label={t('open_image', { name: a.name })}>
      <img src={src} alt={a.name} loading="lazy" onError={() => setFailed(true)} />
    </button>
  );
}

function Attachment({ a }: { a: UiAttachment }) {
  const { c, t } = useUi();
  const state = a.state ?? 'clean';
  if (state === 'rejected' || state === 'expired') {
    return (
      <span class="rd-att-file rd-att-blocked">
        <FileChip a={a} tone="error" note={t(a.errorCode === 'FILE_TYPE_BLOCKED' ? 'file_type' : 'file_rejected')} />
      </span>
    );
  }
  if (state !== 'clean') {
    return (
      <span class="rd-att-file">
        <FileChip a={a} note={t('scanning')} />
      </span>
    );
  }
  if (a.isImage) return <AttachmentImage a={a} />;
  return (
    <button type="button" class="rd-att-file" onClick={() => c.openAttachment(a.id, a.name)} aria-label={t('download', { name: a.name })}>
      <FileChip a={a} />
    </button>
  );
}

function Upload({ m }: { m: UiMessage }) {
  const { t } = useUi();
  const u = m.upload!;
  return (
    <div class="rd-upload">
      {u.isImage && u.previewUrl ? (
        <img class="rd-upload-thumb" src={u.previewUrl} alt="" />
      ) : (
        <span class="rd-att-icon">
          <IconFile size={18} />
        </span>
      )}
      <span class="rd-att-meta">
        <bdi class="rd-att-name">{u.name}</bdi>
        <span class="rd-att-size">
          <bdi>{formatBytes(t.locale, u.size)}</bdi>
          {m.local === 'pending' && ` · ${m.uploadPhase === 'scanning' ? t('scanning') : t('uploading')}`}
        </span>
        {m.local === 'pending' && m.uploadPhase !== 'scanning' && (
          <span class="rd-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)} aria-label={t('uploading')}>
            <span style={{ width: `${Math.max(4, Math.round(u.progress * 100))}%` }} />
          </span>
        )}
      </span>
    </div>
  );
}

function Status({ m, showSent }: { m: UiMessage; showSent: boolean }) {
  const { c, s, t } = useUi();
  if (m.local === 'failed') {
    const reason = m.errorCode && ERROR_KEYS[m.errorCode] ? t(ERROR_KEYS[m.errorCode]) : t('not_delivered');
    return (
      <div class="rd-status rd-status-failed" role="alert">
        <IconAlert size={14} />
        <span>{reason}</span>
        {!FINAL_FILE_ERRORS.includes(m.errorCode ?? '') && (
          <button type="button" onClick={() => c.retry(m.clientId!)}>
            {t('retry')}
          </button>
        )}
        <button type="button" onClick={() => c.removeMessage(m.clientId!)}>
          {t('remove')}
        </button>
      </div>
    );
  }
  if (m.local === 'pending' && !m.upload) return <div class="rd-status">{t('sending')}</div>;
  if (showSent && !m.local) {
    // Sent → Delivered (agent app received it) → Read (agent opened it; only with read receipts on).
    const r = s.receipts && s.receipts.chatId === m.conversationId ? s.receipts : null;
    const seq = m.seq ?? Infinity;
    const label = r && s.features.readReceipts && seq <= r.read ? 'read' : r && seq <= r.delivered ? 'delivered' : 'sent';
    return (
      <div class={cls('rd-status', label === 'read' && 'rd-status-read')}>
        {label === 'sent' ? <IconCheck size={13} /> : <IconCheckDouble size={14} />}
        {t(label)}
      </div>
    );
  }
  return null;
}

function Bubble({ m, showSent }: { m: UiMessage; showSent: boolean }) {
  const { t } = useUi();
  const [showTime, setShowTime] = useState(false);
  const mine = m.authorType === 'VISITOR';
  return (
    <div class={cls('rd-msg', mine ? 'rd-msg-me' : 'rd-msg-them', m.local && `rd-msg-${m.local}`, showTime && 'rd-show-time')} onClick={(e) => (e.target as HTMLElement).closest('a,button') || setShowTime((v) => !v)}>
      {m.redacted ? (
        <div class="rd-bubble rd-bubble-removed">{t('message_removed')}</div>
      ) : (
        m.body && (
          <div class="rd-bubble" dir="auto">
            <RichText text={m.body} />
          </div>
        )
      )}
      {m.attachments.map((a) => (
        <Attachment key={a.id} a={a} />
      ))}
      {m.upload && <Upload m={m} />}
      <time class="rd-time" dateTime={m.createdAt} title={formatFull(t.locale, m.createdAt)}>
        {formatTime(t.locale, m.createdAt)}
      </time>
      {mine && <Status m={m} showSent={showSent} />}
    </div>
  );
}

function Group({ g, lastVisitorId, optionsFor }: { g: Extract<Item, { type: 'group' }>; lastVisitorId: string | null; optionsFor: string | null }) {
  const { c, s, t } = useUi();
  const showAvatar = !g.mine && s.config.appearance.showAgentAvatars;
  const optMsg = g.msgs.find((m) => m.id === optionsFor);
  return (
    <div class={cls('rd-group', g.mine ? 'rd-group-me' : 'rd-group-them', showAvatar && 'rd-has-avatar')}>
      <div class="rd-sender">
        <bdi>{g.mine ? t('you') : g.name}</bdi>
      </div>
      <div class="rd-group-row">
        {showAvatar && (
          <div class="rd-group-avatar">
            <Avatar name={g.name} url={g.avatar} seed={g.seed} size={28} />
          </div>
        )}
        <div class="rd-group-msgs">
          {g.msgs.map((m) => (
            <Bubble key={m.clientId ?? m.id} m={m} showSent={m.id === lastVisitorId} />
          ))}
        </div>
      </div>
      {optMsg && (
        <div class="rd-options" role="group" aria-label={optMsg.body || t('reply')}>
          {optMsg.options.map((o) => (
            <button key={o} type="button" class="rd-option" dir="auto" onClick={() => void c.send(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Typing() {
  const { s, t } = useUi();
  const agent = s.typing[s.typing.length - 1];
  if (!agent) return null;
  return (
    <div class="rd-typing" aria-hidden="true">
      {s.config.appearance.showAgentAvatars && <Avatar name={agent.name} url={agent.avatarUrl} seed={agent.id} size={28} />}
      <div class="rd-typing-bubble">
        <span class="rd-dot" />
        <span class="rd-dot" />
        <span class="rd-dot" />
      </div>
      <span class="rd-typing-label">{s.config.appearance.showAgentNames ? t('typing', { name: agent.name }) : t('someone_typing')}</span>
    </div>
  );
}

function QueueCard() {
  const { c: ctl, s, t } = useUi();
  const c = s.conversation;
  const pos = c?.queuePosition;
  if (s.waitExceeded && c && s.waitExceeded.chatId === c.id) {
    return (
      <div class="rd-queue rd-queue-wait" role="status">
        <IconClock size={18} />
        <div>
          <p class="rd-queue-title">{t('wait_title')}</p>
          <p>{t('wait_body')}</p>
          <div class="rd-queue-actions">
            <button type="button" class="rd-btn rd-btn-secondary rd-btn-sm" onClick={() => ctl.keepWaiting()}>
              {t('keep_waiting')}
            </button>
            {s.config.behavior.offlineForm.enabled && (
              <button type="button" class="rd-btn rd-btn-primary rd-btn-sm" onClick={() => ctl.leaveQueue()}>
                {t('leave_message')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div class="rd-queue" role="status">
      <IconClock size={18} />
      <div>
        <p class="rd-queue-title">{t('waiting_title')}</p>
        <p dir="auto">{s.config.content.waitingMessage}</p>
        {s.config.behavior.showQueuePosition && typeof pos === 'number' && pos > 0 && (
          <p class="rd-queue-pos">
            <span class="rd-queue-label">{t('queue_label')}: </span>
            {pos <= 1 ? t('queue_next') : t.plural('queue_ahead', pos - 1)}
          </p>
        )}
      </div>
    </div>
  );
}

export function RatingCard() {
  const { c, s, t } = useUi();
  const conv = s.conversation!;
  const [comment, setComment] = useState(conv.ratingComment ?? '');
  const [sent, setSent] = useState(!!conv.ratingComment);
  const [busy, setBusy] = useState(false);
  const pick = (r: Rating) => {
    if (conv.rating === r) return; // ratings can be changed, not cleared
    setSent(false);
    void c.rate(r);
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!conv.rating || busy) return;
    setBusy(true);
    const ok = await c.rate(conv.rating, comment.trim());
    setBusy(false);
    if (ok) setSent(true);
  };
  const q = s.config.content.ratingPrompt;
  const formRef = useRef<HTMLFormElement>(null);
  const showForm = !!conv.rating && !sent;
  useEffect(() => {
    if (showForm) revealInTranscript(formRef.current);
  }, [showForm]);
  return (
    <section class="rd-card rd-rating" aria-label={q}>
      <p class="rd-rating-q" dir="auto">
        {q}
      </p>
      <div class="rd-rating-btns" role="group" aria-label={q}>
        <button type="button" class="rd-thumb" aria-pressed={conv.rating === 'GOOD'} onClick={() => pick('GOOD')}>
          <IconThumbUp size={18} />
          <span>{t('rating_good')}</span>
        </button>
        <button type="button" class="rd-thumb" aria-pressed={conv.rating === 'BAD'} onClick={() => pick('BAD')}>
          <IconThumbDown size={18} />
          <span>{t('rating_bad')}</span>
        </button>
      </div>
      {conv.rating && !sent && (
        <form ref={formRef} class="rd-rating-form" onSubmit={submit} noValidate>
          <label class="rd-label" for="rd-rating-comment">
            {t('comment_label')}
          </label>
          <textarea id="rd-rating-comment" class="rd-input" rows={3} maxLength={2000} dir="auto" value={comment} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} />
          <button type="submit" class="rd-btn rd-btn-secondary" disabled={busy}>
            {t('comment_send')}
          </button>
        </form>
      )}
      {conv.rating && sent && (
        <p class="rd-rating-thanks" role="status">
          <IconCheck size={16} />
          {t('rating_thanks')}
        </p>
      )}
    </section>
  );
}

export function TranscriptForm({ onDone, autoFocus }: { onDone?: () => void; autoFocus?: boolean }) {
  const { c, s, t } = useUi();
  const [email, setEmail] = useState(s.visitor?.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus({ preventScroll: true });
    revealInTranscript(inputRef.current);
  }, []);
  const submit = async (e: Event) => {
    e.preventDefault();
    const v = email.trim();
    if (!EMAIL_RE.test(v)) return setError(t('invalid_email'));
    setBusy(true);
    setError(null);
    const res = await c.emailTranscript(v);
    setBusy(false);
    if (!res.ok) return setError(res.error === 'RATE_LIMITED' ? t('rate_limited') : t('error_session'));
    setSentTo(v);
    if (onDone) setTimeout(onDone, 1600);
  };
  if (sentTo) {
    return (
      <p class="rd-rating-thanks" role="status">
        <IconCheck size={16} />
        {t('transcript_sent', { email: sentTo })}
      </p>
    );
  }
  return (
    <form class="rd-inline-form" onSubmit={submit} noValidate>
      <label class="rd-label" for="rd-transcript-email">
        {t('transcript_label')}
      </label>
      <div class="rd-inline-row">
        <input
          ref={inputRef}
          id="rd-transcript-email"
          class="rd-input"
          type="email"
          autocomplete="email"
          inputMode="email"
          dir="ltr"
          value={email}
          aria-invalid={!!error}
          aria-describedby={error ? 'rd-transcript-err' : undefined}
          data-autofocus={autoFocus ? '' : undefined}
          onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="rd-btn rd-btn-primary" disabled={busy}>
          {t('send')}
        </button>
      </div>
      {error && (
        <p id="rd-transcript-err" class="rd-field-error">
          <IconAlert size={14} />
          {error}
        </p>
      )}
    </form>
  );
}

function EndedCard() {
  const { c, s, t } = useUi();
  const [transcript, setTranscript] = useState(false);
  const b = s.config.behavior;
  return (
    <div class="rd-ended">
      <div class="rd-ended-line">
        <span dir="auto">{s.config.content.chatEndedMessage}</span>
      </div>
      {b.ratings.enabled && <RatingCard />}
      {b.transcripts.enabled &&
        s.features.transcripts &&
        (transcript ? (
          <div class="rd-card">
            <TranscriptForm autoFocus />
          </div>
        ) : (
          <div class="rd-ended-actions">
            <button type="button" class="rd-btn rd-btn-ghost rd-btn-sm" onClick={() => setTranscript(true)}>
              <IconMail size={16} />
              {t('email_transcript')}
            </button>
            <button type="button" class="rd-btn rd-btn-ghost rd-btn-sm" onClick={() => c.downloadTranscript()}>
              <IconFile size={16} />
              {t('download_transcript')}
            </button>
          </div>
        ))}
    </div>
  );
}

/** Intro block: the welcome message from the company. */
function Intro() {
  const { s } = useUi();
  const a = s.config.appearance;
  const welcome = s.config.content.welcomeMessage.trim();
  if (!welcome) return null;
  return (
    <div class={cls('rd-group rd-group-them', a.showAgentAvatars && 'rd-has-avatar')}>
      <div class="rd-sender">
        <bdi>{a.companyName}</bdi>
      </div>
      <div class="rd-group-row">
        {a.showAgentAvatars && (
          <div class="rd-group-avatar">
            <Avatar name={a.companyName} url={a.logoUrl} size={28} square />
          </div>
        )}
        <div class="rd-group-msgs">
          <div class="rd-msg rd-msg-them">
            <div class="rd-bubble" dir="auto">
              <RichText text={welcome} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Transcript({ view }: { view: PanelView }) {
  const { s, t } = useUi();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const conv = s.conversation;
  const messages: UiMessage[] = conv || !s.proactive.length ? s.messages : [...s.proactive, ...s.messages];
  const items = buildItems(messages, (iso) => dayLabel(t, iso));

  let lastVisitorId: string | null = null;
  let optionsFor: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.authorType === 'VISITOR') {
      if (!lastVisitorId && !m.local) lastVisitorId = m.id;
      break;
    }
    if (!optionsFor && isAgentText(m) && m.options.length) optionsFor = m.id;
  }
  if (view === 'ended' || view === 'rating') optionsFor = null;
  const ratingAfter = s.ratingRequested && s.config.behavior.ratings.enabled && openConversation(s) ? [...messages].reverse().find((m) => m.event?.kind === 'chat.rating_requested')?.id : null;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      class="rd-scroll"
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current!;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
      }}
    >
      {/* The log is not a live region: opening the widget or restoring history is silent (A11Y02). */}
      <p class="rd-sr" aria-live="polite" aria-atomic="true" data-announcer="">
        {s.announcement ? `${t('new_message', { name: s.announcement.name })}: ${s.announcement.text}${s.announcement.n % 2 ? '' : '\u00a0'}` : ''}
      </p>
      <div class="rd-log" role="log" aria-live="off" aria-label={t('conversation')}>
        <Intro />
        {items.map((it) => {
          if (it.type === 'day') {
            return (
              <div key={it.key} class="rd-day" role="separator">
                <span>{it.label}</span>
              </div>
            );
          }
          if (it.type === 'event') {
            return (
              <div key={it.key}>
                <p class="rd-event">
                  <span dir="auto">{eventText(t, it.m)}</span>
                  <span aria-hidden="true"> · </span>
                  <time dateTime={it.m.createdAt}>{formatTime(t.locale, it.m.createdAt)}</time>
                </p>
                {it.m.id === ratingAfter && <RatingCard />}
              </div>
            );
          }
          return <Group key={it.key} g={it} lastVisitorId={lastVisitorId} optionsFor={optionsFor} />;
        })}
      </div>
      <Typing />
      {view === 'queued' && <QueueCard />}
      {(view === 'ended' || view === 'rating') && <EndedCard />}
    </div>
  );
}

/**
 * A system line in the visitor's language, from the event's display params (ch. 29). Lines stored before
 * params existed keep the server's text.
 */
export function eventText(t: Translator, m: UiMessage): string {
  const ev = m.event;
  const p = ev?.params ?? {};
  const has = Object.keys(p).length > 0;
  switch (ev?.kind) {
    case 'chat.rating_requested':
      return t('event_rate');
    case 'chat.agent_joined':
      if (has) return p.name ? t('event_joined', { name: p.name }) : t('event_joined_anon');
      break;
    case 'chat.agent_left':
      if (has) return p.name ? t('event_left', { name: p.name }) : t('event_left_anon');
      break;
    case 'chat.transferred':
      if (p.variant === 'department' && p.department) return t('event_transferred_to', { department: p.department });
      if (p.variant === 'reconnecting') return t('event_reconnecting');
      if (p.variant === 'agent') return p.name ? t('event_now_chatting', { name: p.name }) : t('event_another_agent');
      break;
    case 'chat.closed':
      if (p.by === 'visitor') return t('event_closed_you');
      if (p.by === 'agent' && p.name) return t('event_closed_by', { name: p.name });
      if (has) return t('event_closed');
      break;
  }
  return m.body ?? '';
}
