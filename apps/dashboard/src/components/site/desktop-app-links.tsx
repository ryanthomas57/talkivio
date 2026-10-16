'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppleLogo, WindowsLogo } from './os-logos';
import { DESKTOP } from './site-config';

/**
 * "Desktop app: Mac / Windows" under the hero's trial button. A click starts the download and then opens
 * /download, which says the download started and shows how to open the app the first time. Hidden inside the app.
 */
export function DesktopAppLinks({ className = '' }: { className?: string }) {
  const router = useRouter();
  const [inApp, setInApp] = useState(false);
  useEffect(() => setInApp(!!(window as unknown as { talkivioDesktop?: unknown }).talkivioDesktop), []);
  if (inApp) return null;
  // The file link starts the download (GitHub serves it as an attachment); the page change follows a moment later.
  const started = (os: 'mac' | 'windows') => () =>
    window.setTimeout(() => router.push(`/download?started=${os}`), 400);
  return (
    <div className={`site-applinks ${className}`}>
      <Link href="/download" className="site-micro site-applinks-label">
        Desktop app
      </Link>
      <a href={DESKTOP.mac} className="site-app-link" onClick={started('mac')}>
        <AppleLogo className="site-app-logo" />
        Mac
      </a>
      <a href={DESKTOP.windows} className="site-app-link" onClick={started('windows')}>
        <WindowsLogo className="site-app-logo site-app-logo-win" />
        Windows
      </a>
    </div>
  );
}
