'use client';
/**
 * Docked chat windows (Zendesk-style): small windows along the bottom edge that stay open while the agent
 * moves around the dashboard. A window is either a chat, or a visitor the agent is about to start a chat
 * with (it becomes a chat window when the first message is sent). The newest window sits at the end edge.
 * Chat windows survive navigation and reloads of this tab (sessionStorage); visitor windows do not.
 */
import { create } from 'zustand';

export interface DockVisitor {
  visitorId: string;
  sessionId: string | null;
  name: string;
  country: string | null;
  ipAddress: string | null;
  /** Title (or address) of the page they are on, when browsing details are allowed. */
  page: string | null;
}

export type DockWindow = { key: string; minimized: boolean } & (
  { kind: 'chat'; chatId: string } | { kind: 'visitor'; visitor: DockVisitor }
);

const STORE_KEY = 'rd_dock';
/** Upper bound regardless of screen width; the dock component also fits windows to the viewport. */
export const MAX_WINDOWS = 4;

interface DockState {
  windows: DockWindow[];
  openChat: (chatId: string) => void;
  openVisitor: (visitor: DockVisitor) => void;
  /** A visitor window whose chat now exists turns into that chat's window, in place. */
  promote: (key: string, chatId: string) => void;
  toggle: (key: string) => void;
  close: (key: string) => void;
  closeChat: (chatId: string) => void;
  reset: () => void;
}

function persist(windows: DockWindow[]) {
  try {
    const chats = windows
      .filter((w) => w.kind === 'chat')
      .map((w) => ({ chatId: (w as { chatId: string }).chatId, minimized: w.minimized }));
    sessionStorage.setItem(STORE_KEY, JSON.stringify(chats));
  } catch {
    /* storage unavailable: windows just won't survive a reload */
  }
}

function restore(): DockWindow[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '[]') as Array<{
      chatId?: unknown;
      minimized?: unknown;
    }>;
    return raw
      .filter((w) => typeof w.chatId === 'string')
      .slice(-MAX_WINDOWS)
      .map((w) => ({
        key: `chat:${w.chatId as string}`,
        kind: 'chat' as const,
        chatId: w.chatId as string,
        minimized: w.minimized === true,
      }));
  } catch {
    return [];
  }
}

/** Adds or re-opens a window and moves it to the end (newest); the oldest windows drop off past the limit. */
function place(windows: DockWindow[], w: DockWindow): DockWindow[] {
  const next = [...windows.filter((x) => x.key !== w.key), w];
  return next.slice(-MAX_WINDOWS);
}

export const useDock = create<DockState>((set, get) => {
  const update = (windows: DockWindow[]) => {
    set({ windows });
    persist(windows);
  };
  return {
    windows: typeof window === 'undefined' ? [] : restore(),
    openChat: (chatId) =>
      update(place(get().windows, { key: `chat:${chatId}`, kind: 'chat', chatId, minimized: false })),
    openVisitor: (visitor) =>
      update(
        place(get().windows, {
          key: `visitor:${visitor.visitorId}`,
          kind: 'visitor',
          visitor,
          minimized: false,
        }),
      ),
    promote: (key, chatId) => {
      const windows = get().windows.filter((w) => w.key !== `chat:${chatId}`);
      update(
        windows.map((w) =>
          w.key === key ? { key: `chat:${chatId}`, kind: 'chat', chatId, minimized: false } : w,
        ),
      );
    },
    toggle: (key) =>
      update(get().windows.map((w) => (w.key === key ? { ...w, minimized: !w.minimized } : w))),
    close: (key) => update(get().windows.filter((w) => w.key !== key)),
    closeChat: (chatId) => update(get().windows.filter((w) => w.key !== `chat:${chatId}`)),
    reset: () => update([]),
  };
});

/** Chat ids shown in the dock (the inbox engine keeps them subscribed for live updates). */
export const dockChatIds = (windows: DockWindow[]): string[] =>
  windows.flatMap((w) => (w.kind === 'chat' ? [w.chatId] : []));
