import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@/components/site/site.css';

/** The public website is meant to be found, unlike the product behind sign-in. */
export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

/** Marketing and legal copy is English-only, so the page direction is fixed whatever the interface locale is. */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site" lang="en" dir="ltr">
      {children}
    </div>
  );
}
