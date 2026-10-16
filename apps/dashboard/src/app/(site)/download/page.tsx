import { Bell, BellRing, Download, Power, RefreshCw, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from '@/components/site/chrome';
import { DownloadButtons } from '@/components/site/download-buttons';
import { pageMetadata } from '@/components/site/seo';
import { DESKTOP } from '@/components/site/site-config';

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    title: 'Download Talkivio for Mac and Windows | Talkivio',
    description:
      'The Talkivio desktop app for Mac and Windows: chat and visitor alerts with your browser closed, unread counts on the app icon, and it updates itself.',
    path: '/download',
  });
}

const FEATURES = [
  {
    icon: BellRing,
    title: 'Alerts with the browser closed',
    body: 'Close the window and Talkivio keeps running in your menu bar or taskbar, so new chats, messages and visitors still reach you.',
  },
  {
    icon: Bell,
    title: 'Unread count on the icon',
    body: 'Waiting chats and unread messages show on the Dock or taskbar icon, which bounces or flashes when something new arrives.',
  },
  {
    icon: Download,
    title: 'Native notifications and sounds',
    body: 'System notifications and the alert sound you picked for each kind of activity, every time, without a click first.',
  },
  {
    icon: Power,
    title: 'Opens with your computer',
    body: 'Turn on Open at Login and Talkivio starts quietly in the background when you sign in to your Mac or PC.',
  },
  {
    icon: RefreshCw,
    title: 'Always up to date',
    body: 'It is the same dashboard you use on the web, and the app itself checks for updates in the background.',
  },
  {
    icon: ShieldCheck,
    title: 'Same account, same security',
    body: 'Sign in with your Talkivio email and password (and your authenticator code if you use two-step sign-in).',
  },
];

export default function DownloadPage() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section className="site-section !pb-16 !pt-20 sm:!pt-24">
          <div className="site-wrap">
            <span className="site-micro site-kicker">Desktop app</span>
            <h1 className="site-h2">
              Talkivio for <em>Mac</em> and <em>Windows</em>
            </h1>
            <p className="site-lead">
              Every chat and visitor alert, even with your browser closed. The desktop app keeps your team
              signed in, puts unread chats on its icon and runs quietly in the background.
            </p>
            <DownloadButtons />
            <p className="mt-6 text-[13px] font-light text-[var(--site-subtle)]">
              Free with every Talkivio plan.{' '}
              <a href={DESKTOP.releaseNotes} className="site-navlink underline underline-offset-4">
                Release notes
              </a>
              {' · '}
              <Link href="/signup?plan=team" className="site-navlink underline underline-offset-4">
                No account yet? Start a free trial
              </Link>
            </p>
          </div>
        </section>

        <section className="site-section !py-16" aria-labelledby="desktop-features">
          <div className="site-wrap">
            <h2 id="desktop-features" className="m-0 text-[26px] font-light">
              What the app adds
            </h2>
            <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => {
                const Icon = f.icon;
                return (
                  <div key={f.title} className="site-card p-6">
                    <Icon className="size-5 text-[var(--site-teal)]" aria-hidden />
                    <h3 className="m-0 mt-4 text-[17px] font-normal">{f.title}</h3>
                    <p className="m-0 mt-2 text-[14.5px] font-light leading-6 text-[var(--site-muted)]">
                      {f.body}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="site-section !pb-24 !pt-8" aria-labelledby="desktop-install">
          <div className="site-wrap grid grid-cols-1 gap-5 md:grid-cols-2">
            <h2 id="desktop-install" className="m-0 text-[26px] font-light md:col-span-2">
              Installing
            </h2>
            <div className="site-card p-6">
              <h3 className="m-0 text-[17px] font-normal">Mac</h3>
              <ol className="m-0 mt-3 list-decimal space-y-2 pl-5 text-[14.5px] font-light leading-6 text-[var(--site-muted)]">
                <li>Open the downloaded file and drag Talkivio into Applications.</li>
                <li>Open Talkivio from Applications or Launchpad and sign in.</li>
                {!DESKTOP.signed && (
                  <li>
                    The first time, if macOS says it cannot check Talkivio, open System Settings, then Privacy
                    &amp; Security, and click Open Anyway. You only do this once.
                  </li>
                )}
              </ol>
            </div>
            <div className="site-card p-6">
              <h3 className="m-0 text-[17px] font-normal">Windows</h3>
              <ol className="m-0 mt-3 list-decimal space-y-2 pl-5 text-[14.5px] font-light leading-6 text-[var(--site-muted)]">
                <li>Run the downloaded installer. It installs for your user, no administrator needed.</li>
                <li>
                  Talkivio opens when it is done; sign in. It also adds Start menu and desktop shortcuts.
                </li>
                {!DESKTOP.signed && (
                  <li>
                    If Windows shows &quot;Windows protected your PC&quot;, click More info, then Run anyway.
                    You only do this once.
                  </li>
                )}
              </ol>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
