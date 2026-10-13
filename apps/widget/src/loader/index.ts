/**
 * Talkivio embed loader (IIFE, dependency-free).
 *
 *   <script>window.Talkivio = window.Talkivio || function () { (window.Talkivio.q = window.Talkivio.q || []).push(arguments); };</script>
 *   <script async src="https://API/widget/loader.js" data-site-key="wk_..."></script>
 *
 * `data-widget-id` is accepted as an alias of `data-site-key`.
 */
import type { HostSettings } from '../common/protocol';
import { mountFrame } from './mount';
import { createSdk } from './sdk';

declare const __WIDGET_VERSION__: string;

type Stub = ((...args: unknown[]) => unknown) & { q?: ArrayLike<unknown>[]; version?: string };
type Win = Window & {
  Talkivio?: Stub;
  TalkivioSettings?: HostSettings;
  __talkivioLoaded?: boolean;
};

(function boot() {
  const w = window as Win;
  if (w.__talkivioLoaded) return; // single instance per page
  w.__talkivioLoaded = true;

  const script = (document.currentScript as HTMLScriptElement | null) || document.querySelector<HTMLScriptElement>('script[data-site-key],script[data-widget-id]');
  const siteKey = script?.getAttribute('data-site-key') || script?.getAttribute('data-widget-id') || null;
  let base = script?.getAttribute('data-base-url') || '';
  if (!base) {
    try {
      base = new URL(script?.src || '', location.href).origin;
    } catch {
      base = location.origin;
    }
  }
  base = base.replace(/\/+$/, '');

  const raw = w.TalkivioSettings || {};
  const settings: HostSettings = {
    locale: typeof raw.locale === 'string' ? raw.locale : null,
    identityToken: typeof raw.identityToken === 'string' ? raw.identityToken : null,
    hideLauncher: !!raw.hideLauncher,
    position: raw.position === 'bottom-left' || raw.position === 'bottom-right' ? raw.position : null,
    handoffCode: typeof raw.handoffCode === 'string' ? raw.handoffCode : null,
  };

  const sdk = createSdk((options, hooks) => mountFrame(base, options, settings, hooks), siteKey ? { siteKey } : null);
  const queue = [...Array.from(w.Talkivio?.q ?? [])];
  const api: Stub = function (...args: unknown[]) {
    return sdk.api(args[0], ...args.slice(1));
  };
  api.version = __WIDGET_VERSION__;
  w.Talkivio = api;
  sdk.processQueue(queue);
})();
