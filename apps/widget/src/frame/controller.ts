/**
 * Widget controller: owns the state, the Talkivio v2 transport (REST `/widget/v1` +
 * Socket.IO `/visitor` on path `/realtime/v1`), the host bridge and every user/SDK action.
 * UI components read `state` and call methods; nothing else mutates state.
 */
import { io, type Socket } from 'socket.io-client';
import {
  DEFAULT_WIDGET_CONFIG,
  mergeWidgetConfig,
  type MessageDTO,
  type PageInfo,
  type PublicAgent,
  type Rating,
  type VisitorProfileInput,
  type WidgetConfig,
} from '@talkivio/contracts/protocol';
import {
  FRAME_SOURCE,
  PREVIEW_SOURCE,
  STATE_EVENT,
  isObject,
  type ConnectionState,
  type HostMessage,
  type LayoutMessage,
  type PreviewMessage,
  type PreviewState,
  type ViewportInfo,
  type WidgetStateSnapshot,
} from '../common/protocol';
import {
  ApiError,
  WidgetApi,
  camelize,
  ratingToWire,
  toAccount,
  toAttachment,
  toConversation,
  toMessage,
  type V2Attachment,
  type V2Availability,
  type V2Bootstrap,
  type V2Chat,
  type V2Export,
  type V2Frame,
  type V2Grant,
  type V2Message,
  type V2MessagePage,
  type V2OfflineReceipt,
  type V2Session,
  type V2UploadInit,
} from './api';
import { HostBridge, ancestorOrigin } from './host';
import { resolveLocale, type Locale, type StringKey } from './i18n';
import { previewState } from './preview';
import { blip, unlockAudio } from './sound';
import {
  computeInvitation,
  computeUnread,
  initialState,
  isAgentText,
  isHidden,
  mergeIncoming,
  openConversation,
  proactiveKey,
  viewOf,
  type OfflineDraft,
  type State,
  type UiMessage,
} from './state';
import { isPreviewableImage, putBytes, sha256Hex } from './upload';
import { EMAIL_RE, keys, originOf, readVisitorToken, store, uuid, writeVisitorToken } from './util';

export type OpenSource = 'launcher' | 'invitation' | 'api' | 'agent' | 'trigger' | 'restore' | 'standalone';
export type CloseSource = 'button' | 'escape' | 'api' | 'trigger';
type Listener = () => void;
type SendResult = { ok: true; chatId: string } | { ok: false; error: string };
interface SendMeta {
  attachmentIds?: string[];
  departmentId?: string | null;
  profile?: VisitorProfileInput;
  done?: (r: SendResult) => void;
}
interface UiSession {
  open: boolean;
  seen: string[];
  dismissedConv: string | null;
}
interface Consent {
  analytics: boolean;
  service?: boolean;
  policyVersion: string;
  at: string;
}
type ConfigPatch = { appearance?: Record<string, unknown>; content?: Record<string, unknown> };
type CommandAck =
  | { type: 'command.ack'; result: unknown }
  | { type: 'command.error'; code: string; message: string; retryable: boolean };

export class WidgetError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const HIDDEN_CODES = ['ORIGIN_NOT_ALLOWED', 'UNKNOWN_SITE'];
/** Public (host-facing) code for a blocked visitor; the internal BANNED state is never exposed. */
const UNAVAILABLE = 'SERVICE_UNAVAILABLE';
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const later = (fn: () => void) => Promise.resolve().then(fn);
/**
 * Machine code of a failure. A non-retryable SERVICE_UNAVAILABLE is how the API
 * refuses a blocked visitor (ban) without naming it; the widget maps it to its
 * internal BANNED state, which renders neutral "Service unavailable" copy.
 */
const codeOf = (err: unknown): string => {
  if (err instanceof ApiError && err.code === 'SERVICE_UNAVAILABLE' && !err.retryable) return 'BANNED';
  return err instanceof ApiError || err instanceof WidgetError ? err.code : 'INTERNAL';
};

/** Keep only presentation keys (appearance/content) whose type matches the defaults. */
export function sanitizeSettingsPatch(patch: unknown): ConfigPatch {
  const out: ConfigPatch = {};
  if (!isObject(patch)) return out;
  const sections = ['appearance', 'content'] as const;
  const accept = (section: (typeof sections)[number], key: string, value: unknown) => {
    const defaults = DEFAULT_WIDGET_CONFIG[section] as unknown as Record<string, unknown>;
    if (!(key in defaults)) return false;
    const d = defaults[key];
    const ok =
      d === null
        ? value === null || typeof value === 'string'
        : typeof value === typeof d && (typeof d !== 'number' || Number.isFinite(value));
    if (ok) (out[section] ??= {})[key] = value;
    return ok;
  };
  for (const section of sections) {
    const src = patch[section];
    if (isObject(src)) for (const [k, v] of Object.entries(src)) accept(section, k, v);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'appearance' || k === 'content') continue;
    if (!accept('appearance', k, v)) accept('content', k, v);
  }
  return out;
}

export function sortBySeq(list: UiMessage[]): UiMessage[] {
  // Server messages are ordered by seq; local (unsent) ones stay after the last server message.
  const server = list.filter((m) => m.seq !== undefined).sort((a, b) => a.seq! - b.seq!);
  const local = list.filter((m) => m.seq === undefined);
  return [...server, ...local];
}

