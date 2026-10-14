'use client';
import { findShortcutQuery } from '@talkivio/contracts';
import { FileText, Loader2, Lock, MessageSquare, Paperclip, SendHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatPercent } from '@/lib/format';
import { cn } from '@/lib/cn';
import { realtime } from '@/lib/realtime';
import type { StaffChat } from '@/lib/types';
import { useInbox } from '@/stores/inbox';
import { useSession } from '@/stores/session';
import { cancelUpload, uploadAttachment, waitForScan, type AttachmentView } from './attachments';

type Mode = 'reply' | 'note';
const MAX_CHARS = 8000;
const PLACEHOLDER_RE = /\{\{\s*[a-z_.]+\s*\}\}/i;
/** Template token syntax shown in the unresolved-placeholder hint (literal, never translated). */
const PLACEHOLDER_TOKEN = '{{placeholder}}';
/** Key names in the send hint stay literal in every language. */
const KEY_ENTER = 'Enter';
const KEY_SHIFT_ENTER = 'Shift+Enter';
const KEY_MOD_ENTER = 'Ctrl/⌘+Enter';

interface ShortcutItem {
  id: string;
  slug: string;
  title: string;
  body: string;
}

const MAX_FILES = 5;

interface FileSlot {
  key: string;
  name: string;
  size: number;
  status: 'uploading' | 'scanning' | 'ready' | 'rejected' | 'failed';
  progress: number;
  att: AttachmentView | null;
  error: string | null;
  cancel?: () => void;
}

const draftKey = (me: string, chatId: string, mode: Mode) => `rd-draft:${me}:${chatId}:${mode}`;

function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage full or blocked: the draft lives only in memory */
  }
}

let pendingFocus: string | null = null;
/** After an explicit accept, the composer of that chat takes focus once it can be written in. */
export function focusComposerWhenReady(chatId: string): void {
  pendingFocus = chatId;
}

/**
 * Composer (ch. 12–15, 18): Reply vs private Note with separate drafts kept per
 * chat per agent in this browser, Enter-to-send preference, typing signals,
 * slash shortcuts that insert (never send), and unresolved-placeholder blocking.
 */
