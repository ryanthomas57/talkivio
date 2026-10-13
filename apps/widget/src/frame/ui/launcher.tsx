import { useEffect, useRef, useState } from 'preact/hooks';
import type { WidgetAppearance } from '@talkivio/contracts/protocol';
import { formatNumber } from '../i18n';
import { Avatar, cls, useUi } from './common';
import { IconChat, IconChevronDown, IconHelp, IconMessage, IconWave } from './icons';

function LauncherIcon({ a }: { a: WidgetAppearance }) {
  const [broken, setBroken] = useState(false);
  if (a.launcherIcon === 'custom' && a.launcherIconUrl && !broken) {
    return <img class="rd-launcher-img" src={a.launcherIconUrl} alt="" onError={() => setBroken(true)} referrerpolicy="no-referrer" />;
  }
  switch (a.launcherIcon) {
    case 'message':
      return <IconMessage size={24} />;
    case 'help':
      return <IconHelp size={24} />;
    case 'wave':
      return <IconWave size={24} />;
    default:
      return <IconChat size={24} />;
  }
}

export function Launcher() {
  const { c, s, t } = useUi();
  const ref = useRef<HTMLButtonElement>(null);
  const a = s.config.appearance;
  const open = s.open && !s.closing;
  const pill = a.showLauncherLabel && !!a.launcherLabel.trim() && !open;

  useEffect(() => {
    if (c.consumeFocusLauncher()) ref.current?.focus({ preventScroll: true });
  }, [c]);

  const label = open ? t('close_chat') : s.unread ? `${t('open_chat')}, ${t.plural('unread', s.unread)}` : t('open_chat');
  return (
    <button
      ref={ref}
      type="button"
      class={cls('rd-launcher', pill && 'rd-launcher-pill')}
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => (open ? c.close('button') : c.open('launcher', true))}
    >
      <span class="rd-launcher-icon">{open ? <IconChevronDown size={24} /> : <LauncherIcon a={a} />}</span>
      {pill && (
        <span class="rd-launcher-label" dir="auto">
          {a.launcherLabel}
        </span>
      )}
      {s.unread > 0 && !open && (
        <span class="rd-badge" aria-hidden="true">
          {s.unread > 9 ? `${formatNumber(t.locale, 9)}+` : formatNumber(t.locale, s.unread)}
        </span>
      )}
    </button>
  );
}

/** Invitation / proactive greeting card. Never steals focus. */
export function InvitationCard() {
  const { c, s, t } = useUi();
  const inv = s.invitation;
  if (!inv) return null;
  const company = s.config.appearance.companyName;
  const from = inv.kind === 'greeting' || !inv.authorName || inv.authorName === company ? company : `${inv.authorName} · ${company}`;
  return (
    <section class="rd-invite" dir={t.rtl ? 'rtl' : 'ltr'} lang={t.locale} role="status" aria-label={inv.kind === 'message' ? t('new_message', { name: inv.authorName }) : from}>
      <div class="rd-invite-head">
        <Avatar name={inv.authorName || company} url={inv.avatarUrl} size={24} square={inv.kind === 'greeting'} />
        <bdi class="rd-invite-from">{from}</bdi>
      </div>
      <p class="rd-invite-body" dir="auto">
        {inv.body}
      </p>
      <div class="rd-invite-actions">
        <button type="button" class="rd-btn rd-btn-primary rd-btn-sm" onClick={() => c.open('invitation', true)}>
          {inv.kind === 'message' ? t('reply') : t('start_chat')}
        </button>
        <button type="button" class="rd-btn rd-btn-ghost rd-btn-sm" onClick={() => c.dismissInvitation()}>
          {t('dismiss')}
        </button>
      </div>
    </section>
  );
}
