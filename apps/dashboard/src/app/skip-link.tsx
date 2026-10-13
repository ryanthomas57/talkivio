'use client';
import { useT } from '@/i18n';

export function SkipToContent() {
  const t = useT();
  return (
    <a href="#main" className="sr-only-focusable fixed start-2 top-2 z-[100] rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-[var(--shadow-float)]">
      {t('common.skipToContent')}
    </a>
  );
}
