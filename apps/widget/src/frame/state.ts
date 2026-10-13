/** Widget state model and pure selectors (no side effects). */
import {
  DEFAULT_WIDGET_CONFIG,
  type AttachmentDTO,
  isWidgetVisibleOnUrl,
  type AccountAvailability,
  type MessageDTO,
  type PublicAgent,
  type PublicConversation,
  type VisitorProfileInput,
  type WidgetConfig,
} from '@talkivio/contracts/protocol';
import type { ConnectionState, ViewportInfo, WidgetView } from '../common/protocol';
import type { Locale, StringKey } from './i18n';

export interface UploadInfo {
  name: string;
  size: number;
  mimeType: string;
  isImage: boolean;
  progress: number;
  previewUrl: string | null;
}

/** Attachment with its server scan state (`clean` files can be downloaded). */
export interface UiAttachment extends AttachmentDTO {
  state?: string;
  errorCode?: string | null;
}

export interface UiMessage extends Omit<MessageDTO, 'attachments'> {
  attachments: UiAttachment[];
  /** Per-chat sequence number (v2); absent for local and synthetic messages. */
  seq?: number;
  /** Local delivery state; undefined once the server has accepted the message. */
  local?: 'pending' | 'failed';
  errorCode?: string;
  /** Pending attachment upload (visitor messages only). */
  upload?: UploadInfo;
  /** Upload phase shown while the file is being verified server-side. */
  uploadPhase?: 'uploading' | 'scanning';
  /** Removed by a privacy erasure (`message.redacted`): shown as a tombstone. */
  redacted?: boolean;
}

export interface Invitation {
  id: string;
  kind: 'proactive' | 'greeting' | 'message';
  authorName: string;
  avatarUrl: string | null;
  body: string;
}

export interface OfflineDraft extends VisitorProfileInput {
  departmentId?: string | null;
  message?: string;
}

export type PanelView = Exclude<WidgetView, 'hidden' | 'launcher' | 'invitation'>;

export interface Notice {
  id: number;
  key: StringKey;
  tone: 'error' | 'info';
}

export interface State {
  preview: boolean;
  standalone: boolean;
  configLoaded: boolean;
  sessionReady: boolean;
  connection: ConnectionState;
  fatal: string | null;
  config: WidgetConfig;
  configVersion: number | null;
  brandName: string;
  account: AccountAvailability | null;
  visitor: { id: string; name: string | null; email: string | null; phone: string | null } | null;
  verified: boolean;
  conversation: PublicConversation | null;
  messages: UiMessage[];
  proactive: MessageDTO[];
  typing: PublicAgent[];
  /** Screen-reader announcement for the latest message that arrived live (never for loaded history); `n` changes per message. */
  announcement: { name: string; text: string; n: number } | null;
  open: boolean;
  closing: boolean;
  openFocus: boolean;
  hiddenByApi: boolean;
  banned: boolean;
  hideLauncher: boolean;
  unread: number;
  invitation: Invitation | null;
  /** Invitation / preview keys the visitor has already seen or dismissed (session scoped). */
  seen: string[];
  greetingDue: boolean;
  /** Forced offline form: agents offline, department unavailable, or the visitor left the queue. */
  offline: { reason: 'offline' | 'department' | 'queue'; department?: string; sourceChatId?: string } | null;
  /** Agent-side receipts for the visitor's messages in the current chat (seq high-water marks). */
  receipts: { chatId: string; delivered: number; read: number } | null;
  /** Queue took longer than the site's threshold (`queue.wait_exceeded`). */
  waitExceeded: { chatId: string; waitedSeconds: number } | null;
  offlineDraft: OfflineDraft | null;
  /** Bumped when the controller (not the user) replaces the offline draft, to re-seed the form. */
  offlineDraftRev: number;
  offlineSent: { reference: string | null } | null;
  prechatDone: boolean;
  departmentId: string | null;
  soundOn: boolean;
  locale: Locale;
  viewport: ViewportInfo;
  hostVisible: boolean;
  hostFocused: boolean;
  pageUrl: string;
  notice: Notice | null;
  ratingRequested: boolean;
  /** Return keyboard focus to the launcher (or host) after a user-initiated close. */
  focusReturn: boolean;
  /** Server capabilities from bootstrap (files, transcripts, read receipts). */
  features: { files: boolean; maxFileMb: number; transcripts: boolean; readReceipts: boolean };
}

export const DEFAULT_VIEWPORT: ViewportInfo = {
  width: 1280,
  height: 800,
  compact: false,
  fullscreen: false,
  insets: { top: 0, right: 0, bottom: 0, left: 0 },
  dark: false,
  reducedMotion: false,
};

export function initialState(partial: Partial<State> = {}): State {
  return {
    preview: false,
    standalone: false,
    configLoaded: false,
    sessionReady: false,
    connection: 'connecting',
    fatal: null,
    config: DEFAULT_WIDGET_CONFIG,
    configVersion: null,
    brandName: 'Talkivio',
    account: null,
    visitor: null,
    verified: false,
    conversation: null,
    messages: [],
    proactive: [],
    typing: [],
    announcement: null,
    open: false,
    closing: false,
    openFocus: false,
    hiddenByApi: false,
    banned: false,
    hideLauncher: false,
    unread: 0,
    invitation: null,
    seen: [],
    greetingDue: false,
    offline: null,
    waitExceeded: null,
    receipts: null,
    offlineDraft: null,
    offlineDraftRev: 0,
    offlineSent: null,
    prechatDone: false,
    departmentId: null,
    soundOn: true,
    locale: 'en',
    viewport: DEFAULT_VIEWPORT,
    hostVisible: true,
    hostFocused: false,
    pageUrl: '',
    notice: null,
    ratingRequested: false,
    focusReturn: false,
    features: { files: true, maxFileMb: 10, transcripts: false, readReceipts: true },
    ...partial,
  };
}

