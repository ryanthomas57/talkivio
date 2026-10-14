import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useUi } from './common';
import { IconClip, IconSend, IconSmile } from './icons';

export const EMOJI = [
  '😀',
  '😃',
  '😄',
  '😁',
  '😆',
  '😅',
  '😂',
  '🙂',
  '😉',
  '😊',
  '😍',
  '🥰',
  '😘',
  '😎',
  '🤩',
  '🤔',
  '🤨',
  '😐',
  '😴',
  '😕',
  '😟',
  '😢',
  '😭',
  '😤',
  '😡',
  '😱',
  '🤯',
  '🥳',
  '😇',
  '🙃',
  '🤗',
  '🤝',
  '👍',
  '👎',
  '👏',
  '🙌',
  '🙏',
  '💪',
  '👋',
  '👀',
  '❤️',
  '🔥',
  '✨',
  '🎉',
  '✅',
  '❌',
  '💡',
  '☕',
];
const COLS = 7;

function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const { t } = useUi();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const away = (e: PointerEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest('[data-emoji-toggle]')
      )
        onClose();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  const onKey = (e: KeyboardEvent) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const rtl = getComputedStyle(ref.current!).direction === 'rtl';
    const step: Record<string, number> = {
      ArrowRight: rtl ? -1 : 1,
      ArrowLeft: rtl ? 1 : -1,
      ArrowDown: COLS,
      ArrowUp: -COLS,
    };
    if (e.key in step && i >= 0) {
      e.preventDefault();
      buttons[Math.max(0, Math.min(buttons.length - 1, i + step[e.key]))]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div class="rd-emoji" role="dialog" aria-label={t('emoji_picker')} ref={ref} onKeyDown={onKey}>
      {EMOJI.map((em) => (
        <button key={em} type="button" tabIndex={-1} aria-label={em} onClick={() => onPick(em)}>
          {em}
        </button>
      ))}
    </div>
  );
}

export function Composer() {
  const { c, s, t } = useUi();
  const [text, setText] = useState(c.draft);
  const [emoji, setEmoji] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const emojiBtn = useRef<HTMLButtonElement>(null);
  // Files can be attached whenever the visitor can write; one sent before a chat exists starts the chat.
  const attachments = s.config.behavior.attachments.enabled && s.features.files;

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 122)}px`;
  }, [text]);

  // Roving tabindex for the emoji grid: only the first button is tabbable.
  useEffect(() => {
    if (!emoji) return;
    const first = document.querySelector<HTMLButtonElement>('.rd-emoji button');
    if (first) first.tabIndex = 0;
  }, [emoji]);

  const update = (v: string) => {
    setText(v);
    c.draft = v;
    c.typing(v);
  };
  const submit = (e?: Event) => {
    e?.preventDefault();
    if (!text.trim()) return;
    void c.send(text);
    setText('');
    c.draft = '';
    ta.current?.focus();
  };
  const insert = (em: string) => {
    const el = ta.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + em + text.slice(end);
    update(next);
    setEmoji(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + em.length, start + em.length);
    });
  };
  const closeEmoji = () => {
    setEmoji(false);
    emojiBtn.current?.focus();
  };

  return (
    <form class="rd-composer" onSubmit={submit} noValidate>
      <textarea
        ref={ta}
        id="rd-input"
        class="rd-textarea"
        rows={1}
        dir="auto"
        maxLength={5000}
        enterkeyhint="send"
        aria-label={t('message_label')}
        placeholder={s.config.content.inputPlaceholder}
        value={text}
        data-autofocus=""
        onInput={(e) => update((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) submit(e);
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files ?? []);
          if (files.length && attachments) {
            e.preventDefault();
            c.sendFiles(files);
          }
        }}
      />
      <div class="rd-composer-bar">
        <div class="rd-tools">
          <button
            ref={emojiBtn}
            type="button"
            class="rd-tool"
            data-emoji-toggle=""
            aria-label={t('emoji')}
            aria-expanded={emoji}
            aria-haspopup="dialog"
            onClick={() => setEmoji((v) => !v)}
          >
            <IconSmile size={20} />
          </button>
          {attachments && (
            <button
              type="button"
              class="rd-tool"
              aria-label={t('attach')}
              onClick={() => file.current?.click()}
            >
              <IconClip size={20} />
            </button>
          )}
          {attachments && (
            <input
              ref={file}
              type="file"
              multiple
              hidden
              tabIndex={-1}
              onChange={(e) => {
                const input = e.target as HTMLInputElement;
                if (input.files?.length) c.sendFiles(input.files);
                input.value = '';
              }}
            />
          )}
        </div>
        <button type="submit" class="rd-send" aria-label={t('send_message')} disabled={!text.trim()}>
          <IconSend size={18} />
        </button>
      </div>
      {emoji && <EmojiPicker onPick={insert} onClose={closeEmoji} />}
    </form>
  );
}
