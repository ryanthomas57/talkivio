/**
 * Host-page side of the widget: creates the isolated iframe, sizes/positions it from the
 * frame's `layout` messages, forwards page/visibility/viewport changes and SDK calls.
 * Everything is inline-styled with !important — no global CSS is injected into the host.
 */
import {
  COMPACT_MAX_WIDTH,
  FRAME_SOURCE,
  FULLSCREEN_MIN_HEIGHT,
  HOST_SOURCE,
  type FrameMessage,
  type HostMessage,
  type HostSettings,
  type Insets,
  type LayoutMessage,
  type ViewportInfo,
} from '../common/protocol';
import { sdkError, type FrameHandle, type InitOptions, type MountHooks } from './sdk';

declare const __WIDGET_VERSION__: string;

const PANEL_SHADOW = '0 16px 48px rgba(23,34,46,.18)';
const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

type Styles = Record<string, string>;

/** Handshake deadlines: after the frame's load event, and overall (slow networks). */
const READY_AFTER_LOAD_MS = 4_000;
const READY_DEADLINE_MS = 20_000;

function css(el: HTMLElement, styles: Styles) {
  for (const k in styles) el.style.setProperty(k, styles[k], 'important');
}

function media(q: string): boolean {
  try {
    return window.matchMedia(q).matches;
  } catch {
    return false;
  }
}

function measureInsets(): Insets {
  const probe = document.createElement('div');
  css(probe, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    visibility: 'hidden',
    'pointer-events': 'none',
    padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
  });
  document.documentElement.appendChild(probe);
  const cs = getComputedStyle(probe);
  const insets = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}

export function viewportInfo(): ViewportInfo {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const compact = width < COMPACT_MAX_WIDTH;
  return {
    width,
    height,
    compact,
    fullscreen: compact || height < FULLSCREEN_MIN_HEIGHT,
    insets: compact ? measureInsets() : ZERO,
    dark: media('(prefers-color-scheme: dark)'),
    reducedMotion: media('(prefers-reduced-motion: reduce)'),
  };
}

export function pageInfo(referrer?: string | null) {
  return { url: location.href, title: document.title || '', referrer: referrer === undefined ? document.referrer || null : referrer };
}

/** Pure geometry for a layout message (exported for tests). */
export function frameGeometry(m: LayoutMessage, vw: number, vh: number): Styles {
  if (m.mode === 'hidden') return { width: '0px', height: '0px', visibility: 'hidden', 'pointer-events': 'none', 'box-shadow': 'none' };
  const shown = { visibility: 'visible', 'pointer-events': 'auto' };
  if (m.fullscreen && m.mode === 'open') {
    return { ...shown, top: '0px', left: '0px', right: 'auto', bottom: 'auto', width: '100%', height: `${vh}px`, 'border-radius': '0px', 'box-shadow': 'none', 'transform-origin': '50% 100%' };
  }
  const left = m.position === 'bottom-left';
  let w = m.width;
  let h = m.height;
  if (m.mode === 'open') {
    w = Math.max(280, Math.min(w, vw - 2 * Math.max(m.offsetX, 8)));
    h = Math.max(320, Math.min(h, vh - 96, vh - m.offsetY - 16));
  }
  return {
    ...shown,
    top: 'auto',
    bottom: `${m.offsetY}px`,
    left: left ? `${m.offsetX}px` : 'auto',
    right: left ? 'auto' : `${m.offsetX}px`,
    width: `${Math.round(w)}px`,
    height: `${Math.round(h)}px`,
    'border-radius': m.mode === 'open' ? `${m.radius ?? 16}px` : '0px',
    'box-shadow': m.mode === 'open' ? PANEL_SHADOW : 'none',
    'transform-origin': left ? '0% 100%' : '100% 100%',
  };
}