export function Composer({
  chat,
  canReply,
  canNote,
  disabledReason,
  compact = false,
}: {
  chat: StaffChat;
  canReply: boolean;
  canNote: boolean;
  disabledReason: string | null;
  compact?: boolean;
}) {
  const t = useT();
  const me = useSession((s) => s.agent?.agent.id ?? 'anon');
  const sendOnEnter = useSession((s) => s.agent?.preferences.sendOnEnter ?? true);
  const send = useInbox((s) => s.send);
  const [mode, setMode] = useState<Mode>(() => (canReply ? 'reply' : 'note'));
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FileSlot[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const chatSettings = useSession((s) => s.tenant?.settings.chat);
  const allowFiles = chatSettings?.allowAttachments !== false;
  const maxMb = Math.min(10, chatSettings?.maxAttachmentMb ?? 10);
  /** Canned reply inserted into this draft: recorded on send for adoption analytics (ch. 18). */
  const [inserted, setInserted] = useState<{ replyId: string; options: string[] } | null>(null);
  const [suggest, setSuggest] = useState<{
    query: string;
    start: number;
    items: ShortcutItem[];
    index: number;
    loading: boolean;
  } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const typingState = useRef<{
    active: boolean;
    lastSent: number;
    idle: ReturnType<typeof setTimeout> | null;
  }>({ active: false, lastSent: 0, idle: null });
  const listId = useId();
  const closed = chat.status === 'closed';
  const effectiveMode: Mode = !canReply && canNote ? 'note' : mode;

  // Restore the persisted mode and the draft for this chat + mode.
  useEffect(() => {
    let m: Mode = 'reply';
    try {
      m = (localStorage.getItem(`rd-composer-mode:${me}`) as Mode | null) ?? 'reply';
    } catch {
      /* default */
    }
    if (!canReply && canNote) m = 'note';
    if (!canNote) m = 'reply';
    setMode(m);
    setText(readDraft(draftKey(me, chat.id, m)));
    setSuggest(null);
    setInserted(null);
  }, [chat.id, me, canReply, canNote]);

  // Unsent uploads belong to the chat they were made for; drop them when switching chats.
  useEffect(
    () => () =>
      setFiles((list) => {
        for (const f of list) {
          f.cancel?.();
          if (f.att && f.status !== 'rejected') void cancelUpload(f.att.id);
        }
        return [];
      }),
    [chat.id],
  );

  const patchFile = (key: string, patch: Partial<FileSlot>) =>
    setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const addFiles = (picked: File[]) => {
    if (!picked.length) return;
    const room = MAX_FILES - files.length;
    if (room <= 0) return;
    const accepted = picked.slice(0, room);
    const slots: FileSlot[] = accepted.map((f) => ({
      key: `${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`,
      name: f.name,
      size: f.size,
      status: 'uploading',
      progress: 0,
      att: null,
      error: null,
    }));
    setFiles((list) => [...list, ...slots]);
    accepted.forEach((file, i) => {
      const slot = slots[i]!;
      if (file.size > maxMb * 1024 * 1024) {
        patchFile(slot.key, { status: 'rejected', error: t('inbox.composer.tooLarge', { max: maxMb }) });
        return;
      }
      void (async () => {
        try {
          const att = await uploadAttachment(chat.id, file, (p) => patchFile(slot.key, { progress: p }));
          const wait = waitForScan(att.id);
          patchFile(slot.key, { status: 'scanning', att, cancel: wait.cancel, progress: 1 });
          const done = await wait.promise;
          patchFile(
            slot.key,
            done.state === 'clean'
              ? { status: 'ready', att: done }
              : {
                  status: 'rejected',
                  att: done,
                  error: done.errorMessage ?? t('inbox.composer.scanBlocked'),
                },
          );
        } catch (e) {
          patchFile(slot.key, { status: 'failed', error: errorMessage(e, t('inbox.composer.uploadFailed')) });
        }
      })();
    });
  };

  const removeFile = (key: string) => {
    const f = files.find((x) => x.key === key);
    f?.cancel?.();
    if (f?.att && f.status !== 'rejected') void cancelUpload(f.att.id);
    setFiles((list) => list.filter((x) => x.key !== key));
  };

  // Persist the draft (debounced).
  useEffect(() => {
    const timer = setTimeout(() => writeDraft(draftKey(me, chat.id, effectiveMode), text), 300);
    return () => clearTimeout(timer);
  }, [text, me, chat.id, effectiveMode]);

  // Auto-grow between 96 and 240 px.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(240, Math.max(96, el.scrollHeight))}px`;
  }, [text]);

  const emitTyping = useCallback(
    (isTyping: boolean) => {
      const st = typingState.current;
      if (!realtime.connected) return;
      const now = Date.now();
      if (isTyping && st.active && now - st.lastSent < 2000) return;
      if (!isTyping && !st.active) return;
      st.active = isTyping;
      st.lastSent = now;
      void realtime
        .command('typing.set', { chatId: chat.id, isTyping, mode: effectiveMode })
        .catch(() => undefined);
    },
    [chat.id, effectiveMode],
  );

  const stopTyping = useCallback(() => {
    const st = typingState.current;
    if (st.idle) clearTimeout(st.idle);
    st.idle = null;
    emitTyping(false);
  }, [emitTyping]);

  useEffect(() => stopTyping, [chat.id, stopTyping]);

  const switchMode = (m: Mode) => {
    if (m === effectiveMode) return;
    writeDraft(draftKey(me, chat.id, effectiveMode), text);
    stopTyping();
    setMode(m);
    try {
      localStorage.setItem(`rd-composer-mode:${me}`, m);
    } catch {
      /* not persisted */
    }
    setText(readDraft(draftKey(me, chat.id, m)));
    area.current?.focus();
  };

  // Shortcut suggestions for "/query" at the caret.
  useEffect(() => {
    if (!suggest || suggest.loading === false) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      api
        .page<ShortcutItem>('/shortcuts', { q: suggest.query, limit: 8 }, ctrl.signal)
        .then((p) =>
          setSuggest((s) =>
            s && s.query === suggest.query
              ? { ...s, items: p.items.slice(0, 8), index: 0, loading: false }
              : s,
          ),
        )
        .catch(() => setSuggest((s) => (s ? { ...s, items: [], loading: false } : s)));
    }, 120);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [suggest?.query, suggest?.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChange = (value: string, caret: number) => {
    setText(value);
    if (!value.trim()) setInserted(null);
    const q = findShortcutQuery(value, caret);
    if (q)
      setSuggest((s) =>
        s && s.query === q.query && !s.loading
          ? { ...s, start: q.start }
          : { query: q.query, start: q.start, items: s?.items ?? [], index: 0, loading: true },
      );
    else setSuggest(null);
    if (value.trim()) {
      emitTyping(true);
      const st = typingState.current;
      if (st.idle) clearTimeout(st.idle);
      st.idle = setTimeout(() => emitTyping(false), 5000);
    } else stopTyping();
  };

  const insertShortcut = async (item: ShortcutItem) => {
    if (!suggest) return;
    let body = item.body;
    try {
      const r = await api.post<{
        replyId: string;
        text: string;
        unresolved: string[];
        canSend: boolean;
        options: string[];
      }>(`/shortcuts/${item.id}/render`, { chatId: chat.id });
      if (typeof r?.text === 'string') body = r.text;
      setInserted({ replyId: r.replyId, options: r.options ?? [] });
    } catch {
      /* fall back to the raw body; unresolved tokens stay visible and block sending */
    }
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    const next = text.slice(0, suggest.start) + body + text.slice(caret);
    setText(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = suggest.start + body.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const chars = [...text].length;
  const unresolved = PLACEHOLDER_RE.test(text);
  const blocked = closed || !!disabledReason || (effectiveMode === 'reply' ? !canReply : !canNote);
  const ready = files.filter((f) => f.status === 'ready' && f.att);

  useEffect(() => {
    if (blocked || pendingFocus !== chat.id) return;
    pendingFocus = null;
    area.current?.focus();
  }, [blocked, chat.id]);
  const filesBusy = files.some((f) => f.status === 'uploading' || f.status === 'scanning');
  const filesBroken = files.some((f) => f.status === 'rejected' || f.status === 'failed');
  const canSend =
    !blocked &&
    (!!text.trim() || ready.length > 0) &&
    chars <= MAX_CHARS &&
    !unresolved &&
    !filesBusy &&
    !filesBroken;

  const submit = () => {
    if (!canSend) return;
    const body = text.trim();
    setText('');
    writeDraft(draftKey(me, chat.id, effectiveMode), '');
    stopTyping();
    const reply = inserted;
    setInserted(null);
    const attachmentIds = ready.map((f) => f.att!.id);
    setFiles([]);
    void send(chat.id, {
      body,
      visibility: effectiveMode === 'note' ? 'internal' : 'public',
      replyId: reply?.replyId ?? null,
      options: reply?.options ?? [],
      attachmentIds,
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest && suggest.items.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggest({ ...suggest, index: (suggest.index + 1) % suggest.items.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggest({ ...suggest, index: (suggest.index - 1 + suggest.items.length) % suggest.items.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        void insertShortcut(suggest.items[suggest.index]!);
        return;
      }
    }
    if (e.key === 'Escape' && suggest) {
      e.preventDefault();
      e.stopPropagation();
      setSuggest(null);
      return;
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const modifier = e.metaKey || e.ctrlKey;
      if ((sendOnEnter && !e.shiftKey && !modifier) || (!sendOnEnter && modifier)) {
        e.preventDefault();
        submit();
      }
    }
  };

  if (closed)
    return (
      <div className="border-t border-line bg-surface-2 px-5 py-4 text-sm text-fg-2" role="status">
        {t('inbox.composer.ended')}
      </div>
    );

  const note = effectiveMode === 'note';
  return (
    <div
      className={cn(
        'relative shrink-0 border-t',
        compact ? 'px-3 pb-3 pt-2' : 'px-4 pb-4 pt-2 sm:px-5',
        note ? 'border-note-border bg-note/60' : 'border-line bg-surface',
      )}
      onDragOver={(e) => {
        if (allowFiles && !blocked && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!allowFiles || blocked || !e.dataTransfer.files.length) return;
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {suggest && (suggest.items.length > 0 || suggest.loading) && (
        <div className="absolute inset-x-4 bottom-full mb-2 overflow-hidden rounded-[var(--radius-control)] border border-line bg-surface shadow-[var(--shadow-float)] sm:inset-x-5">
          <p className="border-b border-line-subtle px-3 py-2 text-xs text-fg-2">
            {suggest.loading ? t('inbox.composer.searchingShortcuts') : t('inbox.composer.shortcutsHelp')}
          </p>
          <ul
            id={listId}
            role="listbox"
            aria-label={t('inbox.composer.suggestions')}
            className="max-h-64 overflow-y-auto p-1 scroll-thin"
          >
            {suggest.items.map((s, i) => (
              <li
                key={s.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === suggest.index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void insertShortcut(s);
                }}
                className={cn(
                  'flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2',
                  i === suggest.index && 'bg-surface-3',
                )}
              >
                <span className="text-sm">
                  <bdi className="font-mono font-medium text-primary">/{s.slug}</bdi>{' '}
                  <bdi className="text-fg">{s.title}</bdi>
                </span>
                <span className="line-clamp-1 text-xs text-fg-2" dir="auto">
                  {s.body}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div
          role="group"
          aria-label={t('inbox.composer.messageType')}
          className="inline-flex rounded-[var(--radius-control)] border border-line bg-surface p-0.5"
        >
          <button
            type="button"
            aria-pressed={!note}
            disabled={!canReply}
            onClick={() => switchMode('reply')}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
              !note ? 'bg-primary-tint text-primary-hover dark:text-primary' : 'text-fg-2 hover:text-fg',
            )}
          >
            <MessageSquare className="size-3.5" aria-hidden /> {t('inbox.composer.reply')}
          </button>
          <button
            type="button"
            aria-pressed={note}
            disabled={!canNote}
            onClick={() => switchMode('note')}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
              note ? 'bg-note text-note-fg' : 'text-fg-2 hover:text-fg',
            )}
          >
            <Lock className="size-3.5" aria-hidden /> {t('inbox.composer.note')}
          </button>
        </div>
        {note && (
          <span className="text-xs font-semibold text-note-fg">{t('inbox.composer.notePrivacy')}</span>
        )}
      </div>
      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label={t('inbox.composer.filesToSend')}>
          {files.map((f) => (
            <li
              key={f.key}
              className={cn(
                'flex min-h-11 max-w-[260px] items-center gap-2 rounded-md border bg-surface px-2.5 py-1.5 text-sm',
                f.status === 'rejected' || f.status === 'failed' ? 'border-danger' : 'border-line',
              )}
            >
              {f.status === 'uploading' || f.status === 'scanning' ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-fg-2" aria-hidden />
              ) : (
                <FileText className="size-4 shrink-0 text-fg-2" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium" dir="auto">
                  {f.name}
                </span>
                <span
                  className={cn('block text-xs', f.error ? 'text-danger' : 'text-fg-2')}
                  aria-live="polite"
                >
                  {f.status === 'uploading'
                    ? t('inbox.composer.uploading', { percent: formatPercent(f.progress) })
                    : f.status === 'scanning'
                      ? t('inbox.composer.scanning')
                      : f.status === 'ready'
                        ? formatBytes(f.size)
                        : f.error}
                </span>
              </span>
              <button
                type="button"
                onClick={() => removeFile(f.key)}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 hover:bg-surface-3 hover:text-fg"
                aria-label={t('inbox.composer.removeFile', { name: isolate(f.name) })}
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor={`composer-${chat.id}`} className="sr-only">
        {note
          ? t('inbox.composer.noteLabel')
          : t('inbox.composer.replyLabel', { name: chat.visitor.displayName })}
      </label>
      <textarea
        id={`composer-${chat.id}`}
        ref={area}
        value={text}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          stopTyping();
          setTimeout(() => setSuggest(null), 150);
        }}
        disabled={blocked}
        rows={compact ? 2 : 3}
        dir="auto"
        placeholder={
          disabledReason ??
          (note ? t('inbox.composer.notePlaceholder') : t('inbox.composer.replyPlaceholder'))
        }
        aria-describedby={`composer-help-${chat.id}`}
        aria-autocomplete="list"
        aria-controls={suggest ? listId : undefined}
        aria-activedescendant={suggest?.items.length ? `${listId}-${suggest.index}` : undefined}
        className={cn(
          'block max-h-60 w-full resize-none',
          compact ? 'min-h-16' : 'min-h-24',
          'rounded-[var(--radius-control)] border px-3 py-2.5 text-sm leading-5 text-fg placeholder:text-fg-3 focus-visible:outline-2 focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:bg-surface-3',
          note ? 'border-note-border bg-surface' : 'border-line bg-surface',
        )}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p id={`composer-help-${chat.id}`} className={cn('text-xs text-fg-2', compact && 'sr-only')}>
          {unresolved ? (
            <span className="font-medium text-warning">
              {t('inbox.composer.unresolved', { token: PLACEHOLDER_TOKEN })}
            </span>
          ) : chars > MAX_CHARS - 500 ? (
            <span className={cn('tabular', chars > MAX_CHARS && 'font-medium text-danger')}>
              {t('common.characterCount', { count: chars, max: MAX_CHARS })}
            </span>
          ) : sendOnEnter ? (
            t('inbox.composer.sendHint', { send: KEY_ENTER, newline: KEY_SHIFT_ENTER })
          ) : (
            t('inbox.composer.sendHint', { send: KEY_MOD_ENTER, newline: KEY_ENTER })
          )}
        </p>
        <div className="flex items-center gap-2">
          {allowFiles && (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept="image/jpeg,image/png,image/webp,application/pdf,text/plain,.docx,.xlsx,.pptx,.odt,.ods"
                onChange={(e) => {
                  addFiles([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => fileInput.current?.click()}
                disabled={blocked || files.length >= MAX_FILES}
                aria-label={t('inbox.composer.attachFiles', { count: MAX_FILES, size: maxMb })}
              >
                <Paperclip className="size-4" />
              </Button>
            </>
          )}
          <Button
            variant="primary"
            onClick={submit}
            disabled={!canSend}
            aria-label={note ? t('inbox.composer.addNote') : t('inbox.composer.sendReply')}
          >
            <SendHorizontal className="size-4 rtl:-scale-x-100" aria-hidden />
            {note ? t('inbox.composer.addNote') : t('inbox.composer.send')}
          </Button>
        </div>
      </div>
    </div>
  );
}
