'use client';
import Link from 'next/link';
import { BrandLockup } from '@/components/brand';
import { Button } from '@/components/ui';
import { useT } from '@/i18n';

/** Any unknown address: a real page with a main landmark (the global skip link targets #main) and a way back. */
export default function NotFound() {
  const t = useT();
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-canvas px-4 py-10 text-center">
      <BrandLockup />
      <div className="flex max-w-[420px] flex-col items-center gap-2">
        <h1 className="text-xl font-semibold text-fg">{t('pages.notFound.title')}</h1>
        <p className="text-sm text-fg-2">{t('pages.notFound.body')}</p>
      </div>
      <Button asChild variant="primary">
        <Link href="/inbox">{t('pages.notFound.home')}</Link>
      </Button>
    </main>
  );
}