export function mountFrame(base: string, options: InitOptions, settings: HostSettings, hooks: MountHooks): FrameHandle {
  const win = window;
  const doc = document;
  const baseOrigin = new URL(base).origin;
  const cleanups: Array<() => void> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Map<number, [(v: unknown) => void, (e: unknown) => void]>();
  const outbox: HostMessage[] = [];
  let seq = 0;
  let frameReady = false;
  let initFailed = false;
  let destroyed = false;
  let last: LayoutMessage | null = null;
  let anim: Animation | null = null;
  let lastViewport = '';
  let lastVisibility = '';
  let lastUrl = location.href;
  let scrollLock: Array<[HTMLElement, string, string]> | null = null;
  let restoreEl: HTMLElement | null = null;

  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!destroyed) fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const listen = (target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  // ── DOM ────────────────────────────────────────────────────────────────
  const container = doc.createElement('div');
  container.setAttribute('data-talkivio', '');
  // Note: opacity/transform are deliberately NOT !important — that would block the Web Animations.
  css(container, {
    position: 'fixed',
    'z-index': '2147483647',
    display: 'block',
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
    overflow: 'hidden',
    'box-sizing': 'content-box',
    width: '0px',
    height: '0px',
    'min-width': '0',
    'min-height': '0',
    'max-width': 'none',
    'max-height': 'none',
    top: 'auto',
    left: 'auto',
    right: '0px',
    bottom: '0px',
    visibility: 'hidden',
    'pointer-events': 'none',
    transition: 'none',
    filter: 'none',
    'clip-path': 'none',
    'color-scheme': 'normal',
    'border-radius': '0px',
    'box-shadow': 'none',
  });
  const iframe = doc.createElement('iframe');
  iframe.title = 'Chat';
  iframe.setAttribute('allow', 'clipboard-write');
  iframe.setAttribute('allowtransparency', 'true');
  iframe.setAttribute('aria-label', 'Chat');
  css(iframe, {
    all: 'initial',
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    border: '0',
    margin: '0',
    padding: '0',
    display: 'block',
    background: 'transparent',
    'color-scheme': 'normal',
    'max-width': 'none',
    'max-height': 'none',
    'min-width': '0',
    'min-height': '0',
    visibility: 'inherit',
    'pointer-events': 'inherit',
    'border-radius': 'inherit',
  });
  iframe.src = `${base}/widget/frame/${encodeURIComponent(options.siteKey)}`;
  container.appendChild(iframe);
  // The frame must answer the handshake: when it never does (framing refused for this origin, network failure),
  // pending and later calls reject with a typed error instead of waiting forever, and the page gets 'error'.
  const unavailable = () => sdkError('WIDGET_UNAVAILABLE', 'The chat widget could not be loaded on this page');
  const failInit = () => {
    if (frameReady || initFailed || destroyed) return;
    initFailed = true;
    outbox.length = 0;
    for (const [, [, reject]] of pending) reject(unavailable());
    pending.clear();
    hooks.emit('error', { code: 'WIDGET_UNAVAILABLE', message: 'The chat widget could not be loaded on this page', retryable: true });
  };
  later(failInit, READY_DEADLINE_MS);
  listen(iframe, 'load', () => later(failInit, READY_AFTER_LOAD_MS));
  const attach = () => {
    if (!destroyed && !container.isConnected) (doc.body || doc.documentElement).appendChild(container);
  };
  if (doc.body) attach();
  else listen(doc, 'DOMContentLoaded', attach);

  // ── Messaging ──────────────────────────────────────────────────────────
  function post(msg: HostMessage) {
    if (destroyed) return;
    if (!frameReady || !iframe.contentWindow) {
      outbox.push(msg);
      return;
    }
    try {
      iframe.contentWindow.postMessage(msg, baseOrigin);
    } catch (err) {
      if (msg.type === 'api') settle(msg.id, false, undefined, 'DATA_CLONE_ERROR');
      else throw err;
    }
  }

  function settle(id: number, ok: boolean, result?: unknown, error?: string) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p[0](result);
    else p[1](sdkError(error || 'FAILED', error || 'Command failed'));
  }

  function sendInit() {
    const vp = viewportInfo();
    lastViewport = JSON.stringify(vp);
    const msg: HostMessage = {
      source: HOST_SOURCE,
      type: 'init',
      widgetId: options.siteKey,
      page: pageInfo(),
      isMobile: vp.compact,
      locale: navigator.language || 'en',
      timezone: (() => {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        } catch {
          return '';
        }
      })(),
      screen: `${screen.width}x${screen.height}`,
      settings: {
        locale: options.locale ?? settings.locale ?? null,
        identityToken: settings.identityToken ?? null,
        hideLauncher: !!settings.hideLauncher,
        position: options.position ?? settings.position ?? null,
        handoffCode: options.handoffCode ?? settings.handoffCode ?? null,
      },
      viewport: vp,
      sdkVersion: __WIDGET_VERSION__,
    };
    iframe.contentWindow?.postMessage(msg, baseOrigin);
  }

  listen(win, 'message', ((e: MessageEvent) => {
    if (e.source !== iframe.contentWindow || e.origin !== baseOrigin) return;
    const d = e.data as FrameMessage;
    if (!d || typeof d !== 'object' || d.source !== FRAME_SOURCE) return;
    switch (d.type) {
      case 'ready': {
        frameReady = true;
        initFailed = false;
        sendInit();
        const queued = outbox.splice(0);
        for (const m of queued) post(m);
        sendVisibility(true);
        break;
      }
      case 'layout':
        applyLayout(d);
        break;
      case 'event':
        if (typeof d.name === 'string') hooks.emit(d.name, d.payload);
        break;
      case 'api:result':
        settle(d.id, d.ok, d.result, d.error);
        break;
    }
  }) as EventListener);

  // ── Layout & motion ────────────────────────────────────────────────────
  function animate(frames: Keyframe[], duration: number, fill: FillMode = 'none') {
    if (anim) anim.cancel();
    anim = typeof container.animate === 'function' ? container.animate(frames, { duration, easing: 'cubic-bezier(.2,.8,.2,1)', fill }) : null;
  }

  function setScrollLock(on: boolean) {
    if (on && !scrollLock) {
      scrollLock = [doc.documentElement, doc.body].filter(Boolean).map((el) => {
        const entry: [HTMLElement, string, string] = [el, el.style.getPropertyValue('overflow'), el.style.getPropertyPriority('overflow')];
        el.style.setProperty('overflow', 'hidden', 'important');
        return entry;
      });
    } else if (!on && scrollLock) {
      for (const [el, value, priority] of scrollLock) {
        if (value) el.style.setProperty('overflow', value, priority);
        else el.style.removeProperty('overflow');
      }
      scrollLock = null;
    }
  }

  function geometry(m: LayoutMessage) {
    const vv = win.visualViewport;
    const styles = frameGeometry(m, win.innerWidth, vv && m.fullscreen ? vv.height : win.innerHeight);
    if (m.fullscreen && m.mode === 'open' && vv) styles.top = `${vv.offsetTop}px`;
    css(container, styles);
  }

  function applyLayout(m: LayoutMessage) {
    const prev = last;
    last = m;
    const reduced = media('(prefers-reduced-motion: reduce)');
    const out = m.fullscreen ? 'translateY(24px)' : 'translateY(8px) scale(.96)';
    if (m.closing) {
      // Keep the open geometry while fading out; the frame follows up with the collapsed layout.
      animate(reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: out }], reduced ? 100 : 180, 'forwards');
      return;
    }
    const prevOpen = prev?.mode === 'open';
    const prevClosing = !!prev?.closing;
    if (anim && (prevClosing || !prevOpen)) {
      anim.cancel();
      anim = null;
    }
    geometry(m);
    setScrollLock(m.mode === 'open' && !!m.fullscreen);
    if (m.mode === 'open' && (!prevOpen || prevClosing)) {
      if (!prevOpen) {
        const active = doc.activeElement as HTMLElement | null;
        restoreEl = active && active !== doc.body && active !== iframe ? active : null;
      }
      animate(reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: out }, { opacity: 1, transform: 'none' }], reduced ? 100 : 180);
      if (m.focus) iframe.focus({ preventScroll: true });
    } else if (prevOpen && m.mode !== 'open') {
      if (m.mode !== 'hidden') animate([{ opacity: 0 }, { opacity: 1 }], reduced ? 80 : 140);
      if (m.restoreFocus && restoreEl && restoreEl.isConnected) restoreEl.focus({ preventScroll: true });
      restoreEl = null;
    }
  }

  // ── Host environment tracking ──────────────────────────────────────────
  function sendViewport(force = false) {
    const vp = viewportInfo();
    const key = JSON.stringify(vp);
    if (!force && key === lastViewport) return;
    lastViewport = key;
    post({ source: HOST_SOURCE, type: 'viewport', viewport: vp });
  }
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    if (last && last.mode === 'open') geometry(last);
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = later(() => sendViewport(), 120);
  };
  listen(win, 'resize', onResize);
  if (win.visualViewport) {
    const onVV = (() => {
      if (last && last.mode === 'open' && last.fullscreen) geometry(last);
    }) as EventListener;
    listen(win.visualViewport, 'resize', onVV);
    listen(win.visualViewport, 'scroll', onVV);
  }
  for (const q of ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)']) {
    try {
      const mq = win.matchMedia(q);
      listen(mq, 'change', () => sendViewport());
    } catch {
      /* old browsers */
    }
  }

  function sendVisibility(force = false) {
    const visible = doc.visibilityState !== 'hidden';
    const focused = doc.hasFocus();
    const key = `${visible}:${focused}`;
    if (!force && key === lastVisibility) return;
    lastVisibility = key;
    post({ source: HOST_SOURCE, type: 'visibility', visible, focused });
  }
  const onVisibility = () => later(() => sendVisibility(), 0);
  listen(doc, 'visibilitychange', onVisibility);
  listen(win, 'focus', onVisibility);
  listen(win, 'blur', onVisibility);

  // SPA navigation tracking.
  let pageTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePage = () => {
    if (pageTimer) clearTimeout(pageTimer);
    pageTimer = later(() => {
      const url = location.href;
      if (url === lastUrl) return;
      const referrer = lastUrl;
      lastUrl = url;
      post({ source: HOST_SOURCE, type: 'page', page: pageInfo(referrer) });
    }, 300);
  };
  const hist = history;
  const originals = { pushState: hist.pushState, replaceState: hist.replaceState };
  const wrap = <T extends (...a: never[]) => unknown>(fn: T): T =>
    function (this: History, ...a: Parameters<T>) {
      const r = fn.apply(this, a);
      schedulePage();
      return r;
    } as T;
  const patched = { pushState: wrap(originals.pushState), replaceState: wrap(originals.replaceState) };
  hist.pushState = patched.pushState;
  hist.replaceState = patched.replaceState;
  cleanups.push(() => {
    if (hist.pushState === patched.pushState) hist.pushState = originals.pushState;
    if (hist.replaceState === patched.replaceState) hist.replaceState = originals.replaceState;
  });
  listen(win, 'popstate', schedulePage);
  listen(win, 'hashchange', schedulePage);

  return {
    call(method: string, args: unknown[]) {
      if (destroyed) return Promise.reject(sdkError('DESTROYED', 'Talkivio was destroyed'));
      if (initFailed) return Promise.reject(unavailable());
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, [resolve, reject]);
        post({ source: HOST_SOURCE, type: 'api', id, method, args });
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const fn of cleanups.splice(0)) fn();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (anim) anim.cancel();
      setScrollLock(false);
      pending.clear();
      outbox.length = 0;
      container.remove();
    },
  };
}
