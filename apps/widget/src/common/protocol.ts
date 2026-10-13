/**
 * Widget-local extensions of the host <-> frame postMessage protocol.
 *
 * The canonical message unions live in `@talkivio/contracts/protocol` (HostToFrameMessage /
 * FrameToHostMessage). The loader and the frame ship together in this package, so the
 * optional fields added here are backwards compatible: a frame that ignores them still
 * understands every message.
 */
import type { FrameToHostMessage, HostToFrameMessage, WidgetConfig } from '@talkivio/contracts/protocol';

export const HOST_SOURCE = 'talkivio-host' as const;
export const FRAME_SOURCE = 'talkivio-frame' as const;
export const PREVIEW_SOURCE = 'talkivio-preview' as const;

/** Transparent margin (px) kept around the launcher / invitation for shadows, focus rings and the badge. */
export const LAYOUT_PAD = 16;
/** Breakpoints of the visual contract. */
export const COMPACT_MAX_WIDTH = 640;
export const FULLSCREEN_MIN_HEIGHT = 520;

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ViewportInfo {
  width: number;
  height: number;
  /** Phone-sized viewport (< 640 px wide): smaller offsets, full-viewport panel. */
  compact: boolean;
  /** Open panel should cover the whole viewport (compact, or very short windows / 200 % zoom). */
  fullscreen: boolean;
  /** Safe-area insets of the host page (only non-zero with viewport-fit=cover). */
  insets: Insets;
  /** Host page prefers a dark color scheme. */
  dark: boolean;
  reducedMotion: boolean;
}

export interface HostSettings {
  locale?: string | null;
  identityToken?: string | null;
  hideLauncher?: boolean;
  position?: 'bottom-right' | 'bottom-left' | null;
  /** One-time cross-site identity handoff code (redeemed via /widget/v1/identity/redeem). */
  handoffCode?: string | null;
}

type BaseInit = Extract<HostToFrameMessage, { type: 'init' }>;
export type InitMessage = BaseInit & { settings?: HostSettings; viewport?: ViewportInfo; sdkVersion?: string };
export type ViewportMessage = { source: typeof HOST_SOURCE; type: 'viewport'; viewport: ViewportInfo };
export type HostMessage = Exclude<HostToFrameMessage, BaseInit> | InitMessage | ViewportMessage;

type BaseLayout = Extract<FrameToHostMessage, { type: 'layout' }>;
export type LayoutMessage = BaseLayout & {
  /** Corner radius the host container should clip the open panel with. */
  radius?: number;
  /** The panel is about to close: animate out but keep the current geometry. */
  closing?: boolean;
  /** Move keyboard focus into the frame (user-initiated open). */
  focus?: boolean;
  /** Return focus to the host element that was focused before opening. */
  restoreFocus?: boolean;
};
export type FrameMessage = Exclude<FrameToHostMessage, BaseLayout> | LayoutMessage;

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export type WidgetView =
  | 'hidden'
  | 'launcher'
  | 'invitation'
  | 'loading'
  | 'error'
  | 'welcome'
  | 'prechat'
  | 'queued'
  | 'active'
  | 'ended'
  | 'rating'
  | 'offline'
  | 'offline_success';

/** Read-only snapshot exposed to the host page through `Talkivio('getState')`. */
export interface WidgetStateSnapshot {
  ready: boolean;
  open: boolean;
  visible: boolean;
  view: WidgetView;
  connection: ConnectionState;
  availability: 'online' | 'offline' | 'unknown';
  unreadCount: number;
  locale: string;
  chat: { id: string; status: string } | null;
  visitor: { id: string; verified: boolean } | null;
  configVersion: number | null;
}

/** Internal event name used to mirror the state snapshot into the loader (never dispatched to host handlers). */
export const STATE_EVENT = '__state';

/** Public SDK events (host-facing names). */
export const SDK_EVENTS = [
  'ready',
  'opened',
  'closed',
  'availability.changed',
  'connection.changed',
  'identity.changed',
  'chat.requested',
  'chat.started',
  'message.received',
  'unread.changed',
  'chat.ended',
  'rating.changed',
  'invitation.displayed',
  'invitation.accepted',
  'offline.submitted',
  'error',
] as const;
export type SdkEventName = (typeof SDK_EVENTS)[number];

export const EMPTY_SNAPSHOT: WidgetStateSnapshot = {
  ready: false,
  open: false,
  visible: false,
  view: 'hidden',
  connection: 'connecting',
  availability: 'unknown',
  unreadCount: 0,
  locale: 'en',
  chat: null,
  visitor: null,
  configVersion: null,
};

/** Dashboard live-preview protocol (`/widget/frame/:id?preview=1`). */
export type PreviewState = 'launcher' | 'greeting' | 'welcome' | 'prechat' | 'chat' | 'offline' | 'ended';
export const PREVIEW_STATES: PreviewState[] = ['launcher', 'greeting', 'welcome', 'prechat', 'chat', 'offline', 'ended'];

export interface PreviewMessage {
  source: typeof PREVIEW_SOURCE;
  config?: WidgetConfig | Record<string, unknown>;
  state?: PreviewState;
  online?: boolean;
  /** Optional UI locale override for the preview (defaults to the config language). */
  locale?: string;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
