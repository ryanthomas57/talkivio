import Link from 'next/link';
import { SiteLogo } from './mark';
import { COMPANY, TRIAL_DAYS } from './site-config';
import { SiteThemeToggle } from './theme-switch';

/** Top bar for the inner pages (the home page draws its own inside the hero). */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-[var(--site-line)] bg-[var(--site-header-bg)] backdrop-blur-md">
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4 sm:px-6"
      >
        <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label="Talkivio home">
          <SiteLogo small />
        </Link>
        <div className="flex items-center gap-2 sm:gap-5">
          <SiteThemeToggle />
          <Link href="/#pricing" className="site-navlink hidden text-[13px] font-light sm:inline">
            Pricing
          </Link>
          <Link href="/download" className="site-navlink hidden text-[13px] font-light sm:inline">
            Download
          </Link>
          <Link href="/login" className="site-navlink site-tap text-[13px] font-light">
            Sign in
          </Link>
          <Link href="/signup?plan=team" className="site-pill-outline site-micro">
            Start free trial
          </Link>
        </div>
      </nav>
    </header>
  );
}

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Visitors', href: '/#product' },
      { label: 'Conversations', href: '/#conversations' },
      { label: 'Automation', href: '/#features' },
      { label: 'Security', href: '/#security' },
      { label: 'Pricing', href: '/#pricing' },
      { label: 'Desktop app', href: '/download' },
    ],
  },
  {
    title: 'Account',
    links: [
      { label: `Start ${TRIAL_DAYS}-day trial`, href: '/signup?plan=team' },
      { label: 'Sign in', href: '/login' },
      { label: 'Reset password', href: '/forgot-password' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Terms of Use', href: '/legal/terms' },
      { label: 'Privacy Policy', href: '/legal/privacy' },
      { label: 'Refund Policy', href: '/legal/refund-policy' },
    ],
  },
];

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-[var(--site-line)] px-5 pb-12 pt-14 sm:px-6 sm:pt-16">
      <div className="mx-auto grid max-w-[1200px] grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] md:gap-12">
        <div className="col-span-2 md:col-span-1">
          <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label="Talkivio home">
            <SiteLogo />
          </Link>
          <p className="mt-5 max-w-xs text-[14px] font-light leading-6 text-[var(--site-muted)]">
            Live chat and real-time visitor tracking for teams that answer every visitor.
          </p>
          <p className="mt-4 text-[14px] font-light">
            <a href={`mailto:${COMPANY.supportEmail}`} className="site-navlink site-tap">
              {COMPANY.supportEmail}
            </a>
          </p>
        </div>
        {COLUMNS.map((c) => (
          <div key={c.title}>
            <h2 className="site-micro m-0 text-[var(--site-subtle)]">{c.title}</h2>
            <ul className="mt-3 space-y-0 p-0 md:mt-5 md:space-y-3">
              {c.links.map((l) => (
                <li key={l.href} className="list-none">
                  <Link href={l.href} className="site-navlink site-tap text-[14px] font-light">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mx-auto mt-14 flex max-w-[1200px] flex-wrap items-center justify-between gap-4 border-t border-[var(--site-line)] pt-6 text-[12.5px] font-light text-[var(--site-subtle)]">
        <span>
          © {year} {COMPANY.legalName}. All rights reserved.
        </span>
        <span>
          {COMPANY.product} is a product of {COMPANY.legalName}.
        </span>
      </div>
    </footer>
  );
}