export const isAgentText = (m: MessageDTO): boolean => m.type === 'TEXT' && (m.authorType === 'AGENT' || m.authorType === 'TRIGGER');
export const proactiveKey = (m: MessageDTO): string => `${m.id}@${m.createdAt}`;

/**
 * A newer copy of a message already on screen (live frame, cursor replay or REST page). It replaces the shown one,
 * keeping the read mark — except that redaction is permanent: a late or replayed copy of the original must not
 * bring removed content back.
 */
export function mergeIncoming(shown: UiMessage, incoming: UiMessage): UiMessage {
  if (shown.redacted && !incoming.redacted) return shown;
  return { ...incoming, readByVisitorAt: shown.readByVisitorAt ?? incoming.readByVisitorAt };
}

export function openConversation(s: Pick<State, 'conversation'>): PublicConversation | null {
  return s.conversation && s.conversation.status !== 'RESOLVED' ? s.conversation : null;
}

export function isHidden(s: State): boolean {
  if (s.banned || s.hiddenByApi || !s.configLoaded) return true;
  const b = s.config.behavior;
  if (s.fatal === 'ORIGIN_NOT_ALLOWED' || s.fatal === 'UNKNOWN_SITE') return true;
  if (b.hideOnMobile && s.viewport.compact && !s.standalone) return true;
  if (s.open) return false;
  if (s.pageUrl && !isWidgetVisibleOnUrl(s.config, s.pageUrl)) return true;
  if (b.hideWhenOffline && s.account && !s.account.online && !openConversation(s)) return true;
  return false;
}

export function needsPrechat(s: State): boolean {
  const p = s.config.behavior.prechatForm;
  return p.enabled && !s.prechatDone && !s.proactive.length && !s.messages.length;
}

export function panelView(s: State): PanelView {
  if (s.fatal === 'BANNED') return 'error';
  if (!s.sessionReady) return s.fatal ? 'error' : 'loading';
  const c = s.conversation;
  // Leaving the queue for the offline form keeps the (still queued) chat underneath.
  if (s.offline?.reason === 'queue' && c && c.status !== 'RESOLVED') return 'offline';
  if (c) {
    if (c.status === 'RESOLVED') return s.config.behavior.ratings.enabled && !c.rating ? 'rating' : 'ended';
    return c.status === 'WAITING' ? 'queued' : 'active';
  }
  if (s.offlineSent) return 'offline_success';
  if (s.offline || (s.account && !s.account.online)) return 'offline';
  if (needsPrechat(s)) return 'prechat';
  return 'welcome';
}

export function viewOf(s: State): WidgetView {
  if (isHidden(s)) return 'hidden';
  if (s.open) return panelView(s);
  if (s.hideLauncher) return 'hidden';
  return s.invitation ? 'invitation' : 'launcher';
}

export type LayoutMode = 'hidden' | 'launcher' | 'greeting' | 'open';
export function layoutMode(s: State): LayoutMode {
  if (isHidden(s)) return 'hidden';
  if (s.open) return 'open';
  if (s.hideLauncher) return 'hidden';
  return s.invitation ? 'greeting' : 'launcher';
}

export function computeUnread(s: State): number {
  if (s.open && !s.closing && s.hostVisible) return 0;
  const agent = s.messages.filter((m) => isAgentText(m) && !m.readByVisitorAt).length;
  const pro = openConversation(s) ? 0 : s.proactive.filter((p) => !s.seen.includes(proactiveKey(p))).length;
  return agent + pro;
}

export function computeInvitation(s: State): Invitation | null {
  if (s.open || s.hideLauncher || isHidden(s) || !s.sessionReady) return null;
  if (openConversation(s)) {
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i];
      if (!isAgentText(m) || m.readByVisitorAt) continue;
      const id = `m:${m.id}`;
      if (s.seen.includes(id)) return null;
      const body = m.body || (m.attachments[0] ? `📎 ${m.attachments[0].name}` : '');
      return { id, kind: 'message', authorName: m.authorName, avatarUrl: m.authorAvatarUrl, body };
    }
    return null;
  }
  const p = s.proactive[s.proactive.length - 1];
  if (p) {
    const id = proactiveKey(p);
    return s.seen.includes(id) ? null : { id, kind: 'proactive', authorName: p.authorName, avatarUrl: p.authorAvatarUrl, body: p.body };
  }
  if (s.conversation) return null;
  const g = s.config.behavior.greeting;
  if (s.greetingDue && g.enabled && g.message.trim() && (!s.viewport.compact || g.showOnMobile) && !s.seen.includes('greeting') && s.account?.online !== false) {
    return { id: 'greeting', kind: 'greeting', authorName: s.config.appearance.companyName, avatarUrl: s.config.appearance.logoUrl, body: g.message };
  }
  return null;
}
