'use client';
import { Banner, Button } from '@/components/ui';
import { useT } from '@/i18n';
import { ConflictBanner } from '../form-kit';

/** Banners shared by the department tabs: conflict, remote change, rebase and failures. */
export function TabAlerts({ form }: { form: { conflict: boolean; rebased: boolean; remoteChanged: boolean; message: string | null; reload: () => Promise<void>; discard: () => void } }) {
  const t = useT();
  return (
    <>
      {form.conflict && <ConflictBanner message={t('settings.departments.conflict')} onReload={form.reload} />}
      {form.remoteChanged && !form.conflict && (
        <Banner
          tone="warning"
          action={
            <Button size="sm" variant="secondary" onClick={form.discard}>
              {t('settings.hours.loadLatest')}
            </Button>
          }
        >
          {t('settings.departments.remoteChanged')}
        </Banner>
      )}
      {form.rebased && <Banner tone="info">{t('settings.departments.rebased')}</Banner>}
      {form.message && !form.conflict && <Banner tone="danger">{form.message}</Banner>}
    </>
  );
}