/** `rd_handoff=<code>` on the host page URL (set by the source site's redirect). */
export function handoffFromUrl(url: string): string | null {
  try {
    const v = new URL(url).searchParams.get('rd_handoff');
    return v && /^[\w.-]{8,100}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function snakeKeys(v: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = x;
  return out;
}

export class Controller {
  state: State;
  readonly host: HostBridge;
  /** Unsent composer text (survives closing and reopening the panel). */
  draft = '';
  private readonly listeners = new Set<Listener>();
  private readonly keys: ReturnType<typeof keys>;
  private readonly api: WidgetApi;
  private socket: Socket | null = null;
  private serverConfig: WidgetConfig = DEFAULT_WIDGET_CONFIG;
  private overrides: ConfigPatch = {};
  private positionOverride: 'bottom-right' | 'bottom-left' | null = null;
  private sdkLocale: string | null = null;
  private browserLocale = typeof navigator !== 'undefined' ? navigator.language || 'en' : 'en';
  private identityToken: string | null = null;
  private page: PageInfo;
  private initInfo = { locale: '', timezone: '', screen: '' };
  private hostInit = false;
  private connectStarted = false;
  private failures = 0;
  private analyticsAllowed = false;
  private heartbeatMs = 15000;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private capabilityTimer: ReturnType<typeof setTimeout> | undefined;
  private greetingTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sendMeta = new Map<string, SendMeta>();
  private readonly files = new Map<string, File>();
  private readonly seenEvents = new Set<string>();
  private readonly invitationIds = new Map<string, string>();
  private chatMeta: { id: string; version: number; lastSeq: number } | null = null;
  private cursor: string | null = null;
  private subscribedChat: string | null = null;
  private sessionRefresh: Promise<boolean> | null = null;
  private inflight = false;
  private readyWaiters: Array<[() => void, (e: Error) => void]> = [];
  private readonly startedChats = new Set<string>();
  private endingByVisitor = false;
  private acceptedInvitation: string | null = null;
  private ui: UiSession;
  private consent: Consent | null;
  private previewMode: PreviewState = 'launcher';
  private previewOnline: boolean | undefined;
  private previewLocale: string | null = null;
  private emitted = {
    unread: -1,
    invitation: '',
    online: null as boolean | null,
    visitor: '',
    unsupported: '',
    snapshot: '',
  };
  private publishQueued = false;
  private lastLayout = '';
  private layoutCache: LayoutMessage | null = null;
  private visitorTyping = {
    sentAt: 0,
    active: false,
    text: '',
    idle: undefined as ReturnType<typeof setTimeout> | undefined,
    trail: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  private noticeSeq = 0;
  private focusLauncherFlag = false;
  private handoffCode: string | null = null;
  private readonly uploadWaiters = new Map<
    string,
    (a: { state?: string; errorCode?: string | null }) => void
  >();
  private readonly grants = new Map<string, { url: string; until: number }>();
  private clientTags = new Set<string>();
  /** True while an identity reset is in flight: the old capability is being revoked on purpose. */
  private resetting = false;
  private deliveredTimer: ReturnType<typeof setTimeout> | undefined;
  private deliveredPending: { chatId: string; seq: number } | null = null;
  private readonly deliveredSent = new Map<string, number>();
  private siteId: string | null = null;

  constructor(
    readonly widgetId: string,
    readonly apiBase: string,
    readonly preview: boolean,
    readonly version: string,
  ) {
    this.keys = keys(widgetId);
    this.api = new WidgetApi(apiBase, () => this.refreshSession());
    this.host = new HostBridge((m) => this.onHost(m));
    this.ui = {
      open: false,
      seen: [],
      dismissedConv: null,
      ...(store.json<UiSession>('session', this.keys.ui) ?? {}),
    };
    this.consent = store.json<Consent>('local', this.keys.consent);
    this.page = { url: location.href, title: document.title || '', referrer: null };
    const prefs = store.json<{ sound?: boolean }>('local', this.keys.prefs);
    this.state = initialState({
      preview,
      standalone: !this.host.embedded,
      seen: this.ui.seen,
      soundOn: prefs?.sound !== false,
      hostVisible: document.visibilityState !== 'hidden',
      hostFocused: document.hasFocus(),
      locale: resolveLocale(null, null, this.browserLocale).locale,
      viewport: this.ownViewport(),
    });
    document.addEventListener('visibilitychange', () => {
      this.set({ hostVisible: document.visibilityState !== 'hidden' });
      this.beat();
      this.markRead();
    });
    window.addEventListener('pointerdown', unlockAudio, true);
    window.addEventListener('keydown', unlockAudio, true);
  }

  // ══════════════ Store plumbing ══════════════

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.derive();
    for (const fn of this.listeners) fn();
    this.schedulePublish();
  }

  private derive() {
    const s = this.state;
    const invitation = computeInvitation(s);
    const unread = computeUnread(s);
    if (
      invitation?.id !== s.invitation?.id ||
      invitation?.body !== s.invitation?.body ||
      unread !== s.unread
    ) {
      this.state = { ...s, invitation, unread };
    }
    if (this.preview) return;
    if (unread !== this.emitted.unread && (this.state.sessionReady || unread > 0)) {
      this.emitted.unread = unread;
      this.emit('unread.changed', { count: unread });
    }
    if (invitation && invitation.kind !== 'message' && invitation.id !== this.emitted.invitation) {
      this.emitted.invitation = invitation.id;
      const serverId = this.invitationIds.get(invitation.id);
      this.emit('invitation.displayed', { invitationId: serverId ?? invitation.id });
      if (serverId) void this.invitationAction(serverId, 'displayed');
    }
  }

  private emit(name: string, payload: unknown) {
    if (this.preview) return;
    this.host.post({ source: FRAME_SOURCE, type: 'event', name, payload });
  }

  snapshot(): WidgetStateSnapshot {
    const s = this.state;
    const view = viewOf(s);
    return {
      ready: s.sessionReady,
      open: s.open && !s.closing,
      visible: view !== 'hidden',
      view,
      connection: s.connection,
      availability: s.account ? (s.account.online ? 'online' : 'offline') : 'unknown',
      unreadCount: s.unread,
      locale: s.locale,
      chat: s.conversation ? { id: s.conversation.id, status: s.conversation.status } : null,
      visitor: s.visitor ? { id: s.visitor.id, verified: s.verified } : null,
      configVersion: s.configVersion,
    };
  }

  private schedulePublish() {
    if (this.publishQueued || this.preview) return;
    this.publishQueued = true;
    void later(() => {
      this.publishQueued = false;
      const snap = this.snapshot();
      const json = JSON.stringify(snap);
      if (json === this.emitted.snapshot) return;
      this.emitted.snapshot = json;
      this.emit(STATE_EVENT, snap);
    });
  }

  /** Called by the App after each render with the measured layout. */
  postLayout(layout: LayoutMessage): void {
    this.layoutCache = layout;
    const json = JSON.stringify(layout);
    if (json === this.lastLayout || !this.host.origin) return;
    this.lastLayout = json;
    this.host.post(layout);
  }

  consumeFocusLauncher(): boolean {
    const f = this.focusLauncherFlag;
    this.focusLauncherFlag = false;
    return f;
  }

  private saveUi(patch: Partial<UiSession>) {
    this.ui = { ...this.ui, ...patch };
    store.set('session', this.keys.ui, JSON.stringify(this.ui));
  }

  markSeen(id: string) {
    if (this.state.seen.includes(id)) return;
    const seen = [...this.state.seen, id].slice(-50);
    this.saveUi({ seen });
    this.set({ seen });
  }

  notify(key: StringKey, tone: 'error' | 'info' = 'error') {
    clearTimeout(this.noticeTimer);
    this.set({ notice: { id: ++this.noticeSeq, key, tone } });
    this.noticeTimer = setTimeout(() => this.set({ notice: null }), 6000);
  }

  clearNotice() {
    clearTimeout(this.noticeTimer);
    this.set({ notice: null });
  }

  // ══════════════ Boot ══════════════

  start(): void {
    if (this.preview) return this.startPreview();
    if (this.host.embedded) {
      this.host.ready();
      // Opened outside the loader (e.g. a bare iframe): continue with our own page info.
      setTimeout(() => {
        if (!this.hostInit) this.startConnection();
      }, 3000);
    } else {
      this.startConnection();
    }
  }

  private ownViewport(): ViewportInfo {
    const media = (q: string) => {
      try {
        return matchMedia(q).matches;
      } catch {
        return false;
      }
    };
    const width = window.innerWidth;
    return {
      width,
      height: window.innerHeight,
      compact: width < 640,
      fullscreen: true,
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
      dark: media('(prefers-color-scheme: dark)'),
      reducedMotion: media('(prefers-reduced-motion: reduce)'),
    };
  }

  private hostOrigin(): string | null {
    return ancestorOrigin() ?? originOf(document.referrer) ?? originOf(this.page.url);
  }

  private startConnection() {
    if (this.connectStarted) return;
    this.connectStarted = true;
    if (!this.host.embedded) {
      this.set({ pageUrl: location.href });
      this.open('standalone', false);
    }
    void this.boot();
  }

  private async boot(): Promise<void> {
    clearTimeout(this.retryTimer);
    this.setConnection(this.state.sessionReady ? 'reconnecting' : 'connecting');
    try {
      if (!this.state.configLoaded) await this.loadBootstrap();
      await this.openSession();
      this.failures = 0;
      this.connectSocket();
    } catch (err) {
      const code = codeOf(err);
      this.failures++;
      if (HIDDEN_CODES.includes(code) || code === 'NOT_FOUND') {
        // Unapproved origin / unknown site: render nothing at all.
        this.set({ fatal: code === 'NOT_FOUND' ? 'UNKNOWN_SITE' : code });
        this.setConnection('failed', code);
        this.emit('error', {
          code,
          message:
            code === 'ORIGIN_NOT_ALLOWED'
              ? 'This website is not allowed to use this widget'
              : 'Unknown site key',
          retryable: false,
        });
        this.rejectWaiters(new WidgetError(code));
        return;
      }
      if (code === 'BANNED') return this.onBanned();
      const retryable = !(err instanceof ApiError) || err.retryable || code === 'NETWORK';
      if (!this.state.sessionReady && (this.failures >= 2 || !retryable)) this.set({ fatal: code });
      this.emit('error', { code, message: (err as Error).message || code, retryable });
      if (retryable)
        this.retryTimer = setTimeout(
          () => void this.boot(),
          code === 'RATE_LIMITED' ? 15000 : Math.min(30000, 2000 * 2 ** Math.min(this.failures, 4)),
        );
      else this.setConnection('failed', code);
    }
  }

  private async loadBootstrap(): Promise<void> {
    const data = await this.api.call<V2Bootstrap>(
      'POST',
      '/bootstrap',
      {
        siteKey: this.widgetId,
        hostOrigin: this.hostOrigin(),
        locale: (this.sdkLocale ?? this.browserLocale).slice(0, 20),
      },
      { auth: false },
    );
    this.serverConfig = mergeWidgetConfig(data.config);
    this.siteId = data.siteId ?? null;
    const behavior = this.serverConfig.behavior;
    this.set({
      configLoaded: true,
      config: this.effectiveConfig(),
      configVersion: data.configVersion,
      account: toAccount(data.availability),
      features: {
        files: !!data.chat?.allowFiles && behavior.attachments.enabled,
        maxFileMb: data.chat?.maxFileMb || 10,
        transcripts: behavior.transcripts.enabled,
        readReceipts: data.chat?.readReceipts !== false,
      },
    });
    this.recomputeLocale();
    this.armGreeting();
  }

  /** Context shared by /sessions, /identity/reset and /identity/redeem. */
  private sessionContext() {
    const p = this.page;
    return {
      consent: this.consent
        ? { analytics: this.consent.analytics, policyVersion: this.consent.policyVersion }
        : undefined,
      page: {
        url: p.url.slice(0, 4000),
        title: (p.title || '').slice(0, 1000),
        referrer: p.referrer ? p.referrer.slice(0, 4000) : null,
      },
      locale: (this.initInfo.locale || this.browserLocale).slice(0, 20) || null,
      timezone: this.initInfo.timezone.slice(0, 80) || null,
    };
  }

  /** Create or resume the visitor session; issues a fresh capability. */
  private async openSession(): Promise<void> {
    // Cross-site identity handoff: a one-time code (SDK setting or `rd_handoff` on the host URL).
    const handoff = this.handoffCode;
    if (handoff) {
      this.handoffCode = null;
      try {
        const s = await this.api.call<V2Session>(
          'POST',
          '/identity/redeem',
          {
            handoffCode: handoff,
            siteKey: this.widgetId,
            hostOrigin: this.hostOrigin(),
            ...this.sessionContext(),
          },
          { auth: false },
        );
        return this.applySession(s);
      } catch (err) {
        if (codeOf(err) === 'BANNED') throw err;
        this.emit('error', {
          code: codeOf(err),
          message: 'Identity handoff could not be redeemed',
          retryable: false,
        });
      }
    }
    const s = await this.api.call<V2Session>(
      'POST',
      '/sessions',
      {
        siteKey: this.widgetId,
        hostOrigin: this.hostOrigin(),
        anonymousToken: readVisitorToken(this.keys.visitor),
        sessionKey: store.get('session', this.keys.session),
        identityToken: this.identityToken,
        ...this.sessionContext(),
      },
      { auth: false },
    );
    return this.applySession(s);
  }

  /** Apply a session response (from /sessions, /identity/reset or /identity/redeem). */
  private async applySession(s: V2Session): Promise<void> {
    if (s.anonymousToken)
      writeVisitorToken(this.keys.visitor, s.anonymousToken, {
        persistence: s.anonymousTokenPersistence,
        expiresAt: s.anonymousTokenExpiresAt,
      });
    if (s.sessionKey) store.set('session', this.keys.session, s.sessionKey);
    this.api.capability = s.capability;
    this.scheduleCapabilityRefresh(s.capabilityExpiresAt);
    this.analyticsAllowed = s.consent?.analytics === 'granted';

    const first = !this.state.sessionReady;
    const prev = this.state.visitor;
    const visitorChanged = !!prev && prev.id !== s.visitor.id;
    this.set({
      sessionReady: true,
      fatal: null,
      visitor: {
        id: s.visitor.id,
        name: s.visitor.hasName ? s.visitor.displayName : null,
        email: visitorChanged ? null : (prev?.email ?? null),
        phone: visitorChanged ? null : (prev?.phone ?? null),
      },
      verified: !!s.visitor.verified,
      ...(visitorChanged ? { conversation: null, messages: [], proactive: [] } : {}),
    });
    if (visitorChanged) {
      this.chatMeta = null;
      this.cursor = null;
      this.subscribedChat = null;
    }
    if (s.activeChat) await this.adoptChat(s.activeChat, true);
    else if (openConversation(this.state)) await this.refreshChat(); // our chat may have closed meanwhile

    if (first) {
      this.emit('ready', { siteId: this.siteId ?? this.widgetId, configVersion: this.state.configVersion });
      if (this.ui.open && !this.state.open && !this.state.viewport.compact) this.open('restore', false);
      this.sendPageEvent();
    }
    const online = !!this.state.account?.online;
    if (this.emitted.online !== online) {
      this.emitted.online = online;
      this.emit('availability.changed', this.availabilityPayload(online));
    }
    if (this.emitted.visitor !== s.visitor.id) {
      this.emitted.visitor = s.visitor.id;
      this.emit('identity.changed', { verified: !!s.visitor.verified, visitorId: s.visitor.id });
    }
    for (const [res] of this.readyWaiters.splice(0)) res();
    this.markRead();
    void this.pump();
  }

  private scheduleCapabilityRefresh(expiresAt: string) {
    clearTimeout(this.capabilityTimer);
    const ms = new Date(expiresAt).getTime() - Date.now() - 120_000;
    this.capabilityTimer = setTimeout(
      () => void this.refreshSession(),
      Math.max(30_000, Number.isFinite(ms) ? ms : 50 * 60_000),
    );
  }

  /** Re-issue the capability (on 401 / before expiry). Concurrent callers share one request. */
  private refreshSession(): Promise<boolean> {
    if (this.preview || this.resetting) return Promise.resolve(false);
    this.sessionRefresh ??= this.openSession()
      .then(() => true)
      .catch((err) => {
        if (codeOf(err) === 'BANNED') this.onBanned();
        return false;
      })
      .finally(() => {
        this.sessionRefresh = null;
      });
    return this.sessionRefresh;
  }

  private connectSocket() {
    if (this.socket) {
      if (!this.socket.connected) this.socket.connect();
      return;
    }
    const socket = io(`${this.apiBase}/visitor`, {
      path: '/realtime/v1',
      transports: ['websocket', 'polling'],
      // Function form: every (re)connect mints a fresh single-use ticket.
      auth: (cb: (data: object) => void) => {
        this.api
          .call<{ ticket: string }>('POST', '/socket-ticket')
          .then((t) => cb({ ticket: t.ticket }))
          .catch(() => cb({ ticket: '' }));
      },
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 15000,
    });
    this.socket = socket;
    socket.on('auth.ok', (raw: unknown) =>
      this.onSocketAuth(camelize<{ connectionId: string; heartbeatIntervalMs?: number }>(raw)),
    );
    socket.on('event', (raw: unknown) => this.onFrame(camelize<V2Frame>(raw)));
    socket.on('ephemeral', (raw: unknown) =>
      this.onEphemeral(camelize<{ type: string; expiresAt?: string; payload: Record<string, unknown> }>(raw)),
    );
    socket.on('control', (raw: unknown) => this.onControl(camelize<{ type: string }>(raw)));
    socket.on('disconnect', (reason: string) => this.onDisconnect(reason));
    socket.on('connect_error', (err: Error) => this.onConnectError(err));
  }

  private live(): boolean {
    return !!this.socket?.connected && this.state.connection === 'connected' && !this.state.banned;
  }

  private setConnection(st: ConnectionState, reason?: string) {
    if (this.state.connection === st) return;
    this.set({ connection: st });
    this.emit('connection.changed', reason ? { state: st, reason } : { state: st });
  }

  private onSocketAuth(p: { heartbeatIntervalMs?: number }) {
    this.failures = 0;
    this.heartbeatMs = Math.max(5000, p.heartbeatIntervalMs || 15000);
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.beat(), this.heartbeatMs);
    this.subscribedChat = null;
    this.setConnection('connected');
    this.beat();
    const conv = this.state.conversation;
    if (conv) void this.subscribeChat(conv.id);
    void this.pump();
  }

  private onDisconnect(reason: string) {
    clearInterval(this.heartbeatTimer);
    this.stopTyping(false);
    this.subscribedChat = null;
    this.set({ typing: [] });
    if (this.state.fatal === 'BANNED') return;
    if (reason === 'io client disconnect') {
      this.setConnection('disconnected', reason);
      return;
    }
    this.setConnection('reconnecting', reason);
    if (reason === 'io server disconnect') {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.socket?.connect(), 3000);
    }
  }

  private onConnectError(err: Error) {
    const code = err?.message || 'NETWORK';
    const socket = this.socket;
    this.failures++;
    this.setConnection('reconnecting', code);
    if (socket && !socket.active) {
      // Refused by the server middleware: Socket.IO will not retry on its own.
      if (code === 'ORIGIN_NOT_ALLOWED') {
        this.emit('error', { code, message: 'Realtime connection refused', retryable: false });
        return;
      }
      const delay = code === 'RATE_LIMITED' ? 15000 : Math.min(30000, 1500 * 2 ** Math.min(this.failures, 4));
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        // An expired capability makes ticket minting fail: refresh the session first.
        const ready = code === 'AUTH_REQUIRED' ? this.refreshSession() : Promise.resolve(true);
        void ready.then(() => this.socket?.connect());
      }, delay);
    }
  }

  retryConnection() {
    this.failures = 0;
    this.set({ fatal: null });
    clearTimeout(this.retryTimer);
    if (!this.state.sessionReady || !this.state.configLoaded) void this.boot();
    else if (!this.socket) this.connectSocket();
    else if (!this.socket.connected) this.socket.connect();
  }

  whenReady(timeout = 20000): Promise<void> {
    if (this.preview || (this.state.sessionReady && this.api.capability)) return Promise.resolve();
    if (this.state.fatal === 'BANNED') return Promise.reject(new WidgetError(UNAVAILABLE));
    if (this.state.fatal && HIDDEN_CODES.includes(this.state.fatal))
      return Promise.reject(new WidgetError(this.state.fatal));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new WidgetError('NOT_CONNECTED')), timeout);
      this.readyWaiters.push([
        () => {
          clearTimeout(t);
          resolve();
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      ]);
    });
  }

  private rejectWaiters(e: Error) {
    for (const [, rej] of this.readyWaiters.splice(0)) rej(e);
  }

  /** Socket command with ack; throws ApiError on command.error / timeout. */
  private async command<T>(type: string, payload: Record<string, unknown>, timeout = 15000): Promise<T> {
    const s = this.socket;
    if (!s || !this.live()) throw new ApiError('NOT_CONNECTED', 'Socket not connected', 0, true);
    let ack: CommandAck;
    try {
      ack = (await s.timeout(timeout).emitWithAck('command', {
        v: 1,
        command_id: uuid(),
        type,
        payload: snakeKeys(payload),
      })) as CommandAck;
    } catch {
      throw new ApiError('TIMEOUT', 'Command timed out', 0, true);
    }
    if (ack?.type === 'command.ack') return camelize<T>(ack.result);
    const e = ack as Extract<CommandAck, { type: 'command.error' }>;
    throw new ApiError(e?.code || 'INTERNAL', e?.message || 'Command failed', 0, !!e?.retryable);
  }

  // ══════════════ Chats & realtime ══════════════

  private effectiveConfig(): WidgetConfig {
    const base = mergeWidgetConfig(this.serverConfig);
    const appearance = {
      ...base.appearance,
      ...(this.overrides.appearance ?? {}),
    } as WidgetConfig['appearance'];
    if (this.positionOverride) appearance.position = this.positionOverride;
    return {
      ...base,
      appearance,
      content: { ...base.content, ...(this.overrides.content ?? {}) } as WidgetConfig['content'],
    };
  }

  private recomputeLocale() {
    const site = this.state.config.content.language;
    const r = resolveLocale(this.preview ? this.previewLocale : this.sdkLocale, site, this.browserLocale);
    if (r.unsupported && r.unsupported !== this.emitted.unsupported) {
      this.emitted.unsupported = r.unsupported;
      this.emit('error', {
        code: 'UNSUPPORTED_LOCALE',
        message: `Locale "${r.unsupported}" is not supported; using "${r.locale}".`,
        retryable: false,
      });
    }
    if (r.locale !== this.state.locale) this.set({ locale: r.locale });
    return r.locale;
  }

  private readThrough(chatId: string): number {
    return store.json<Record<string, number>>('local', this.keys.read)?.[chatId] ?? 0;
  }

  private saveReadThrough(chatId: string, seq: number) {
    const map = store.json<Record<string, number>>('local', this.keys.read) ?? {};
    map[chatId] = Math.max(map[chatId] ?? 0, seq);
    store.set('local', this.keys.read, JSON.stringify(Object.fromEntries(Object.entries(map).slice(-20))));
  }

  private mapMessage(m: V2Message): UiMessage {
    return toMessage(m, this.state.conversation?.agents ?? [], this.readThrough(m.chatId));
  }

  /** Make a v2 chat the current conversation (optionally loading its transcript). */
  private async adoptChat(chat: V2Chat, loadMessages: boolean) {
    if (chat.status === 'closed' && chat.id === this.ui.dismissedConv) return;
    const prev = this.state.conversation;
    const sameChat = prev?.id === chat.id;
    if (sameChat && this.chatMeta && chat.version < this.chatMeta.version) return; // stale
    this.chatMeta = {
      id: chat.id,
      version: chat.version,
      lastSeq: Math.max(chat.lastSeq, sameChat ? (this.chatMeta?.lastSeq ?? 0) : 0),
    };
    const conv = toConversation(chat);
    const patch: Partial<State> = { conversation: conv };
    if (!sameChat) {
      patch.messages = this.state.messages.filter((m) => m.local);
      this.cursor = null;
    }
    if (chat.status !== 'closed') patch.proactive = [];
    this.set(patch);
    if (chat.status !== 'closed') this.checkStarted(conv, !loadMessages);
    if (this.live() && this.subscribedChat !== chat.id) await this.subscribeChat(chat.id);
    if (loadMessages) await this.loadMessages(chat.id);
  }

  /** The agent's opening message was written before this tab joined the chat; present it as it arrives. */
  private async adoptAgentOpened(chat: V2Chat) {
    const known = new Set(this.state.messages.map((m) => m.id));
    await this.adoptChat(chat, true);
    const opening = this.state.messages.filter((m) => !known.has(m.id) && isAgentText(m)).at(-1);
    if (opening) this.presentArrival(opening);
  }

  private async refreshChat() {
    const id = this.state.conversation?.id;
    if (!id) return;
    try {
      this.applyChat(await this.api.call<V2Chat>('GET', `/chats/${encodeURIComponent(id)}`));
    } catch {
      /* transient */
    }
  }

  /** Merge transcript pages (public seq gaps are normal: advance to through_seq, never loop). */
  private async loadMessages(chatId: string, afterSeq = 0) {
    let after = afterSeq;
    for (let i = 0; i < 20; i++) {
      let page: V2MessagePage;
      try {
        page = await this.api.call<V2MessagePage>(
          'GET',
          `/chats/${encodeURIComponent(chatId)}/messages?${after ? `after_seq=${after}&` : ''}limit=100`,
        );
      } catch {
        return;
      }
      if (this.state.conversation?.id !== chatId) return;
      for (const m of page.items) this.onMessage(this.mapMessage(m), false);
      if (this.chatMeta?.id === chatId)
        this.chatMeta.lastSeq = Math.max(this.chatMeta.lastSeq, page.lastSeq ?? 0);
      if (!page.hasMore || !page.throughSeq || page.throughSeq <= after) break;
      after = page.throughSeq;
    }
    this.markRead();
  }

  private async subscribeChat(chatId: string, useCursor = true): Promise<void> {
    const s = this.socket;
    if (!s?.connected) return;
    this.subscribedChat = chatId;
    const hadCursor = !!(useCursor && this.cursor);
    try {
      const ack = (await s.timeout(10000).emitWithAck('subscribe', {
        scopes: [{ kind: 'chat', id: chatId }],
        last_cursor: hadCursor ? this.cursor : null,
      })) as { type: string; snapshot_cursor?: string };
      if (ack?.type === 'snapshot.required') {
        this.cursor = null;
        await this.refreshChat();
        await this.loadMessages(chatId, 0);
        return this.subscribeChat(chatId, false);
      }
      if (!this.cursor && ack?.snapshot_cursor) this.cursor = ack.snapshot_cursor;
      // Without a replay cursor, fill anything that happened before the subscription (seq-based).
      if (!hadCursor) await this.loadMessages(chatId, this.maxSeq());
    } catch {
      this.subscribedChat = null;
    }
  }

  private maxSeq(): number {
    return this.state.messages.reduce((n, m) => Math.max(n, m.seq ?? 0), 0);
  }

  private onFrame(f: V2Frame) {
    if (!f || typeof f.type !== 'string') return;
    if (f.eventId) {
      if (this.seenEvents.has(f.eventId)) return;
      this.seenEvents.add(f.eventId);
      if (this.seenEvents.size > 1000)
        this.seenEvents.delete(this.seenEvents.values().next().value as string);
    }
    if (f.cursor) this.cursor = f.cursor;
    const p = f.payload ?? {};
    const current = this.state.conversation;
    switch (f.type) {
      case 'message.created': {
        const m = p.message as V2Message | undefined;
        if (!m) return;
        if (!current || m.chatId !== current.id) {
          if (!openConversation(this.state)) void this.refreshChatById(m.chatId);
          return;
        }
        if (this.chatMeta?.id === m.chatId) this.chatMeta.lastSeq = Math.max(this.chatMeta.lastSeq, m.seq);
        this.onMessage(this.mapMessage(m), true);
        if (m.sender?.type !== 'visitor') this.queueDelivered(m.chatId, m.seq);
        return;
      }
      case 'chat.updated':
      case 'chat.closed':
      case 'chat.requested': {
        const chat = p.chat as V2Chat | undefined;
        if (chat) this.applyChat(chat, f.type === 'chat.requested');
        else if (f.type === 'chat.closed') void this.refreshChat();
        return;
      }
      case 'participant.joined':
      case 'participant.left':
      case 'chat.transferred':
        void this.refreshChat();
        return;
      case 'message.read':
        if (typeof p.throughSeq !== 'number') return;
        if (p.actorType === 'visitor') this.markReadThrough(String(p.chatId ?? ''), p.throughSeq);
        else if (p.actorType === 'agent') this.setReceipt(String(p.chatId ?? ''), 'read', p.throughSeq);
        return;
      case 'rating.updated': {
        const c = this.state.conversation;
        if (c && (!p.chatId || p.chatId === c.id) && (p.rating === 'good' || p.rating === 'bad')) {
          this.set({
            conversation: {
              ...c,
              rating: (p.rating as string).toUpperCase() as Rating,
              ratingComment: (p.comment as string | null) ?? c.ratingComment,
            },
          });
        }
        return;
      }
      case 'config.published':
        void this.loadBootstrap().catch(() => undefined);
        return;
      case 'invitation.offered':
        this.onInvitation(p);
        return;
      case 'chat.opened_by_agent': {
        // An agent started a chat from the Visitors list. One open chat per visitor is enforced by the server.
        const chat = p.chat as V2Chat | undefined;
        const open = openConversation(this.state);
        if (chat && chat.status !== 'closed' && (!open || open.id === chat.id))
          void this.adoptAgentOpened(chat);
        return;
      }
      case 'attachment.updated':
        this.onAttachmentUpdated(p);
        return;
      case 'message.redacted': {
        const id = String(p.messageId ?? '');
        if (!id || !this.state.messages.some((m) => m.id === id)) return;
        this.set({
          messages: this.state.messages.map((m) =>
            m.id === id ? { ...m, body: '', attachments: [], options: [], redacted: true } : m,
          ),
        });
        return;
      }
    }
  }

  /** Delivery receipts to agents: coalesced (≤ 1 per ~400 ms per chat) and monotonic; errors ignored. */
  private queueDelivered(chatId: string, seq: number) {
    if (!chatId || !Number.isFinite(seq) || seq <= (this.deliveredSent.get(chatId) ?? 0)) return;
    const p = this.deliveredPending;
    this.deliveredPending = { chatId, seq: p && p.chatId === chatId ? Math.max(p.seq, seq) : seq };
    if (this.deliveredTimer) return;
    this.deliveredTimer = setTimeout(() => {
      this.deliveredTimer = undefined;
      const next = this.deliveredPending;
      this.deliveredPending = null;
      if (!next || next.seq <= (this.deliveredSent.get(next.chatId) ?? 0) || !this.live()) return;
      this.deliveredSent.set(next.chatId, next.seq);
      this.command('message.delivered', { chatId: next.chatId, lastDeliveredSeq: next.seq }).catch(
        () => undefined,
      );
    }, 400);
  }

  /** Agent receipts for the visitor's own messages (Delivered from the ephemeral frame, Read from `message.read`). */
  private setReceipt(chatId: string, kind: 'delivered' | 'read', seq: number) {
    if (!chatId || this.state.conversation?.id !== chatId) return;
    const cur =
      this.state.receipts?.chatId === chatId ? this.state.receipts : { chatId, delivered: 0, read: 0 };
    const next = { ...cur, [kind]: Math.max(cur[kind], seq) };
    if (kind === 'read') next.delivered = Math.max(next.delivered, seq); // read implies delivered
    if (next.delivered !== cur.delivered || next.read !== cur.read || this.state.receipts?.chatId !== chatId)
      this.set({ receipts: next });
  }

  /** Scan progress of a visitor upload (public chat scope) — resolves upload waiters and updates sent files. */
  private onAttachmentUpdated(p: Record<string, unknown>) {
    const id = String(p.attachmentId ?? '');
    if (!id) return;
    const update = {
      state: typeof p.state === 'string' ? p.state : undefined,
      errorCode: (p.errorCode as string | undefined) ?? null,
    };
    this.uploadWaiters.get(id)?.(update);
    if (!update.state) return;
    let changed = false;
    const messages = this.state.messages.map((m) => {
      if (!m.attachments.some((a) => a.id === id)) return m;
      changed = true;
      return {
        ...m,
        attachments: m.attachments.map((a) =>
          a.id === id ? { ...a, state: update.state, errorCode: update.errorCode } : a,
        ),
      };
    });
    if (changed) this.set({ messages });
  }

  private async refreshChatById(chatId: string) {
    try {
      this.applyChat(await this.api.call<V2Chat>('GET', `/chats/${encodeURIComponent(chatId)}`), true);
    } catch {
      /* ignore */
    }
  }

  /** Apply a chat resource from a frame / REST response. */
  private applyChat(chat: V2Chat, adoptIfNew = false) {
    const prev = this.state.conversation;
    if (!prev || prev.id !== chat.id) {
      if (
        adoptIfNew &&
        !openConversation(this.state) &&
        !(chat.status === 'closed' && chat.id === this.ui.dismissedConv)
      )
        void this.adoptChat(chat, true);
      return;
    }
    if (this.chatMeta && this.chatMeta.id === chat.id && chat.version < this.chatMeta.version) return; // stale aggregate version
    this.chatMeta = {
      id: chat.id,
      version: chat.version,
      lastSeq: Math.max(chat.lastSeq, this.chatMeta?.lastSeq ?? 0),
    };
    const conv = toConversation(chat);
    if (conv.status === 'RESOLVED' && conv.id === this.ui.dismissedConv) return;
    const patch: Partial<State> = { conversation: conv };
    if (conv.status !== 'WAITING') {
      patch.waitExceeded = null;
      if (this.state.offline?.reason === 'queue' && conv.status === 'ACTIVE') patch.offline = null;
    }
    this.set(patch);
    if (conv.status === 'RESOLVED' && prev.status !== 'RESOLVED')
      this.markEnded(conv.id, this.endingByVisitor ? 'visitor' : 'team');
    if (conv.status !== 'RESOLVED') this.checkStarted(conv);
  }

  private onEphemeral(e: { type: string; expiresAt?: string; payload: Record<string, unknown> }) {
    const p = e?.payload ?? {};
    if (e?.type === 'typing.changed') {
      const actor = (p.actor ?? {}) as { type?: string; displayName?: string };
      if (actor.type !== 'agent' || !this.state.conversation || p.chatId !== this.state.conversation.id)
        return;
      const name = actor.displayName || '';
      const id = `typing:${name}`;
      const known = this.state.conversation.agents.find((a) => a.name === name);
      clearTimeout(this.typingTimers.get(id));
      const others = this.state.typing.filter((a) => a.id !== id);
      if (p.isTyping) {
        const agent: PublicAgent = {
          id,
          name,
          avatarUrl: known?.avatarUrl ?? null,
          title: known?.title ?? null,
        };
        this.set({ typing: [...others, agent] });
        const ttl = e.expiresAt ? new Date(e.expiresAt).getTime() - Date.now() : 6000;
        this.typingTimers.set(
          id,
          setTimeout(
            () => this.set({ typing: this.state.typing.filter((a) => a.id !== id) }),
            Math.min(15000, Math.max(1000, Number.isFinite(ttl) ? ttl : 6000)),
          ),
        );
      } else {
        this.set({ typing: others });
      }
    } else if (e?.type === 'message.delivered') {
      if (p.actorType === 'agent' && typeof p.throughSeq === 'number')
        this.setReceipt(String(p.chatId ?? ''), 'delivered', p.throughSeq);
    } else if (e?.type === 'queue.wait_exceeded') {
      const c = this.state.conversation;
      if (!c || p.chatId !== c.id || c.status !== 'WAITING') return;
      this.set({ waitExceeded: { chatId: c.id, waitedSeconds: Number(p.waitedSeconds) || 0 } });
    } else if (e?.type === 'availability.changed') {
      const a = p as unknown as V2Availability;
      if (!a.state) return;
      const account = toAccount(a);
      const patch: Partial<State> = { account };
      if (account.online && this.state.offline?.reason === 'offline' && !this.state.offlineDraft?.message)
        patch.offline = null;
      this.set(patch);
      if (this.emitted.online !== account.online) {
        this.emitted.online = account.online;
        this.emit('availability.changed', this.availabilityPayload(account.online));
      }
    }
  }

  private onControl(c: { type: string }) {
    if (c?.type !== 'access.revoked' || this.resetting) return;
    // Drop everything we know and start a fresh session (may surface BANNED).
    this.resetLocal();
    this.socket?.disconnect();
    void this.refreshSession().then((ok) => ok && this.socket?.connect());
  }

  private onInvitation(p: Record<string, unknown>) {
    if (openConversation(this.state) || typeof p.message !== 'string' || !p.invitationId) return;
    const id = String(p.invitationId);
    if ([...this.invitationIds.values()].includes(id)) return;
    const expiresAt = typeof p.expiresAt === 'string' ? new Date(p.expiresAt).getTime() : NaN;
    if (Number.isFinite(expiresAt)) {
      if (expiresAt <= Date.now()) return;
      // Expired invitations disappear (accepting one would answer 409).
      setTimeout(
        () => this.set({ proactive: this.state.proactive.filter((x) => x.id !== `invitation-${id}`) }),
        Math.min(expiresAt - Date.now(), 2 ** 31 - 1),
      );
    }
    const m: MessageDTO = {
      id: `invitation-${id}`,
      conversationId: '',
      type: 'TEXT',
      authorType: 'TRIGGER',
      agentId: null,
      authorName: String(p.attribution ?? this.state.config.appearance.companyName),
      authorAvatarUrl: null,
      body: p.message,
      attachments: [],
      event: null,
      options: [],
      clientId: null,
      createdAt: new Date().toISOString(),
      readByVisitorAt: null,
    };
    this.invitationIds.set(proactiveKey(m), id);
    this.set({ proactive: [...this.state.proactive, m] });
    if (this.state.open) this.markSeen(proactiveKey(m));
  }

  /** Invitation funnel: socket commands when connected (`invitation.ack` / `invitation.dismiss`), REST otherwise. */
  private invitationAction(id: string, action: 'displayed' | 'dismiss') {
    const live = this.live();
    const run =
      action === 'displayed'
        ? live
          ? this.command('invitation.ack', { invitationId: id, displayedAtClient: new Date().toISOString() })
          : this.api.call('POST', `/invitations/${encodeURIComponent(id)}/displayed`, {
              displayedAtClient: new Date().toISOString(),
            })
        : live
          ? this.command('invitation.dismiss', { invitationId: id })
          : this.api.call('POST', `/invitations/${encodeURIComponent(id)}/dismiss`, {});
    return run.catch(() => undefined);
  }

  /** The invitation the visitor is answering (accepted card, or the latest unexpired proactive offer). */
  private pendingInvitation(): string | null {
    if (this.acceptedInvitation && [...this.invitationIds.values()].includes(this.acceptedInvitation))
      return this.acceptedInvitation;
    const last = this.state.proactive[this.state.proactive.length - 1];
    return last ? (this.invitationIds.get(proactiveKey(last)) ?? null) : null;
  }

  private onMessage(m: UiMessage, live: boolean) {
    if (m.type === 'EVENT' && !m.event) return;
    const s = this.state;
    const idx = s.messages.findIndex(
      (x) => x.id === m.id || (!!m.clientId && x.clientId === m.clientId && x.authorType === 'VISITOR'),
    );
    const isNew = idx < 0;
    let messages = isNew
      ? [...s.messages, m]
      : s.messages.map((x, i) => (i === idx ? mergeIncoming(x, m) : x));
    if (m.seq !== undefined) messages = sortBySeq(messages);
    if (m.clientId && !s.messages[idx]?.upload) this.sendMeta.delete(m.clientId);
    const patch: Partial<State> = { messages };
    if (isNew && isAgentText(m)) patch.typing = s.typing.filter((a) => a.name !== m.authorName);
    if (m.type === 'EVENT' && m.event?.kind === 'chat.rating_requested') patch.ratingRequested = true;
    this.set(patch);
    if (isNew && live) this.presentArrival(m);
  }

  /** What a newly arrived message does beyond the transcript: announcement, host event, chime, auto-open. */
  private presentArrival(m: UiMessage) {
    if (isAgentText(m)) {
      // One short sentence for screen readers; history and the visitor's own messages are never announced.
      const text = m.body.length > 140 ? `${m.body.slice(0, 139)}…` : m.body;
      this.set({ announcement: { name: m.authorName, text, n: (this.state.announcement?.n ?? 0) + 1 } });
    }
    if (isAgentText(m) || m.type === 'EVENT') {
      this.emit('message.received', {
        chatId: m.conversationId,
        messageId: m.id,
        type: m.type === 'EVENT' ? 'system' : m.authorType === 'AGENT' ? 'agent' : 'automated',
      });
    }
    if (isAgentText(m)) {
      const st = this.state;
      const attentive = st.open && st.hostVisible && st.hostFocused;
      if (st.config.behavior.sound && st.soundOn && !attentive) blip();
      if (
        m.authorType === 'AGENT' &&
        st.config.behavior.openOnAgentMessage &&
        !st.open &&
        !isHidden(st) &&
        !st.viewport.compact &&
        !st.hideLauncher
      ) {
        this.open('agent', false);
      }
      this.markRead();
    }
  }

  private checkStarted(c: { id: string; status: string; agents: unknown[] }, silent = false) {
    if (this.startedChats.has(c.id) || c.status !== 'ACTIVE' || !c.agents.length) return;
    this.startedChats.add(c.id);
    if (!silent) this.emit('chat.started', { chatId: c.id });
  }

  private markEnded(chatId: string, reason: 'visitor' | 'team') {
    this.set({ typing: [], ratingRequested: false });
    this.emit('chat.ended', { chatId, reason });
    this.endingByVisitor = false;
  }

  private markReadThrough(chatId: string, seq: number) {
    if (!chatId || this.state.conversation?.id !== chatId) return;
    this.saveReadThrough(chatId, seq);
    const at = new Date().toISOString();
    this.set({
      messages: this.state.messages.map((m) =>
        isAgentText(m) && !m.readByVisitorAt && (m.seq ?? Infinity) <= seq
          ? { ...m, readByVisitorAt: at }
          : m,
      ),
    });
  }

  /**
   * Blocked visitor: neutral "service unavailable", no transport. BANNED is internal only — the host page
   * and SDK callers only ever see the neutral SERVICE_UNAVAILABLE code.
   */
  private onBanned() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.greetingTimer);
    clearTimeout(this.capabilityTimer);
    clearTimeout(this.retryTimer);
    // Settle every queued send so SDK promises (startChat / sendMessage) never hang.
    for (const [clientId, meta] of this.sendMeta) {
      meta.done?.({ ok: false, error: UNAVAILABLE });
      this.sendMeta.delete(clientId);
    }
    this.set({ fatal: 'BANNED', conversation: null, messages: [], proactive: [], typing: [] });
    this.setConnection('failed', UNAVAILABLE);
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.api.capability = null;
    this.rejectWaiters(new WidgetError(UNAVAILABLE));
  }

  private armGreeting() {
    const g = this.state.config.behavior.greeting;
    clearTimeout(this.greetingTimer);
    if (!g.enabled || this.state.greetingDue) return;
    this.greetingTimer = setTimeout(
      () => this.set({ greetingDue: true }),
      Math.max(0, g.delaySeconds) * 1000,
    );
  }

  private beat() {
    if (this.live())
      this.socket!.emit('heartbeat', { visible: this.state.hostVisible, focused: this.state.hostFocused });
  }

  /** Page view events are sent only with analytics consent (the server enforces it too). */
  private sendPageEvent(kind: 'entered' | 'left' = 'entered') {
    if (this.preview || !this.analyticsAllowed || !this.api.capability || this.consent?.analytics === false)
      return;
    const p = this.page;
    void this.api
      .call('POST', '/events', {
        events: [
          {
            id: uuid(),
            kind,
            url: p.url.slice(0, 4000),
            title: (p.title || '').slice(0, 1000),
            clientAt: new Date().toISOString(),
          },
        ],
      })
      .catch(() => undefined);
  }

  // ══════════════ Host bridge ══════════════

  private onHost(m: HostMessage) {
    switch (m.type) {
      case 'init': {
        const first = !this.hostInit;
        this.hostInit = true;
        this.page = {
          url: String(m.page?.url || location.href),
          title: String(m.page?.title || ''),
          referrer: m.page?.referrer ? String(m.page.referrer) : null,
        };
        this.initInfo = {
          locale: String(m.locale || ''),
          timezone: String(m.timezone || ''),
          screen: String(m.screen || ''),
        };
        if (m.locale) this.browserLocale = String(m.locale);
        const patch: Partial<State> = { pageUrl: this.page.url };
        if (m.viewport) patch.viewport = m.viewport;
        if (first && m.settings) {
          this.identityToken = m.settings.identityToken || null;
          this.sdkLocale = m.settings.locale || null;
          this.positionOverride = m.settings.position || null;
          patch.hideLauncher = !!m.settings.hideLauncher;
        }
        if (first) this.handoffCode = m.settings?.handoffCode || handoffFromUrl(this.page.url);
        this.set(patch);
        this.set({ config: this.effectiveConfig() });
        this.recomputeLocale();
        this.lastLayout = '';
        if (this.layoutCache) this.postLayout(this.layoutCache);
        if (first) this.startConnection();
        break;
      }
      case 'viewport':
        this.set({ viewport: m.viewport });
        break;
      case 'page':
        this.onPage(m.page);
        break;
      case 'visibility':
        this.set({ hostVisible: !!m.visible, hostFocused: !!m.focused });
        this.beat();
        this.markRead();
        break;
      case 'api':
        void this.runApi(m.id, m.method, Array.isArray(m.args) ? m.args : []);
        break;
    }
  }

  private async runApi(id: number, method: string, args: unknown[]) {
    try {
      const result = await this.sdkCommand(method, args);
      this.host.post({
        source: FRAME_SOURCE,
        type: 'api:result',
        id,
        ok: true,
        result: result === undefined ? null : result,
      });
    } catch (err) {
      const code = err instanceof ApiError || err instanceof WidgetError ? err.code : 'FAILED';
      this.host.post({ source: FRAME_SOURCE, type: 'api:result', id, ok: false, error: code });
    }
  }

  private onPage(page: PageInfo) {
    if (!page || typeof page.url !== 'string') return;
    this.page = { url: page.url, title: String(page.title || ''), referrer: page.referrer ?? null };
    this.set({ pageUrl: page.url });
    this.sendPageEvent('entered');
  }

  // ══════════════ SDK commands ══════════════

  private async sdkCommand(method: string, args: unknown[]): Promise<unknown> {
    const a0 = args[0];
    switch (method) {
      case 'open':
        this.open('api', true);
        return undefined;
      case 'close':
        this.close('api');
        return undefined;
      case 'toggle':
        if (this.state.open && !this.state.closing) this.close('api');
        else this.open('api', true);
        return !this.state.closing && this.state.open;
      case 'show':
        this.set({ hiddenByApi: false });
        return undefined;
      case 'hide':
        this.set({ hiddenByApi: true });
        return undefined;
      case 'identify':
        return this.identify(a0);
      case 'resetIdentity':
        await this.resetIdentity();
        return undefined;
      case 'setDepartment':
        if (a0 !== null && typeof a0 !== 'string') throw new WidgetError('INVALID_ARGUMENT');
        // API v2 has no visitor-level department preset: applied when the next chat is requested.
        this.set({ departmentId: a0 });
        return undefined;
      case 'setTags':
      case 'addTags':
      case 'removeTags':
        await this.updateTags(a0, method);
        return undefined;
      case 'setCustomFields': {
        if (!isObject(a0)) throw new WidgetError('INVALID_ARGUMENT');
        await this.whenReady();
        // Only `public_writable` definitions are accepted; the server answers VALIDATION_FAILED otherwise.
        await this.api.call('PUT', '/visitor/custom-fields', { customFields: a0 });
        return undefined;
      }
      case 'setLocale':
        if (a0 !== null && typeof a0 !== 'string') throw new WidgetError('INVALID_ARGUMENT');
        this.sdkLocale = (a0 as string | null) || null;
        this.recomputeLocale();
        return undefined;
      case 'updateSettings': {
        const patch = sanitizeSettingsPatch(a0);
        this.overrides = {
          appearance: { ...this.overrides.appearance, ...patch.appearance },
          content: { ...this.overrides.content, ...patch.content },
        };
        this.set({ config: this.effectiveConfig() });
        this.recomputeLocale();
        // Promise<Config>: the published configuration with the page's presentation overrides applied.
        return JSON.parse(JSON.stringify(this.state.config)) as unknown;
      }
      case 'trackPage': {
        if (!isObject(a0) || typeof a0.url !== 'string' || !/^https?:\/\//i.test(a0.url))
          throw new WidgetError('INVALID_ARGUMENT');
        this.onPage({
          url: a0.url,
          title: typeof a0.title === 'string' ? a0.title : '',
          referrer: this.page.url,
        });
        return undefined;
      }
      case 'setConsent':
        await this.setConsent(a0);
        return undefined;
      case 'startChat':
        return this.startChat(a0);
      case 'endChat':
        await this.endChat(true);
        return undefined;
      case 'sendMessage': {
        const text = str(a0);
        if (!text) throw new WidgetError('INVALID_ARGUMENT');
        const r = await this.send(text);
        if (!r.ok) throw new WidgetError(r.error);
        return { chatId: r.chatId };
      }
      default:
        throw new WidgetError('UNKNOWN_COMMAND');
    }
  }

  /** SDK tags: slugs of existing tags; the widget owns the client-sourced set (agent tags are never touched). */
  private async updateTags(input: unknown, mode: string) {
    if (!Array.isArray(input) || !input.every((t) => typeof t === 'string'))
      throw new WidgetError('INVALID_ARGUMENT');
    const tags = (input as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean);
    const next = new Set(mode === 'setTags' ? [] : this.clientTags);
    for (const t of tags) mode === 'removeTags' ? next.delete(t) : next.add(t);
    if (next.size > 20) throw new WidgetError('INVALID_ARGUMENT', 'At most 20 tags');
    await this.whenReady();
    const r = await this.api.call('PUT', '/visitor/tags', { tags: [...next] });
    this.clientTags = next;
    return r;
  }

  private async identify(input: unknown) {
    if (!isObject(input)) throw new WidgetError('INVALID_ARGUMENT');
    const token = str(input.externalIdToken) ?? str(input.token) ?? str(input.identityToken);
    const name = str(input.name)?.slice(0, 100);
    const email = str(input.email)?.slice(0, 200);
    if (email && !EMAIL_RE.test(email)) throw new WidgetError('INVALID_EMAIL');
    if (!token && !name && !email) throw new WidgetError('INVALID_ARGUMENT');
    if (!this.connectStarted && token) {
      this.identityToken = token; // used by the first /sessions call
      await this.whenReady();
      return this.identityResult();
    }
    await this.whenReady();
    type IdentifyResult = { visitorId: string; verified: boolean; displayName: string };
    let r: IdentifyResult;
    try {
      // name/email are unverified prefill; the external id token (JWT) verifies the visitor in place.
      r = await this.api.call<IdentifyResult>('POST', '/identity', {
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
        ...(token ? { externalIdToken: token } : {}),
      });
    } catch (err) {
      // The identity belongs to another profile: start a new session bound to it.
      if (!(
        token &&
        err instanceof ApiError &&
        err.code === 'CONFLICT' &&
        err.details?.action === 'create_session'
      ))
        throw err;
      this.identityToken = token;
      this.socket?.disconnect();
      await this.openSession();
      this.socket?.connect();
      return this.identityResult();
    }
    if (token) this.identityToken = token;
    const v = this.state.visitor;
    if (v)
      this.set({
        visitor: { ...v, name: name ?? v.name, email: email ?? v.email },
        verified: !!r.verified || this.state.verified,
      });
    this.emit('identity.changed', { verified: !!r.verified, visitorId: r.visitorId });
    return { visitorId: r.visitorId, verified: !!r.verified || this.state.verified };
  }

  /** SDK IdentityResult: the visitor the page is now talking as. */
  private identityResult(): { visitorId: string | null; verified: boolean } {
    return { visitorId: this.state.visitor?.id ?? null, verified: this.state.verified };
  }

  /** SDK Chat: the public projection of a conversation (same shape as getState().chat). */
  private chatResult(): { id: string; status: string } | null {
    const c = openConversation(this.state) ?? this.state.conversation;
    return c ? { id: c.id, status: c.status } : null;
  }

  /** availability.changed payload: { state, departmentId, nextOpenAt }. */
  private availabilityPayload(online: boolean) {
    return {
      state: online ? 'online' : 'offline',
      departmentId: this.state.departmentId ?? null,
      nextOpenAt: this.state.account?.nextOpenAt ?? null,
    };
  }

  private resetLocal() {
    this.identityToken = null;
    this.saveUi({ open: this.state.open, seen: [], dismissedConv: null });
    this.sendMeta.clear();
    this.files.clear();
    this.startedChats.clear();
    this.chatMeta = null;
    this.cursor = null;
    this.subscribedChat = null;
    this.emitted.visitor = '';
    this.set({
      visitor: null,
      verified: false,
      conversation: null,
      messages: [],
      proactive: [],
      typing: [],
      seen: [],
      offline: null,
      offlineDraft: null,
      offlineSent: null,
      prechatDone: false,
      departmentId: null,
      ratingRequested: false,
    });
  }

  /** Host logout: the server revokes this browser's credential + capability and returns a fresh anonymous context. */
  private async resetIdentity() {
    const token = readVisitorToken(this.keys.visitor);
    // Drop the realtime link first so the revocation of the old capability (access.revoked) and
    // 401s from in-flight requests cannot start a competing session while we reset.
    this.resetting = true;
    this.socket?.disconnect();
    try {
      let fresh: V2Session | null = null;
      if (this.api.capability) {
        fresh = await this.api
          .call<V2Session>(
            'POST',
            '/identity/reset',
            { anonymousToken: token, ...this.sessionContext() },
            { retried: true },
          )
          .catch(() => null);
      }
      writeVisitorToken(this.keys.visitor, null);
      store.set('session', this.keys.session, null);
      store.set('local', this.keys.read, null);
      this.clientTags = new Set();
      this.invitationIds.clear();
      this.resetLocal();
      this.api.capability = null;
      if (this.connectStarted) {
        if (fresh?.capability) await this.applySession(fresh);
        else await this.openSession();
      }
    } finally {
      this.resetting = false;
    }
    if (this.connectStarted) this.socket?.connect();
    return true;
  }

  private async setConsent(input: unknown) {
    if (!isObject(input) || typeof input.analytics !== 'boolean' || typeof input.policyVersion !== 'string')
      throw new WidgetError('INVALID_ARGUMENT');
    const policyVersion = input.policyVersion.slice(0, 40);
    this.consent = {
      analytics: input.analytics,
      policyVersion,
      at: new Date().toISOString(),
      ...(typeof input.service === 'boolean' ? { service: input.service } : {}),
    };
    store.set('local', this.keys.consent, JSON.stringify(this.consent));
    if (this.api.capability) {
      await this.api.call('PUT', '/consent', {
        purpose: 'analytics',
        state: input.analytics ? 'granted' : 'denied',
        policyVersion,
      });
      if (typeof input.service === 'boolean')
        await this.api.call('PUT', '/consent', {
          purpose: 'service',
          state: input.service ? 'granted' : 'denied',
          policyVersion,
        });
      const was = this.analyticsAllowed;
      this.analyticsAllowed = input.analytics;
      if (input.analytics && !was) this.sendPageEvent('entered');
    }
    return true;
  }

  private async startChat(input: unknown) {
    const opts = isObject(input) ? input : {};
    if (opts.departmentId !== undefined) {
      if (opts.departmentId !== null && typeof opts.departmentId !== 'string')
        throw new WidgetError('INVALID_ARGUMENT');
      this.set({ departmentId: opts.departmentId as string | null });
    }
    this.open('api', true);
    const text = str(opts.message);
    // Without a message nothing is created (agents never get empty chats): the open chat, if any, or null.
    if (!text) return this.chatResult();
    this.set({ prechatDone: true });
    const r = await this.send(text, { departmentId: this.state.departmentId });
    if (!r.ok) throw new WidgetError(r.error);
    return this.chatResult() ?? { id: r.chatId, status: 'WAITING' };
  }

  // ══════════════ UI actions ══════════════

  open(source: OpenSource, focus = true) {
    const s = this.state;
    if (s.banned || (s.open && !s.closing)) return;
    clearTimeout(this.closeTimer);
    const inv = s.invitation;
    // Accepting is deferred to the visitor's first message so agents never get an empty chat.
    if (inv && inv.kind !== 'message') this.acceptedInvitation = this.invitationIds.get(inv.id) ?? null;
    const seen = [...s.seen];
    if (inv && !seen.includes(inv.id)) seen.push(inv.id);
    for (const p of s.proactive) if (!seen.includes(proactiveKey(p))) seen.push(proactiveKey(p));
    this.saveUi({ open: true, seen });
    this.set({
      open: true,
      closing: false,
      openFocus: focus,
      hiddenByApi: source === 'api' ? false : s.hiddenByApi,
      seen,
      focusReturn: false,
    });
    this.emit('opened', { source });
    this.markRead();
  }

  close(source: CloseSource) {
    const s = this.state;
    if (!s.open || s.closing) return;
    this.stopTyping();
    this.saveUi({ open: false });
    const userInitiated = source === 'button' || source === 'escape';
    this.focusLauncherFlag = userInitiated;
    if (this.preview || s.standalone) {
      this.set({ open: false, closing: false, focusReturn: userInitiated });
    } else {
      this.set({ closing: true, focusReturn: userInitiated });
      this.closeTimer = setTimeout(() => this.set({ open: false, closing: false }), 190);
    }
    this.emit('closed', { source });
  }

  dismissInvitation() {
    const inv = this.state.invitation;
    if (!inv) return;
    const serverId = this.invitationIds.get(inv.id);
    if (serverId) void this.invitationAction(serverId, 'dismiss');
    this.markSeen(inv.id);
  }

  toggleSound() {
    const soundOn = !this.state.soundOn;
    store.set('local', this.keys.prefs, JSON.stringify({ sound: soundOn }));
    this.set({ soundOn });
    if (soundOn) unlockAudio();
  }

  private markRead() {
    const s = this.state;
    if (!s.open || s.closing || !s.hostVisible) return;
    const unread = s.messages.filter((m) => isAgentText(m) && !m.readByVisitorAt);
    if (!unread.length) return;
    const conv = s.conversation;
    const seq = this.maxSeq();
    if (conv && seq && !this.preview) {
      this.saveReadThrough(conv.id, seq);
      if (s.features.readReceipts && this.api.capability) {
        const payload = { chatId: conv.id, lastReadSeq: seq };
        (this.live()
          ? this.command('message.read', payload)
          : this.api.call('PUT', `/chats/${encodeURIComponent(conv.id)}/read-cursor`, { lastReadSeq: seq })
        ).catch(() => undefined);
      }
    }
    const at = new Date().toISOString();
    this.set({
      messages: s.messages.map((m) =>
        isAgentText(m) && !m.readByVisitorAt ? { ...m, readByVisitorAt: at } : m,
      ),
    });
  }

  // Typing (visitor → agents): at most one `typing.set` per 2 s, stop after 3 s idle or on send.
  typing(text: string) {
    const conv = openConversation(this.state);
    if (this.preview || !conv) return;
    const t = this.visitorTyping;
    t.text = text;
    clearTimeout(t.idle);
    if (!text.trim()) return this.stopTyping();
    const emitNow = () => {
      if (!this.live() || !t.text.trim()) return;
      t.sentAt = Date.now();
      t.active = true;
      this.command('typing.set', { chatId: conv.id, isTyping: true }).catch(() => undefined);
    };
    const since = Date.now() - t.sentAt;
    if (since >= 2000) emitNow();
    else if (!t.trail) {
      t.trail = setTimeout(() => {
        t.trail = undefined;
        emitNow();
      }, 2000 - since);
    }
    t.idle = setTimeout(() => this.stopTyping(), 3000);
  }

  private stopTyping(emit = true) {
    const t = this.visitorTyping;
    clearTimeout(t.idle);
    clearTimeout(t.trail);
    t.trail = undefined;
    t.text = '';
    const conv = openConversation(this.state);
    if (t.active && emit && conv && this.live())
      this.command('typing.set', { chatId: conv.id, isTyping: false }).catch(() => undefined);
    t.active = false;
  }

  private localMessage(clientId: string, body: string): UiMessage {
    const s = this.state;
    return {
      id: `local-${clientId}`,
      conversationId: openConversation(s)?.id ?? '',
      type: 'TEXT',
      authorType: 'VISITOR',
      agentId: null,
      authorName: s.visitor?.name ?? '',
      authorAvatarUrl: null,
      body,
      attachments: [],
      event: null,
      options: [],
      clientId,
      createdAt: new Date().toISOString(),
      readByVisitorAt: null,
      local: 'pending',
    };
  }

  /** Optimistic send. Resolves when the server accepted (or definitively refused) the message. */
  send(
    body: string,
    opts: { profile?: VisitorProfileInput; departmentId?: string | null } = {},
  ): Promise<SendResult> {
    const text = body.replace(/\s+$/, '').slice(0, 8000);
    if (!text.trim()) return Promise.resolve({ ok: false, error: 'EMPTY' });
    // A blocked / unavailable widget can never deliver: fail fast instead of queueing forever.
    const fatal = this.state.fatal;
    if (fatal === 'BANNED' || (fatal && HIDDEN_CODES.includes(fatal)))
      return Promise.resolve({ ok: false, error: fatal === 'BANNED' ? UNAVAILABLE : fatal });
    this.stopTyping();
    const clientId = uuid();
    const msg = this.localMessage(clientId, text);
    if (this.preview) {
      this.set({ messages: [...this.state.messages, { ...msg, local: undefined }], prechatDone: true });
      return Promise.resolve({ ok: true, chatId: this.state.conversation?.id ?? 'preview-conversation' });
    }
    return new Promise((resolve) => {
      this.sendMeta.set(clientId, {
        departmentId: opts.departmentId ?? this.state.departmentId,
        profile: opts.profile,
        done: resolve,
      });
      this.set({ messages: [...this.state.messages, msg] });
      void this.pump();
    });
  }

  retry(clientId: string) {
    const m = this.state.messages.find((x) => x.clientId === clientId);
    if (!m || !m.local) return;
    if (m.upload) return void this.runUpload(clientId);
    this.patchMessage(clientId, { local: 'pending', errorCode: undefined });
    void this.pump();
  }

  removeMessage(clientId: string) {
    const m = this.state.messages.find((x) => x.clientId === clientId);
    if (m?.upload?.previewUrl) URL.revokeObjectURL(m.upload.previewUrl);
    this.files.delete(clientId);
    this.sendMeta.delete(clientId);
    this.set({ messages: this.state.messages.filter((x) => x.clientId !== clientId || !x.local) });
  }

  private patchMessage(clientId: string, patch: Partial<UiMessage>) {
    this.set({
      messages: this.state.messages.map((m) => (m.clientId === clientId && m.local ? { ...m, ...patch } : m)),
    });
  }

  /** Deliver one message to a chat: socket command when connected, REST otherwise. */
  private async deliver(
    chatId: string,
    clientId: string,
    body: string,
    attachmentIds: string[],
  ): Promise<V2Message> {
    const payload = { chatId, clientMessageId: clientId, body: body || null, attachmentIds };
    if (this.live()) {
      try {
        return await this.command<V2Message>('message.send', payload);
      } catch (err) {
        if (codeOf(err) !== 'TIMEOUT' && codeOf(err) !== 'NOT_CONNECTED') throw err;
      }
    }
    return this.api.call<V2Message>('POST', `/chats/${encodeURIComponent(chatId)}/messages`, {
      clientMessageId: clientId,
      body: body || null,
      attachmentIds,
    });
  }

  /** Send pending messages one at a time (keeps chat creation race-free). */
  private async pump(): Promise<void> {
    if (this.inflight || !this.state.sessionReady || !this.api.capability || this.state.fatal) return;
    const m = this.state.messages.find((x) => x.local === 'pending' && !x.upload);
    if (!m || !m.clientId) return;
    this.inflight = true;
    const clientId = m.clientId;
    const meta = this.sendMeta.get(clientId) ?? {};
    try {
      const conv = openConversation(this.state);
      let message: V2Message;
      if (!conv) {
        const profile = meta.profile ?? {};
        type Admission = { chat: V2Chat; initialMessage: V2Message | null };
        let created: Admission | null = null;
        let invitationId = this.pendingInvitation();
        if (invitationId) {
          // Answering an invitation: accept it (creates the chat once, with the invitation message), then send.
          try {
            created = await this.api.call<Admission>(
              'POST',
              `/invitations/${encodeURIComponent(invitationId)}/accept`,
              { clientRequestId: `accept-${uuid()}` },
            );
          } catch (err) {
            if (codeOf(err) === 'DEPARTMENT_UNAVAILABLE' || codeOf(err) === 'BANNED') throw err;
            invitationId = null; // expired / dismissed: fall back to a normal chat request
          }
        }
        created ??= await this.api.call<Admission>('POST', '/chats', {
          clientRequestId: clientId,
          message: m.body || null,
          departmentId: meta.departmentId || undefined,
          fields: Object.keys(profile).length ? profile : undefined,
          pageUrl: this.page.url.slice(0, 4000),
        });
        await this.adoptChat(created.chat, false);
        this.saveUi({ dismissedConv: null });
        if (created.initialMessage || invitationId) {
          this.emit('chat.requested', { chatId: created.chat.id });
          if (invitationId) this.emit('invitation.accepted', { invitationId, chatId: created.chat.id });
        }
        this.acceptedInvitation = null;
        // Invitation accept / already-open chat (no initial message) or an attachment: deliver separately.
        message =
          created.initialMessage && !meta.attachmentIds?.length
            ? created.initialMessage
            : await this.deliver(created.chat.id, clientId, m.body, meta.attachmentIds ?? []);
        void this.loadMessages(created.chat.id, 0);
      } else {
        message = await this.deliver(conv.id, clientId, m.body, meta.attachmentIds ?? []);
      }
      this.onDelivered(clientId, message, meta);
    } catch (err) {
      this.onSendError(clientId, m, meta, err);
    } finally {
      this.inflight = false;
    }
    void this.pump();
  }

  private onDelivered(clientId: string, message: V2Message, meta: SendMeta) {
    const mapped = this.mapMessage(message);
    const s = this.state;
    const local = s.messages.find((x) => x.clientId === clientId);
    if (local?.upload?.previewUrl) URL.revokeObjectURL(local.upload.previewUrl);
    let messages = s.messages.filter((x) => x.id !== mapped.id || x.clientId === clientId);
    messages = messages.some((x) => x.clientId === clientId)
      ? messages.map((x) => (x.clientId === clientId ? mapped : x))
      : [...messages, mapped];
    this.files.delete(clientId);
    this.sendMeta.delete(clientId);
    this.set({ messages: sortBySeq(messages), offline: null, offlineDraft: null, prechatDone: true });
    if (this.chatMeta?.id === message.chatId)
      this.chatMeta.lastSeq = Math.max(this.chatMeta.lastSeq, message.seq);
    meta.done?.({ ok: true, chatId: message.chatId });
  }

  private onSendError(clientId: string, m: UiMessage, meta: SendMeta, err: unknown) {
    const code = codeOf(err);
    const s = this.state;
    if (
      (code === 'NETWORK' || code === 'TIMEOUT' || code === 'NOT_CONNECTED') &&
      s.connection !== 'connected'
    )
      return; // stays pending
    if (code === 'DEPARTMENT_UNAVAILABLE' || code === 'OFFLINE') {
      const details = (err instanceof ApiError ? err.details : null) ?? {};
      const deptName = s.account?.departments.find((d) => d.id === meta.departmentId)?.name;
      const reason: 'offline' | 'department' =
        meta.departmentId &&
        details.reason !== 'offline' &&
        details.offline_form !== true &&
        s.account?.online
          ? 'department'
          : 'offline';
      this.sendMeta.delete(clientId);
      this.set({
        messages: s.messages.filter((x) => x.clientId !== clientId),
        offline: reason === 'department' ? { reason, department: deptName } : { reason: 'offline' },
        offlineDraft: {
          ...s.offlineDraft,
          ...meta.profile,
          departmentId: meta.departmentId ?? s.offlineDraft?.departmentId ?? null,
          message: [s.offlineDraft?.message, m.body].filter(Boolean).join('\n'),
        },
        offlineDraftRev: s.offlineDraftRev + 1,
        account: reason === 'offline' && s.account ? { ...s.account, online: false } : s.account,
      });
      meta.done?.({ ok: false, error: code });
      return;
    }
    if (code === 'CHAT_CLOSED') {
      // Keep the text as a draft and show the ended state.
      this.sendMeta.delete(clientId);
      if (m.body) this.draft = [m.body, this.draft].filter(Boolean).join('\n');
      this.set({ messages: s.messages.filter((x) => x.clientId !== clientId) });
      void this.refreshChat();
      meta.done?.({ ok: false, error: code });
      return;
    }
    if (code === 'BANNED') {
      meta.done?.({ ok: false, error: UNAVAILABLE });
      this.sendMeta.delete(clientId);
      this.onBanned();
      return;
    }
    this.patchMessage(clientId, { local: 'failed', errorCode: code });
    if (code === 'RATE_LIMITED') {
      this.emit('error', { code, message: 'Messages are being sent too quickly', retryable: true });
      setTimeout(() => this.retry(clientId), 5000);
    }
    meta.done?.({ ok: false, error: code });
    this.sendMeta.set(clientId, { ...meta, done: undefined });
  }

  sendFiles(list: FileList | File[]) {
    if (!this.state.config.behavior.attachments.enabled || !this.state.features.files) return;
    for (const file of Array.from(list).slice(0, 5)) {
      const clientId = uuid();
      const isImage = isPreviewableImage(file.type);
      const msg: UiMessage = {
        ...this.localMessage(clientId, ''),
        upload: {
          name: file.name,
          size: file.size,
          mimeType: file.type,
          isImage,
          progress: 0,
          previewUrl: isImage ? URL.createObjectURL(file) : null,
        },
      };
      this.files.set(clientId, file);
      this.set({ messages: [...this.state.messages, msg] });
      void this.runUpload(clientId);
    }
  }

  private async runUpload(clientId: string) {
    const file = this.files.get(clientId);
    const m = this.state.messages.find((x) => x.clientId === clientId);
    if (!file || !m?.upload) return;
    this.patchMessage(clientId, {
      local: 'pending',
      errorCode: undefined,
      uploadPhase: 'uploading',
      upload: { ...m.upload, progress: 0 },
    });
    const fail = (code: string) =>
      this.patchMessage(clientId, { local: 'failed', errorCode: code, uploadPhase: undefined });
    if (file.size > this.state.features.maxFileMb * 1024 * 1024) return fail('FILE_TOO_LARGE');
    if (this.preview) {
      const up = m.upload;
      this.patchMessage(clientId, {
        local: undefined,
        upload: undefined,
        attachments: [
          {
            id: `preview-${clientId}`,
            name: up.name,
            size: up.size,
            mimeType: up.mimeType,
            url: up.previewUrl ?? '',
            isImage: up.isImage,
            state: 'clean',
          },
        ],
      });
      return;
    }
    try {
      await this.whenReady();
    } catch {
      return fail('NOT_CONNECTED');
    }
    // Uploads belong to a chat: the attach button is only offered once one is open.
    const conv = openConversation(this.state);
    if (!conv) return fail('CHAT_CLOSED');
    try {
      const mime = file.type || 'application/octet-stream';
      const sha256 = await sha256Hex(file);
      const init = await this.api.call<V2UploadInit>('POST', '/uploads', {
        chatId: conv.id,
        name: file.name.slice(0, 255),
        sizeBytes: file.size,
        mime,
        sha256,
      });
      if (init.maxBytes && file.size > init.maxBytes) throw new WidgetError('FILE_TOO_LARGE');
      const headers = { ...init.headers };
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
        headers['content-type'] = mime;
      let last = 0;
      await putBytes(init.url, init.method, headers, file, (p) => {
        if (p - last < 0.04 && p < 1) return;
        last = p;
        const cur = this.state.messages.find((x) => x.clientId === clientId);
        if (cur?.upload) this.patchMessage(clientId, { upload: { ...cur.upload, progress: p } });
      }).promise;
      this.patchMessage(clientId, { uploadPhase: 'scanning' });
      const finalized = await this.api.call<V2Attachment>(
        'POST',
        `/uploads/${encodeURIComponent(init.uploadId)}/finalize`,
        { sha256 },
      );
      const att = await this.waitForClean(init.uploadId, finalized);
      const cur = this.state.messages.find((x) => x.clientId === clientId);
      if (!cur) return;
      if (cur.upload?.previewUrl) URL.revokeObjectURL(cur.upload.previewUrl);
      this.files.delete(clientId);
      this.sendMeta.set(clientId, { attachmentIds: [att.id], departmentId: this.state.departmentId });
      this.patchMessage(clientId, {
        upload: undefined,
        uploadPhase: undefined,
        attachments: [toAttachment(att)],
        local: 'pending',
      });
      void this.pump();
    } catch (err) {
      fail(
        err instanceof Error && !(err instanceof ApiError) && !(err instanceof WidgetError)
          ? err.message || 'UPLOAD_FAILED'
          : codeOf(err),
      );
    }
  }

  /** Resolve once the malware scan marks the upload clean (realtime `attachment.updated`, polled as a fallback). */
  private waitForClean(id: string, att: V2Attachment): Promise<V2Attachment> {
    const verdict = (a: { state?: string; errorCode?: string | null }) =>
      a.state === 'clean'
        ? 'clean'
        : a.state === 'rejected'
          ? a.errorCode || 'FILE_REJECTED'
          : a.state === 'expired'
            ? 'UPLOAD_FAILED'
            : null;
    const first = verdict(att);
    if (first === 'clean') return Promise.resolve(att);
    if (first) return Promise.reject(new WidgetError(first));
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 120_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (a: { state?: string; errorCode?: string | null }) => {
        const v = verdict(a);
        if (!v) return false;
        clearTimeout(timer);
        this.uploadWaiters.delete(id);
        if (v === 'clean') resolve({ ...att, ...(a as Partial<V2Attachment>), state: 'clean' });
        else reject(new WidgetError(v));
        return true;
      };
      this.uploadWaiters.set(id, done);
      const poll = async () => {
        if (!this.uploadWaiters.has(id)) return;
        try {
          const a = await this.api.call<V2Attachment>('GET', `/uploads/${encodeURIComponent(id)}`);
          if (done(a)) return;
        } catch {
          /* transient: keep polling until the deadline */
        }
        if (Date.now() > deadline) {
          this.uploadWaiters.delete(id);
          return reject(new WidgetError('FILE_SCAN_PENDING'));
        }
        timer = setTimeout(poll, 2000);
      };
      timer = setTimeout(poll, 1500);
    });
  }

  /** Short-lived (60 s) download grant for a clean attachment; cached slightly under its lifetime. */
  async attachmentUrl(id: string): Promise<string> {
    const cached = this.grants.get(id);
    if (cached && cached.until > Date.now()) return cached.url;
    const g = await this.api.call<V2Grant>('GET', `/attachments/${encodeURIComponent(id)}/download`);
    const until =
      Math.min(new Date(g.expiresAt).getTime() || Date.now() + 60_000, Date.now() + 60_000) - 10_000;
    this.grants.set(id, { url: g.url, until });
    return g.url;
  }

  /**
   * Download an attachment. Grants point at a forced-download URL (Content-Disposition: attachment), so an
   * in-place anchor click saves the file without leaving a blank tab; the grant arrives well within the
   * click's user-activation window.
   */
  openAttachment(id: string, name = '') {
    this.attachmentUrl(id).then(
      (url) => {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
      (err) => {
        const code = codeOf(err);
        this.notify(
          code === 'FILE_SCAN_PENDING'
            ? 'file_pending'
            : code === 'FILE_REJECTED'
              ? 'file_rejected'
              : 'download_failed',
        );
      },
    );
  }

  private openAfter(getUrl: () => Promise<string>, onError: (code: string) => void) {
    let w: Window | null = null;
    try {
      w = window.open('', '_blank');
    } catch {
      w = null;
    }
    getUrl().then(
      (url) => {
        if (w) {
          w.opener = null;
          w.location.href = url;
        } else window.open(url, '_blank', 'noopener');
      },
      (err) => {
        w?.close();
        onError(codeOf(err));
      },
    );
  }

  submitPrechat(input: { profile: VisitorProfileInput; departmentId: string | null; message: string }) {
    this.set({ prechatDone: true, departmentId: input.departmentId ?? this.state.departmentId });
    const v = this.state.visitor;
    if (v)
      this.set({
        visitor: {
          ...v,
          name: input.profile.name || v.name,
          email: input.profile.email || v.email,
          phone: input.profile.phone || v.phone,
        },
      });
    return this.send(input.message, { profile: input.profile, departmentId: input.departmentId });
  }

  async submitOffline(form: {
    name: string;
    email: string;
    phone?: string;
    departmentId?: string | null;
    message: string;
  }): Promise<{ ok: boolean; error?: string; fieldErrors?: Record<string, string[]> }> {
    if (this.preview) {
      this.set({ offlineSent: { reference: null }, offline: null, offlineDraft: null });
      return { ok: true };
    }
    try {
      await this.whenReady(10000);
    } catch {
      return { ok: false, error: 'NOT_CONNECTED' };
    }
    const sourceChatId =
      this.state.offline?.reason === 'queue' ? (this.state.offline.sourceChatId ?? null) : null;
    try {
      const r = await this.api.call<V2OfflineReceipt>('POST', '/offline-submissions', {
        clientRequestId: uuid(),
        name: form.name.trim() || null,
        email: form.email.trim(),
        phone: form.phone?.trim() || null,
        message: form.message.trim(),
        departmentId: form.departmentId || null,
        ...(sourceChatId ? { sourceChatId } : {}),
      });
      const reference = typeof r?.reference === 'string' ? r.reference : null;
      const patch: Partial<State> = {
        offlineSent: { reference },
        offline: null,
        offlineDraft: null,
        waitExceeded: null,
      };
      if (sourceChatId) {
        // The queued chat was closed server-side in favour of the message: leave it behind.
        this.saveUi({ dismissedConv: sourceChatId });
        this.chatMeta = null;
        this.cursor = null;
        Object.assign(patch, { conversation: null, messages: [], typing: [] });
      }
      this.set(patch);
      this.emit('offline.submitted', { reference });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: codeOf(err),
        fieldErrors: err instanceof ApiError ? (err.fieldErrors ?? undefined) : undefined,
      };
    }
  }

  /** `queue.wait_exceeded`: keep waiting (dismiss the prompt) … */
  keepWaiting() {
    this.set({ waitExceeded: null });
  }

  /** … or leave a message instead; submitting closes the queued chat (`source_chat_id`). */
  leaveQueue() {
    const c = openConversation(this.state);
    if (!c) return;
    const v = this.state.visitor;
    this.set({
      waitExceeded: null,
      offline: { reason: 'queue', sourceChatId: c.id },
      offlineDraft: {
        name: v?.name ?? undefined,
        email: v?.email ?? undefined,
        phone: v?.phone ?? undefined,
      },
      offlineDraftRev: this.state.offlineDraftRev + 1,
    });
  }

  backToChat() {
    if (this.state.offline?.reason === 'queue') this.set({ offline: null });
  }

  resetOffline() {
    this.set({ offlineSent: null });
  }

  setOfflineDraft(draft: OfflineDraft | null) {
    this.state = { ...this.state, offlineDraft: draft };
  }

  async rate(rating: Rating | null, comment?: string): Promise<boolean> {
    const c = this.state.conversation;
    if (!c || !rating) return false;
    const prev = c;
    this.set({ conversation: { ...c, rating, ratingComment: comment ?? c.ratingComment } });
    if (this.preview) return true;
    try {
      const r = await this.api.call<{ rating: 'good' | 'bad'; comment: string | null }>(
        'PUT',
        `/chats/${encodeURIComponent(c.id)}/rating`,
        {
          rating: ratingToWire(rating),
          ...(comment !== undefined ? { comment: comment.slice(0, 2000) || null } : {}),
        },
      );
      const cur = this.state.conversation;
      if (cur?.id === c.id)
        this.set({
          conversation: { ...cur, rating: r.rating.toUpperCase() as Rating, ratingComment: r.comment },
        });
      this.emit('rating.changed', { chatId: c.id, rating: r.rating });
      return true;
    } catch {
      if (this.state.conversation?.id === prev.id)
        this.set({
          conversation: {
            ...this.state.conversation,
            rating: prev.rating,
            ratingComment: prev.ratingComment,
          },
        });
      this.notify('send_failed');
      return false;
    }
  }

  async emailTranscript(email: string): Promise<{ ok: boolean; error?: string }> {
    const c = this.state.conversation;
    if (this.preview) return { ok: true };
    if (!c) return { ok: false, error: 'NOT_FOUND' };
    try {
      await this.api.call('POST', `/chats/${encodeURIComponent(c.id)}/transcript-email`, {
        email,
        format: 'txt',
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: codeOf(err) };
    }
  }

  /** Transcript download: create a widget export, poll until ready, then open the short-lived download URL. */
  downloadTranscript(format: 'txt' | 'pdf' = 'txt') {
    const c = this.state.conversation;
    if (!c || this.preview) return;
    const timezone = this.initInfo.timezone || (Intl.DateTimeFormat().resolvedOptions().timeZone ?? null);
    this.openAfter(
      async () => {
        let e = await this.api.call<V2Export>('POST', `/chats/${encodeURIComponent(c.id)}/exports`, {
          format,
          timezone,
        });
        const deadline = Date.now() + 60_000;
        while (e.state === 'queued' || e.state === 'running') {
          if (Date.now() > deadline) throw new WidgetError('TIMEOUT');
          await new Promise((r) => setTimeout(r, 1000));
          e = await this.api.call<V2Export>('GET', `/exports/${encodeURIComponent(e.id)}`);
        }
        if (e.state !== 'ready') throw new WidgetError(e.errorCode || 'EXPORT_FAILED');
        return (await this.api.call<V2Grant>('GET', `/exports/${encodeURIComponent(e.id)}/download`)).url;
      },
      () => this.notify('export_failed'),
    );
  }

  async endChat(fromApi = false): Promise<boolean> {
    const c = openConversation(this.state);
    if (!c) return false;
    if (this.preview) {
      this.set({ conversation: { ...c, status: 'RESOLVED' } });
      return true;
    }
    this.endingByVisitor = true;
    try {
      const chat = this.live()
        ? await this.command<V2Chat>('chat.close', { chatId: c.id })
        : await this.api.call<V2Chat>('POST', `/chats/${encodeURIComponent(c.id)}/close`, {});
      if (chat?.id) this.applyChat(chat);
      const cur = this.state.conversation;
      if (cur && cur.id === c.id && cur.status !== 'RESOLVED') {
        this.set({ conversation: { ...cur, status: 'RESOLVED' } });
        this.markEnded(cur.id, 'visitor');
      }
      return true;
    } catch (err) {
      this.endingByVisitor = false;
      const code = codeOf(err) === 'FORBIDDEN' ? 'END_CHAT_DISABLED' : codeOf(err);
      if (fromApi) throw new WidgetError(code);
      this.notify(code === 'END_CHAT_DISABLED' ? 'end_disabled' : 'end_failed');
      return false;
    }
  }

  newChat() {
    const c = this.state.conversation;
    if (c) this.saveUi({ dismissedConv: c.id });
    for (const m of this.state.messages) if (m.upload?.previewUrl) URL.revokeObjectURL(m.upload.previewUrl);
    this.chatMeta = null;
    this.cursor = null;
    this.subscribedChat = null;
    this.set({
      conversation: null,
      messages: [],
      typing: [],
      prechatDone: false,
      offline: null,
      offlineDraft: null,
      offlineSent: null,
      ratingRequested: false,
      openFocus: true,
    });
  }

  // ══════════════ Preview mode ══════════════

  private startPreview() {
    const params = new URLSearchParams(location.search);
    const st = params.get('state') as PreviewState | null;
    if (st) this.previewMode = st;
    // Standalone conveniences (the dashboard drives these through postMessage instead).
    if (params.get('locale')) this.previewLocale = params.get('locale');
    const theme = params.get('theme');
    if (theme === 'dark' || theme === 'light' || theme === 'auto') {
      const base = mergeWidgetConfig(this.serverConfig);
      this.serverConfig = { ...base, appearance: { ...base.appearance, theme } };
    }
    this.renderPreview();
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent || window.parent === window) return;
      const expected = ancestorOrigin() ?? originOf(document.referrer);
      if (expected && e.origin !== expected) return;
      const d = e.data as PreviewMessage;
      if (!isObject(d) || d.source !== PREVIEW_SOURCE) return;
      // The dashboard may send camelCase or snake_case (wire) config.
      if (d.config && isObject(d.config)) this.serverConfig = mergeWidgetConfig(camelize(d.config));
      if (typeof d.state === 'string') this.previewMode = d.state;
      if (typeof d.online === 'boolean') this.previewOnline = d.online;
      if (typeof d.locale === 'string') this.previewLocale = d.locale;
      this.renderPreview();
    });
    if (window.parent !== window) {
      try {
        window.parent.postMessage({ source: PREVIEW_SOURCE, type: 'ready' }, '*');
      } catch {
        /* ignore */
      }
    }
  }

  private renderPreview() {
    const next = previewState(this.state, this.serverConfig, this.previewMode, this.previewOnline);
    this.set({ ...next, viewport: this.ownViewport(), standalone: false, locale: this.state.locale });
    this.recomputeLocale();
  }
}

export type { Locale };
