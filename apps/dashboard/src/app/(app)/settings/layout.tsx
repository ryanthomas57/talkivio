'use client';
import type { ReactNode } from 'react';
import { SettingsNav } from '@/components/settings/settings-nav';

/** Settings area: permission-gated secondary navigation beside (≥ 1024 px) or above the section. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      <SettingsNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
