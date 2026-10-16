'use client';
import { Download, Laptop, Monitor } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DESKTOP } from './site-config';

type Os = 'mac' | 'windows' | null;

/** The visitor's computer, to make its button the primary one (both stay available). */
function detectOs(): Os {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent}`.toLowerCase();
  if (/iphone|ipad|android/.test(p)) return null;
  if (p.includes('mac')) return 'mac';
  if (p.includes('win')) return 'windows';
  return null;
}

const PLATFORMS = [
  {
    os: 'mac' as const,
    name: 'Mac',
    icon: Laptop,
    href: DESKTOP.mac,
    requirement: DESKTOP.macRequirement,
    file: 'Talkivio-mac-universal.dmg',
  },
  {
    os: 'windows' as const,
    name: 'Windows',
    icon: Monitor,
    href: DESKTOP.windows,
    requirement: DESKTOP.windowsRequirement,
    file: 'Talkivio-win-x64.exe',
  },
];

export function DownloadButtons() {
  const [os, setOs] = useState<Os>(null);
  const [inApp, setInApp] = useState(false);
  useEffect(() => {
    setOs(detectOs());
    setInApp(!!(window as unknown as { talkivioDesktop?: unknown }).talkivioDesktop);
  }, []);
  // The detected computer first; until then (and on phones) Mac, then Windows.
  const ordered = os === 'windows' ? [...PLATFORMS].reverse() : PLATFORMS;
  return (
    <div className="mt-10">
      {inApp && (
        <p className="mb-6 text-[15px] font-light text-[var(--site-muted)]">
          You are already using the Talkivio desktop app. It updates itself.
        </p>
      )}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        {ordered.map((p) => {
          const primary = os ? os === p.os : p.os === 'mac';
          const Icon = p.icon;
          return (
            <div key={p.os} className="site-card flex flex-col gap-5 p-7 sm:p-8">
              <div className="flex items-center gap-4">
                <span className="grid size-12 place-items-center rounded-2xl border border-[var(--site-line)] text-[var(--site-teal)]">
                  <Icon className="size-6" aria-hidden />
                </span>
                <div>
                  <h2 className="m-0 text-[22px] font-normal">Talkivio for {p.name}</h2>
                  <p className="m-0 mt-1 text-[14px] font-light text-[var(--site-muted)]">{p.requirement}</p>
                </div>
              </div>
              <a
                href={p.href}
                className={`${primary ? 'site-cta' : 'site-ghost'} justify-center self-start`}
                download={p.file}
              >
                <Download className="size-4" aria-hidden />
                Download for {p.name}
              </a>
              {os === p.os && (
                <p className="m-0 text-[13px] font-light text-[var(--site-subtle)]">
                  Recommended for this computer
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
