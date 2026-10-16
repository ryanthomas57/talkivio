'use client';
/**
 * Attention: sounds and desktop alerts for incoming chats, offers and messages (ch. 14), and a chime when a visitor
 * arrives on the website.
 *
 * - Exactly one tab per browser alerts: the tab holding the `talkivio-attention` Web Lock is the leader. The
 *   browser grants the lock to one tab at a time and hands it to a waiting tab the moment the holder closes,
 *   navigates away or crashes — no timers, so background-tab timer throttling cannot create a second leader.
 *   Browsers without Web Locks fall back to BroadcastChannel messages. Convergence does not wait for timers (a
 *   background tab's timers may be throttled or stopped while it still receives events): a new tab asks who leads
 *   before claiming, a leader answers a competing claim at once (lowest id wins), and a closing leader resigns so a
 *   follower takes over immediately. Heartbeats every 2 s replace a leader that went silent for 6 s (crash).
 * - Desktop permission is requested only from an explicit click.
 * - Privacy mode uses generic text with no visitor names or message bodies.
 * - Mute for one hour and per-chat mute never hide the visual queue.
 */
import { BRAND_NAME } from '@/components/brand';
import { isolate, tStatic } from '@/i18n';
import { countryName } from '@/lib/format';
import type { Message, StaffChat } from '@/lib/types';
import { useSession } from '@/stores/session';

const CHANNEL = 'talkivio-attention';
const MUTE_KEY = 'rd-attention-mute-until';
const CHAT_MUTE_KEY = 'rd-attention-muted-chats';
const tabId =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());

let channel: BroadcastChannel | null = null;
let leader: { id: string; at: number } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;
let lockHeld = false;
let releaseLock: (() => void) | null = null;
let lockRequest: AbortController | null = null;

function isLeader(): boolean {
  return lockHeld || leader?.id === tabId;
}

/** Start leader election (idempotent). Tabs without Web Locks or BroadcastChannel alert on their own. */
export function startAttention(): void {
  if (typeof window === 'undefined' || started) return;
  started = true;
  window.addEventListener('pagehide', stopAttention);
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    // Queued until granted; held (the promise stays pending) until stopAttention releases it or aborts the wait.
    const request = new AbortController();
    lockRequest = request;
    void navigator.locks
      .request(CHANNEL, { mode: 'exclusive', signal: request.signal }, () => {
        if (request.signal.aborted) return undefined;
        lockHeld = true;
        return new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      })
      .catch(() => undefined);
    return;
  }
  if (typeof BroadcastChannel === 'undefined') {
    leader = { id: tabId, at: Date.now() };
    return;
  }
  channel = new BroadcastChannel(CHANNEL);
  const claim = () => {
    leader = { id: tabId, at: Date.now() };
    channel?.postMessage({ type: 'heartbeat', id: tabId });
  };
  const tick = () => {
    if (isLeader() || !leader || Date.now() - leader.at > 6000) claim();
  };
  channel.onmessage = (ev: MessageEvent<{ type: string; id: string }>) => {
    const msg = ev.data;
    if (!msg || typeof msg.id !== 'string' || msg.id === tabId) return;
    if (msg.type === 'hello') {
      if (isLeader()) claim();
    } else if (msg.type === 'resign') {
      if (leader?.id === msg.id) {
        leader = null;
        tick();
      }
    } else if (msg.type === 'heartbeat') {
      // Lowest id wins: a leader answers a higher competing claim at once instead of on its next (possibly throttled) tick.
      if (isLeader() && msg.id > tabId) claim();
      else if (!leader || msg.id === leader.id || msg.id < leader.id || Date.now() - leader.at > 6000)
        leader = { id: msg.id, at: Date.now() };
    }
  };
  // Ask first; claim only if no leader answered by the first tick.
  channel.postMessage({ type: 'hello', id: tabId });
  timer = setInterval(tick, 2000);
  setTimeout(() => started && tick(), 1000);
}

export function stopAttention(): void {
  if (channel && leader?.id === tabId) channel.postMessage({ type: 'resign', id: tabId });
  started = false;
  lockHeld = false;
  lockRequest?.abort();
  lockRequest = null;
  releaseLock?.();
  releaseLock = null;
  if (timer) clearInterval(timer);
  timer = null;
  channel?.close();
  channel = null;
  leader = null;
}

// A page restored from the back/forward cache rejoins the election it left on pagehide.
if (typeof window !== 'undefined')
  window.addEventListener('pageshow', (e) => e.persisted && startAttention());

export function muteForOneHour(): void {
  localStorage.setItem(MUTE_KEY, String(Date.now() + 3600_000));
}

export function unmute(): void {
  localStorage.removeItem(MUTE_KEY);
}

export function mutedUntil(): number | null {
  try {
    const v = Number(localStorage.getItem(MUTE_KEY));
    return v > Date.now() ? v : null;
  } catch {
    return null;
  }
}

export function chatMuted(chatId: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(CHAT_MUTE_KEY) ?? '[]') as string[]).includes(chatId);
  } catch {
    return false;
  }
}

export function setChatMuted(chatId: string, muted: boolean): void {
  try {
    const list = new Set(JSON.parse(localStorage.getItem(CHAT_MUTE_KEY) ?? '[]') as string[]);
    if (muted) list.add(chatId);
    else list.delete(chatId);
    localStorage.setItem(CHAT_MUTE_KEY, JSON.stringify([...list].slice(-200)));
  } catch {
    /* storage unavailable: mute applies to this page only */
  }
}

