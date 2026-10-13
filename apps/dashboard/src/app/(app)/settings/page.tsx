'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui';
import { visibleSections } from '@/components/settings/nav';
import { useSession } from '@/stores/session';
import { useT } from '@/i18n';

/** `/settings` lands on the first section the caller may open. */
export default function SettingsIndex() {
  const t = useT();
  const router = useRouter();
  const perms = useSession((s) => s.permissions);
  const status = useSession((s) => s.status);

  useEffect(() => {
    if (status !== 'ready') return;
    const first = visibleSections(perms)[0];
    router.replace(first?.href ?? '/settings/account');
  }, [perms, status, router]);

  return (
    <div className="flex h-40 items-center justify-center">
      <Spinner label={t('pages.settings.opening')} />
    </div>
  );
}
