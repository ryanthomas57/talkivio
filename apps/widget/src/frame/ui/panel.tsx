import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { openConversation, panelView } from '../state';
import { Avatar, cls, useUi } from './common';
import { Composer } from './composer';
import { ErrorView, LoadingView, OfflineSuccess, OfflineView, PrechatForm } from './forms';
import { IconChevronDown, IconClose, IconEnd, IconFile, IconMail, IconMore, IconVolume, IconVolumeOff } from './icons';
import { Transcript, TranscriptForm } from './transcript';

type Sheet = 'end' | 'transcript' | null;
interface MenuItem {
  id: string;
  label: string;
  icon: JSX.Element;
  danger?: boolean;
  run: () => void;
}

function Menu({ items, onClose }: { items: MenuItem[]; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-menu-toggle]')) onClose(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  const onKey = (e: KeyboardEvent) => {
    const list = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? []);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = list.length;
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === 'Tab') {
      onClose(false);
    }
  };
  return (
    <div class="rd-menu" role="menu" ref={ref} onKeyDown={onKey}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          class={cls('rd-menu-item', it.danger && 'rd-menu-danger')}
          onClick={() => {
            onClose(false);
            it.run();
          }}
        >
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

function Header({ menuItems, menuOpen, setMenuOpen, menuBtn }: { menuItems: MenuItem[]; menuOpen: boolean; setMenuOpen: (v: boolean) => void; menuBtn: { current: HTMLButtonElement | null } }) {
  const { c, s, t } = useUi();
  const a = s.config.appearance;
  const conv = openConversation(s);
  const agents = conv?.agents ?? [];
  const showAgents = agents.length > 0 && (a.showAgentAvatars || a.showAgentNames);
  const title = showAgents && a.showAgentNames ? agents.map((x) => x.name).join(', ') : a.title;
  const subtitle = showAgents && a.showAgentNames ? (agents.length === 1 && agents[0].title ? `${agents[0].title} · ${a.companyName}` : a.companyName) : a.subtitle;
  const online = !!s.account?.online;
  let identity: JSX.Element;
  if (showAgents && a.showAgentAvatars) {
    identity = (
      <span class="rd-header-avatars">
        {agents.slice(0, 3).map((x) => (
          <Avatar key={x.id} name={x.name} url={x.avatarUrl} seed={x.id} size={36} />
        ))}
      </span>
    );
  } else if (a.logoUrl) {
    identity = <Avatar name={a.companyName} url={a.logoUrl} size={36} square />;
  } else {
    identity = <Avatar name={a.companyName} size={36} square seed={a.companyName} />;
  }
  return (
    <header class="rd-header">
      <div class="rd-header-id">
        {identity}
        <span class="rd-presence" data-on={online ? '' : undefined} title={online ? t('online') : t('away')} />
      </div>
      <div class="rd-header-text">
        <h2 class="rd-title" dir="auto" id="rd-title">
          {title}
        </h2>
        {subtitle && (
          <p class="rd-subtitle" dir="auto">
            <span class="rd-sr">{online ? t('online') : t('away')}. </span>
            {subtitle}
          </p>
        )}
      </div>
      <div class="rd-header-actions">
        {menuItems.length > 0 && (
          <button ref={menuBtn} type="button" class="rd-icon-btn" data-menu-toggle="" aria-label={t('more')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
            <IconMore size={20} />
          </button>
        )}
        {!s.standalone && (
          <button type="button" class="rd-icon-btn" aria-label={t('minimize')} onClick={() => c.close('button')}>
            {s.viewport.fullscreen && !s.preview ? <IconClose size={20} /> : <IconChevronDown size={20} />}
          </button>
        )}
      </div>
    </header>
  );
}

function SheetView({ kind, onClose }: { kind: Exclude<Sheet, null>; onClose: () => void }) {
  const { c, t } = useUi();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus], button')?.focus();
  }, []);
  return (
    <div
      class="rd-sheet-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {kind === 'end' ? (
        <div class="rd-sheet" role="alertdialog" aria-modal="true" aria-labelledby="rd-sheet-title" aria-describedby="rd-sheet-desc" ref={ref}>
          <h3 id="rd-sheet-title">{t('end_confirm')}</h3>
          <p id="rd-sheet-desc">{t('end_confirm_body')}</p>
          <div class="rd-sheet-actions">
            <button type="button" class="rd-btn rd-btn-secondary" data-autofocus="" onClick={onClose}>
              {t('cancel')}
            </button>
            <button
              type="button"
              class="rd-btn rd-btn-danger"
              onClick={() => {
                onClose();
                void c.endChat();
              }}
            >
              {t('end_chat')}
            </button>
          </div>
        </div>
      ) : (
        <div class="rd-sheet" role="dialog" aria-modal="true" aria-labelledby="rd-sheet-title" ref={ref}>
          <div class="rd-sheet-head">
            <h3 id="rd-sheet-title">{t('email_transcript')}</h3>
            <button type="button" class="rd-icon-btn rd-icon-btn-plain" aria-label={t('close')} onClick={onClose}>
              <IconClose size={18} />
            </button>
          </div>
          <TranscriptForm onDone={onClose} autoFocus />
        </div>
      )}
    </div>
  );
}

