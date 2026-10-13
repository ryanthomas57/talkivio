import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { serverT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t('pages.title.monitor') };
}

export default function MonitorLayout({ children }: { children: ReactNode }) {
  return children;
}
