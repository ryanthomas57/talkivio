'use client';
import { Loader2, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConnectionState } from '@/hooks/use-realtime';
import { cn } from '@/lib/cn';
import { useT } from '@/i18n';

/**
 * Persistent connection banner (ch. 06/13): connecting, reconnecting and offline
 * are always visible; "live" is announced briefly after a recovery, then hides.
 */
export function ConnectionBanner() {
  const t = useT();
  const state = useConnectionState();
  const [recovered, setRecovered] = useState(false);
  const [wasDown, setWasDown] = useState(false);

  useEffect(() => {
    if (state === 'reconnecting' || state === 'offline') setWasDown(true);
    if (state === 'live' && wasDown) {
      setRecovered(true);
      setWasDown(false);
      const timer = setTimeout(() => setRecovered(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [state, wasDown]);

  let content: { text: string; tone: string; icon: React.ReactNode } | null = null;
  if (state === 'connecting') content = { text: t('shell.connection.connecting'), tone: 'bg-info-tint text-info', icon: <Loader2 className="size-4 animate-spin" aria-hidden /> };
  else if (state === 'reconnecting') content = { text: t('shell.connection.reconnecting'), tone: 'bg-warning-tint text-warning', icon: <Loader2 className="size-4 animate-spin" aria-hidden /> };
  else if (state === 'offline') content = { text: t('shell.connection.offline'), tone: 'bg-danger-tint text-danger', icon: <WifiOff className="size-4" aria-hidden /> };
  else if (recovered) content = { text: t('shell.connection.restored'), tone: 'bg-success-tint text-success', icon: null };

  return (
    <div role="status" aria-live="polite" className={cn(!content && 'sr-only')}>
      {content && (
        <div className={cn('flex min-h-9 items-center justify-center gap-2 px-4 py-1.5 text-center text-sm font-medium', content.tone)}>
          {content.icon}
          <span>{content.text}</span>
        </div>
      )}
    </div>
  );
}