export function Panel({ framed = false }: { framed?: boolean }) {
  const { c, s, t } = useUi();
  const view = panelView(s);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const b = s.config.behavior;
  const conv = openConversation(s);
  const composing = view === 'welcome' || view === 'queued' || view === 'active';
  const ended = view === 'ended' || view === 'rating';

  // Focus management: composer / first field when opened by the user, otherwise the dialog itself.
  useEffect(() => {
    const root = rootRef.current;
    // Never steal focus when the panel was opened programmatically (agent message, restore).
    if (!root || framed || !s.openFocus) return;
    // On phones, focus the dialog rather than the textarea so the keyboard does not pop up.
    const target = s.viewport.compact ? null : root.querySelector<HTMLElement>('[data-autofocus]');
    (target ?? root).focus({ preventScroll: true });
  }, [view === 'loading']);

  const items: MenuItem[] = [];
  if (b.sound) {
    items.push({ id: 'sound', label: s.soundOn ? t('sound_off') : t('sound_on'), icon: s.soundOn ? <IconVolumeOff size={18} /> : <IconVolume size={18} />, run: () => c.toggleSound() });
  }
  if (b.transcripts.enabled && s.features.transcripts && s.conversation && s.messages.length) {
    items.push({ id: 'transcript', label: t('email_transcript'), icon: <IconMail size={18} />, run: () => setSheet('transcript') });
    items.push({ id: 'download', label: t('download_transcript'), icon: <IconFile size={18} />, run: () => c.downloadTranscript() });
  }
  if (conv) items.push({ id: 'end', label: t('end_chat'), icon: <IconEnd size={18} />, danger: true, run: () => setSheet('end') });

  const insets = s.viewport.fullscreen && !s.preview ? s.viewport.insets : null;
  const style: Record<string, string> = insets
    ? { '--rd-inset-top': `${insets.top}px`, '--rd-inset-bottom': `${insets.bottom}px`, paddingLeft: `${insets.left}px`, paddingRight: `${insets.right}px` }
    : {};

  let body: JSX.Element;
  switch (view) {
    case 'loading':
      body = <LoadingView />;
      break;
    case 'error':
      body = <ErrorView />;
      break;
    case 'prechat':
      body = <PrechatForm />;
      break;
    case 'offline':
      body = <OfflineView key={`${s.offline?.reason ?? 'offline'}:${s.offlineDraftRev}`} />;
      break;
    case 'offline_success':
      body = <OfflineSuccess />;
      break;
    default:
      body = <Transcript view={view} />;
  }

  const brand = s.config.appearance.showBranding;
  const reconnecting = s.sessionReady && s.connection !== 'connected' && !s.preview;
  const dropEnabled = composing && b.attachments.enabled && s.features.files;

  return (
    <div
      ref={rootRef}
      class={cls('rd-panel', framed && 'rd-panel-framed', dragging && 'rd-dragging')}
      role="dialog"
      aria-modal={s.viewport.fullscreen && !framed ? 'true' : undefined}
      aria-label={t('dialog', { name: s.config.appearance.companyName })}
      dir={t.rtl ? 'rtl' : 'ltr'}
      lang={t.locale}
      tabIndex={-1}
      style={style}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if (menuOpen) {
          setMenuOpen(false);
          menuBtn.current?.focus();
        } else if (sheet) setSheet(null);
        else if (!s.standalone) c.close('escape');
      }}
      onDragOver={(e) => {
        if (!dropEnabled || !e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.target === rootRef.current && setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (!dropEnabled || !e.dataTransfer?.files.length) return;
        e.preventDefault();
        c.sendFiles(e.dataTransfer.files);
      }}
    >
      <Header menuItems={items} menuOpen={menuOpen} setMenuOpen={setMenuOpen} menuBtn={menuBtn} />
      {menuOpen && (
        <Menu
          items={items}
          onClose={(refocus) => {
            setMenuOpen(false);
            if (refocus) menuBtn.current?.focus();
          }}
        />
      )}
      {reconnecting && (
        <div class="rd-banner" role="status">
          <span class="rd-spinner" aria-hidden="true" />
          {t('reconnecting')}
        </div>
      )}
      <div class="rd-body">
        {s.notice && (
          <div class={cls('rd-toast', s.notice.tone === 'error' && 'rd-toast-error')} role="alert">
            <span>{t(s.notice.key)}</span>
            <button type="button" class="rd-toast-x" aria-label={t('close')} onClick={() => c.clearNotice()}>
              <IconClose size={14} />
            </button>
          </div>
        )}
        {body}
        {dragging && (
          <div class="rd-dropzone" aria-hidden="true">
            {t('drop_files')}
          </div>
        )}
      </div>
      <div class="rd-foot">
        {composing && <Composer />}
        {ended && (
          <div class="rd-foot-actions">
            <button type="button" class="rd-btn rd-btn-primary rd-btn-block" onClick={() => c.newChat()}>
              {t('new_chat')}
            </button>
          </div>
        )}
        {brand && (
          <div class="rd-brand">
            {(() => {
              const [before, after] = t('powered_by', { brand: '\u0000' }).split('\u0000');
              return (
                <>
                  {before}
                  <strong>
                    <bdi>{s.brandName}</bdi>
                  </strong>
                  {after}
                </>
              );
            })()}
          </div>
        )}
      </div>
      {sheet && (
        <SheetView
          kind={sheet}
          onClose={() => {
            setSheet(null);
            menuBtn.current?.focus();
          }}
        />
      )}
    </div>
  );
}
