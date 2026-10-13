'use client';
import { useCallback, useRef, useState } from 'react';
import { BRAND_NAME } from '@/components/brand';
import { Page, PageHeader, Skeleton } from '@/components/ui';
import { useDirtyGuard } from '@/hooks/use-dirty-guard';
import { useT } from '@/i18n';
import { useSession } from '@/stores/session';
import { useReauth } from '../reauth';
import { PreferencesCard } from './preferences-card';
import { EmailCard, ProfileCard } from './profile-card';
import { MfaCard, PasswordCard, SessionsCard } from './security-cards';

/** My account: profile, email, password, two-factor, sessions and preferences (ch. 07/09/14). */
export function AccountSettings() {
  const t = useT();
  const me = useSession((s) => s.me);
  const agent = useSession((s) => s.agent);
  const { guard, dialog } = useReauth();
  const [profileDirty, setProfileDirty] = useState(false);
  const [prefsDirty, setPrefsDirty] = useState(false);
  const saves = useRef<{ profile?: () => Promise<boolean>; prefs?: () => Promise<boolean> }>({});
  const registerProfile = useCallback((fn: () => Promise<boolean>) => {
    saves.current.profile = fn;
  }, []);
  const registerPrefs = useCallback((fn: () => Promise<boolean>) => {
    saves.current.prefs = fn;
  }, []);

  const guardNode = useDirtyGuard(profileDirty || prefsDirty, {
    what: t('settings.account.dirtyWhat'),
    onSave: async () => {
      let ok = true;
      if (profileDirty && saves.current.profile) ok = (await saves.current.profile()) && ok;
      if (prefsDirty && saves.current.prefs) ok = (await saves.current.prefs()) && ok;
      return ok;
    },
  });

  if (!me || !agent)
    return (
      <Page aria-busy>
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-64" />
        <Skeleton className="h-40" />
      </Page>
    );

  return (
    <Page>
      {guardNode}
      {dialog}
      <PageHeader title={t('settings.account.title')} description={t('settings.account.description', { brand: BRAND_NAME })} />
      <ProfileCard onDirtyChange={setProfileDirty} registerSave={registerProfile} />
      <EmailCard />
      <PasswordCard guard={guard} />
      <MfaCard guard={guard} />
      <SessionsCard />
      <PreferencesCard onDirtyChange={setPrefsDirty} registerSave={registerPrefs} />
    </Page>
  );
}
