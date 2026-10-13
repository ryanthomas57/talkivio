'use client';
/**
 * Live widget preview (ch. 08). Renders the real widget frame in isolated preview
 * mode — sample content, no network calls, never counted in production analytics —
 * and pushes the draft configuration over postMessage.
 */
import type { WidgetConfig } from '@talkivio/contracts';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useT, type MessageKey } from '@/i18n';

export const PREVIEW_SOURCE = 'talkivio-preview';
export type PreviewState = 'launcher' | 'greeting' | 'welcome' | 'prechat' | 'chat' | 'offline' | 'ended';

/** `label` is a message key: render with t(). */
export const PREVIEW_STATES: Array<{ value: PreviewState; label: MessageKey }> = [
  { value: 'launcher', label: 'ui.widgetPreview.state.launcher' },
  { value: 'greeting', label: 'ui.widgetPreview.state.greeting' },
  { value: 'welcome', label: 'ui.widgetPreview.state.welcome' },
  { value: 'prechat', label: 'ui.widgetPreview.state.prechat' },
  { value: 'chat', label: 'ui.widgetPreview.state.chat' },
  { value: 'offline', label: 'ui.widgetPreview.state.offline' },
  { value: 'ended', label: 'ui.widgetPreview.state.ended' },
];

export function WidgetPreview({ siteKey, config, state, online = true, locale, className, height = 640 }: { siteKey: string; config: WidgetConfig; state: PreviewState; online?: boolean; locale?: string; className?: string; height?: number }) {
  const t = useT();
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const src = `/widget/frame/${encodeURIComponent(siteKey)}?preview=1`;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const d = e.data as { source?: string; type?: string };
      if (d?.source === PREVIEW_SOURCE && d.type === 'ready') setReady(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    frame.current?.contentWindow?.postMessage({ source: PREVIEW_SOURCE, config, state, online, locale }, window.location.origin);
  }, [ready, config, state, online, locale]);

  return (
    <div className={cn('relative overflow-hidden rounded-[var(--radius-card)] border border-line bg-[repeating-linear-gradient(45deg,var(--surface-2),var(--surface-2)_12px,var(--surface-3)_12px,var(--surface-3)_24px)]', className)} style={{ height }}>
      <span className="absolute bottom-3 start-3 z-[1] rounded-full bg-fg px-2.5 py-1 text-xs font-semibold text-canvas">{t('common.preview')}</span>
      <iframe ref={frame} src={src} title={t('ui.widgetPreview.frameTitle')} className="absolute inset-0 size-full border-0" />
      {!ready && <div className="absolute inset-0 flex items-center justify-center text-sm text-fg-2">{t('ui.widgetPreview.loading')}</div>}
    </div>
  );
}
