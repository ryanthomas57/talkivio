'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Check, Languages, LogOut, MonitorDown, Plus, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Avatar,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui';
import { isolate, LOCALE_META, LOCALES, useT, type Locale } from '@/i18n';
import { errorMessage } from '@/lib/api';
import { realtime } from '@/lib/realtime';
import { useSession } from '@/stores/session';
import { useLanguageChoice } from './language';

/** User + workspace menu: profile, tenant switching and sign out. */
export function AccountMenu() {
  const t = useT();
  const language = useLanguageChoice();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const tenant = useSession((s) => s.tenant);
  const switchTenant = useSession((s) => s.switchTenant);
  const logout = useSession((s) => s.logout);
  // Offer the desktop app only in a browser (the app's preload exposes `talkivioDesktop`).
  const [inDesktopApp, setInDesktopApp] = useState(false);
  useEffect(
    () => setInDesktopApp(!!(window as unknown as { talkivioDesktop?: unknown }).talkivioDesktop),
    [],
  );
  if (!me) return null;
  const enabled = me.memberships.filter((m) => m.enabled);

  const doSwitch = async (tenantId: string) => {
    if (tenantId === me.activeTenantId) return;
    // Close the old socket and drop every cached tenant query before the new session context loads.
    realtime.stop();
    qc.clear();
    try {
      await switchTenant(tenantId);
      router.replace('/inbox');
      realtime.start();
    } catch (e) {
      toast.error(t('shell.account.switchFailed', { error: errorMessage(e) }));
      realtime.start();
    }
  };

  const doLogout = async () => {
    realtime.stop();
    qc.clear();
    await logout().catch(() => undefined);
    router.replace('/login');
  };

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-control)] px-1.5 hover:bg-surface-3"
          aria-label={t('shell.account.menuLabel', { name: isolate(me.user.displayName) })}
        >
          <Avatar name={me.user.displayName} src={me.user.avatarUrl} size="sm" />
          <span className="hidden max-w-[160px] flex-col items-start text-start lg:flex">
            <span className="w-full truncate text-sm font-medium leading-4" dir="auto">
              {me.user.displayName}
            </span>
            <span className="w-full truncate text-xs text-fg-2" dir="auto">
              {tenant?.name}
            </span>
          </span>
        </button>
      </MenuTrigger>
      <MenuContent className="w-72">
        <div className="px-2.5 pb-2 pt-1">
          <p className="truncate text-sm font-semibold" dir="auto">
            {me.user.displayName}
          </p>
          <p className="truncate text-xs text-fg-2" dir="ltr">
            {me.user.email}
          </p>
        </div>
        <MenuSeparator />
        <MenuItem asChild icon={<UserRound />}>
          <Link href="/settings/account">{t('shell.account.profile')}</Link>
        </MenuItem>
        {!inDesktopApp && (
          <MenuItem asChild icon={<MonitorDown />}>
            <Link href="/download">{t('shell.account.desktopApp')}</Link>
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuLabel>{t('shell.account.language')}</MenuLabel>
        <MenuRadioGroup
          value={language.choice ?? 'browser'}
          onValueChange={(v) => void language.choose(v === 'browser' ? null : (v as Locale))}
        >
          <MenuRadioItem value="browser">
            <Languages className="me-2 size-4 text-fg-2" aria-hidden />
            {t('common.languageFollowBrowser')}
          </MenuRadioItem>
          {LOCALES.map((l) => (
            <MenuRadioItem key={l} value={l} lang={l} dir={LOCALE_META[l].dir}>
              {LOCALE_META[l].label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLabel>{t('shell.account.workspaces')}</MenuLabel>
        {enabled.map((m) => (
          <MenuItem key={m.tenantId} icon={<Building2 />} onSelect={() => void doSwitch(m.tenantId)}>
            <span className="min-w-0 flex-1 truncate" dir="auto">
              {m.tenantName}
            </span>
            {m.tenantId === me.activeTenantId && (
              <Check className="size-4 text-primary" aria-label={t('shell.account.currentWorkspace')} />
            )}
          </MenuItem>
        ))}
        <MenuItem asChild icon={<Plus />}>
          <Link href="/workspaces?create=1">{t('shell.account.createWorkspace')}</Link>
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<LogOut />} onSelect={() => void doLogout()}>
          {t('shell.account.signOut')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
