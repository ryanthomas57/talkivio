/**
 * Host-page SDK core: command routing, pre-init queueing, event handlers and the
 * read-only state snapshot. DOM-free so it can be unit tested; the iframe is created
 * by the `mount` function supplied by the loader entry.
 */
import { EMPTY_SNAPSHOT, STATE_EVENT, type WidgetStateSnapshot } from '../common/protocol';

export interface InitOptions {
  siteKey: string;
  locale?: string;
  position?: 'bottom-right' | 'bottom-left';
  handoffCode?: string;
}

export interface FrameHandle {
  call(method: string, args: unknown[]): Promise<unknown>;
  destroy(): void;
}

export interface MountHooks {
  emit(name: string, payload: unknown): void;
}

export type Mount = (options: InitOptions, hooks: MountHooks) => FrameHandle;
type Handler = (payload: unknown) => void;
type Waiting = { method: string; args: unknown[]; resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** Legacy command names accepted for compatibility (mapped to their current equivalents). */
const ALIASES: Record<string, string> = { setAttributes: 'setCustomFields' };
const SITE_KEY_RE = /^[\w-]{4,64}$/;
/** Commands whose master-prompt signature is Promise<void>: they resolve with nothing, whatever the frame sent. */
const VOID_RESULT = new Set(['open', 'resetIdentity', 'setDepartment', 'setTags', 'addTags', 'removeTags', 'setCustomFields', 'setLocale', 'trackPage', 'setConsent', 'endChat']);

export function sdkError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const noop = () => undefined;

export function createSdk(mount: Mount, implicit: { siteKey: string } | null) {
  const handlers = new Map<string, Set<Handler>>();
  let frame: FrameHandle | null = null;
  let initialized = false;
  let destroyed = false;
  let state: WidgetStateSnapshot = EMPTY_SNAPSHOT;
  let readyPayload: unknown = null;
  const waiting: Waiting[] = [];

  function safeCall(fn: Handler, payload: unknown) {
    try {
      fn(payload);
    } catch (err) {
      // Host handler exceptions must never break the widget.
      try {
        console.error('[Talkivio] event handler threw', err);
      } catch {
        /* ignore */
      }
    }
  }

  function emit(name: string, payload: unknown) {
    if (destroyed || !initialized) return;
    if (name === STATE_EVENT) {
      state = Object.freeze({ ...(payload as WidgetStateSnapshot) });
      return;
    }
    if (name === 'ready') readyPayload = payload;
    const set = handlers.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) safeCall(fn, payload);
  }

  function init(raw: unknown): Promise<unknown> {
    if (initialized) return Promise.reject(sdkError('ALREADY_INITIALIZED', 'Talkivio is already initialized'));
    const opts = (raw && typeof raw === 'object' ? raw : {}) as Partial<InitOptions>;
    if (typeof opts.siteKey !== 'string' || !SITE_KEY_RE.test(opts.siteKey)) {
      return Promise.reject(sdkError('INVALID_SITE_KEY', 'init() requires a valid siteKey'));
    }
    const options: InitOptions = { siteKey: opts.siteKey };
    if (typeof opts.locale === 'string' && opts.locale) options.locale = opts.locale;
    if (opts.position === 'bottom-left' || opts.position === 'bottom-right') options.position = opts.position;
    if (typeof opts.handoffCode === 'string') options.handoffCode = opts.handoffCode;
    initialized = true;
    destroyed = false;
    state = EMPTY_SNAPSHOT;
    readyPayload = null;
    frame = mount(options, { emit });
    const queued = waiting.splice(0);
    for (const w of queued) frame.call(w.method, w.args).then(w.resolve, w.reject);
    return Promise.resolve();
  }

  function destroy() {
    const f = frame;
    frame = null;
    initialized = false;
    destroyed = true;
    handlers.clear();
    waiting.length = 0;
    state = EMPTY_SNAPSHOT;
    readyPayload = null;
    if (f) f.destroy();
  }

  function on(name: unknown, fn: unknown): () => void {
    if (typeof name !== 'string' || typeof fn !== 'function') return noop;
    let set = handlers.get(name);
    if (!set) handlers.set(name, (set = new Set()));
    const handler = fn as Handler;
    set.add(handler);
    // Late subscribers to `ready` are called right away so integration order does not matter.
    if (name === 'ready' && readyPayload) {
      const payload = readyPayload;
      setTimeout(() => {
        if (handlers.get('ready')?.has(handler)) safeCall(handler, payload);
      }, 0);
    }
    return () => {
      handlers.get(name)?.delete(handler);
    };
  }

  /** The public `Talkivio(command, ...args)` function. */
  function api(command: unknown, ...args: unknown[]): unknown {
    if (typeof command !== 'string') return Promise.reject(sdkError('UNKNOWN_COMMAND', 'Command must be a string'));
    const cmd = ALIASES[command] ?? command;
    switch (cmd) {
      case 'on':
        return on(args[0], args[1]);
      case 'off':
        if (typeof args[0] === 'string' && typeof args[1] === 'function') handlers.get(args[0])?.delete(args[1] as Handler);
        return undefined;
      case 'getState':
        return state;
      case 'isOpen':
        return state.open;
      case 'getUnreadCount':
        return state.unreadCount;
      case 'init':
        return init(args[0]);
      case 'destroy':
        destroy();
        return undefined;
      // Display commands are void (they take effect once the widget is ready; failures are reported via 'error').
      case 'close':
      case 'show':
      case 'hide':
        send(cmd, args).catch(noop);
        return undefined;
    }
    return VOID_RESULT.has(cmd) ? send(cmd, args).then(() => undefined) : send(cmd, args);
  }

  function send(cmd: string, args: unknown[]): Promise<unknown> {
    if (frame) return frame.call(cmd, args);
    if (destroyed) return Promise.reject(sdkError('DESTROYED', 'Talkivio was destroyed; call init() again'));
    return new Promise((resolve, reject) => waiting.push({ method: cmd, args, resolve, reject }));
  }

  /**
   * Replay the calls queued by the inline snippet stub, in order. A site key on the script
   * tag counts as an implicit `init`; a leading explicit `init` merges its options into it.
   */
  function processQueue(queue: ArrayLike<unknown>[] | undefined) {
    const items = Array.from(queue ?? []).map((a) => Array.prototype.slice.call(a) as unknown[]);
    if (implicit) {
      let options: Record<string, unknown> = { siteKey: implicit.siteKey };
      const first = items[0];
      if (first && first[0] === 'init') {
        items.shift();
        const o = first[1] && typeof first[1] === 'object' ? (first[1] as Record<string, unknown>) : {};
        options = { ...o, siteKey: implicit.siteKey };
      }
      init(options).catch(noop);
    }
    for (const [cmd, ...rest] of items) {
      const res = api(cmd, ...rest) as Promise<unknown> | undefined;
      if (res && typeof (res as Promise<unknown>).then === 'function') (res as Promise<unknown>).catch(noop);
    }
  }

  return {
    api,
    processQueue,
    get state() {
      return state;
    },
    get initialized() {
      return initialized;
    },
  };
}
