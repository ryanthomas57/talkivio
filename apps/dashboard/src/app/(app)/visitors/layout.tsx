import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { serverT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t('pages.title.visitors') };
}

export default function VisitorsLayout({ children }: { children: ReactNode }) {
  return children;
}
