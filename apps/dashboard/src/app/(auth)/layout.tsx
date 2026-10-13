import type { ReactNode } from 'react';
import { BrandLockup } from '@/components/brand';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-canvas px-4 py-10 sm:py-16">
      {/* Brand ribbon colours (teal → violet): a hairline and a soft glow behind the card; decorative only. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1 [background:var(--brand-gradient)]" />
      <div aria-hidden className="pointer-events-none absolute -top-48 left-1/2 h-96 w-[48rem] max-w-[200vw] -translate-x-1/2 rounded-full opacity-[0.12] blur-3xl [background:var(--brand-gradient)] dark:opacity-[0.16]" />
      <BrandLockup className="relative mb-8" />
      <div className="relative w-full max-w-[420px]">{children}</div>
    </main>
  );
}