/** Ask for desktop notification permission — call only from a user click. */
export async function enableDesktopNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

let audio: AudioContext | null = null;

/** Short synthesized chime (no external asset); a visitor arriving is a falling two-tone "ding-dong". */
export function playChime(kind: 'queue' | 'message' | 'offer' | 'visitor' = 'message'): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const now = audio.currentTime;
    const notes =
      kind === 'message'
        ? [880]
        : kind === 'offer'
          ? [660, 880, 1046]
          : kind === 'visitor'
            ? [1046, 784]
            : [660, 880];
    notes.forEach((f, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const t = now + i * 0.13;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(gain).connect(audio!.destination);
      osc.start(t);
      osc.stop(t + 0.34);
    });
  } catch {
    /* audio blocked until the first user interaction */
  }
}

type Incoming =
  | { kind: 'queue'; chat: StaffChat }
  | { kind: 'offer'; chat: StaffChat; from?: string }
  | { kind: 'message'; chat: StaffChat; message: Message };

export function notifyIncoming(evt: Incoming): void {
  if (typeof window === 'undefined' || !isLeader()) return;
  const prefs = useSession.getState().agent?.preferences;
  if (!prefs) return;
  if (mutedUntil() || chatMuted(evt.chat.id)) return;
  const visibleAndFocused = document.visibilityState === 'visible' && document.hasFocus();
  // A visible conversation already shows the message; don't chime for it.
  if (evt.kind === 'message' && visibleAndFocused && window.location.pathname.includes(evt.chat.id)) return;
  if (prefs.sound) playChime(evt.kind);
  if (
    !prefs.desktopNotifications ||
    visibleAndFocused ||
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  )
    return;
  const privacy = prefs.privacyMode === true;
  // Generated outside React: tStatic follows the active UI language (privacy mode text included).
  const title = tStatic(
    evt.kind === 'queue'
      ? 'inbox.attention.queueTitle'
      : evt.kind === 'offer'
        ? 'inbox.attention.offerTitle'
        : 'inbox.attention.messageTitle',
  );
  const name = isolate(evt.chat.visitor.displayName);
  const body = privacy
    ? tStatic('inbox.attention.privateBody', { brand: BRAND_NAME })
    : evt.kind === 'message'
      ? typeof evt.message.body === 'string'
        ? tStatic('inbox.attention.messageBody', { name, text: isolate(evt.message.body.slice(0, 120)) })
        : tStatic('inbox.attention.attachmentBody', { name })
      : tStatic('inbox.attention.chatBody', {
          name,
          preview: isolate(evt.chat.lastMessagePreview.slice(0, 100)),
        });
  try {
    const n = new Notification(title, { body, tag: `rd-${evt.kind}-${evt.chat.id}`, silent: true });
    n.onclick = () => {
      window.focus();
      window.location.assign(`/inbox/${evt.chat.id}`);
      n.close();
    };
  } catch {
    /* notification constructor unavailable (e.g. some mobile browsers) */
  }
}

/** `visitor.arrived`: a visitor appeared on the website (once per visit, page changes excluded). */
export interface VisitorArrived {
  visitorId: string;
  displayName?: string | null;
  country?: string | null;
  page?: string | null;
}

const VISITOR_ALERT_GAP_MS = 4000;
let lastVisitorAlert = 0;

/**
 * A visitor arrived on the website: a chime and, while the dashboard is in the background, a desktop notification
 * (one at a time, a newer arrival replaces it). Leader tab only, and at most one alert every few seconds however
 * many visitors land together (a busy site would otherwise ring constantly). Follows the sound and desktop switches,
 * the visitor-alert switch, privacy mode and the mute.
 */
export function notifyVisitorArrived(v: VisitorArrived): void {
  if (typeof window === 'undefined' || !isLeader()) return;
  const prefs = useSession.getState().agent?.preferences;
  if (!prefs || prefs.visitorAlerts === false || mutedUntil()) return;
  const now = Date.now();
  if (now - lastVisitorAlert < VISITOR_ALERT_GAP_MS) return;
  lastVisitorAlert = now;
  if (prefs.sound) playChime('visitor');
  const visibleAndFocused = document.visibilityState === 'visible' && document.hasFocus();
  if (
    !prefs.desktopNotifications ||
    visibleAndFocused ||
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  )
    return;
  const name = isolate(v.displayName || tStatic('common.visitor'));
  const country = countryName(v.country);
  const page = v.page ? isolate(v.page.slice(0, 100)) : null;
  const body =
    prefs.privacyMode === true
      ? tStatic('inbox.attention.privateBody', { brand: BRAND_NAME })
      : page && country
        ? tStatic('inbox.attention.visitorBodyFrom', { name, country: isolate(country), page })
        : page
          ? tStatic('inbox.attention.visitorBodyPage', { name, page })
          : tStatic('inbox.attention.visitorBody', { name });
  try {
    const n = new Notification(tStatic('inbox.attention.visitorTitle'), {
      body,
      tag: 'rd-visitor-arrived',
      silent: true,
    });
    n.onclick = () => {
      window.focus();
      window.location.assign('/visitors');
      n.close();
    };
  } catch {
    /* notification constructor unavailable (e.g. some mobile browsers) */
  }
}
