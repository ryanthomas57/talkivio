/**
 * The main window. Closing it hides it: the app keeps running in the menu bar / notification area so the dashboard
 * stays connected and its sounds and notifications keep coming. Quit from the tray menu, the app menu or Cmd+Q.
 */
import { app, BrowserWindow, Notification, nativeTheme, screen } from 'electron';
import { APP_URL, asset, START_PATH } from './config';
import { readState, writeState, type Bounds } from './store';

let win: BrowserWindow | null = null;
/** Set when the user really quits (menu, Cmd+Q, update install), so close stops hiding the window. */
export const life = { quitting: false };
const setups: Array<(w: BrowserWindow) => void> = [];

export const getWindow = () => win;

/** Wiring applied to every main window (the first one and one recreated after it was destroyed). */
export function onWindowCreated(fn: (w: BrowserWindow) => void): void {
  setups.push(fn);
}

/** The saved bounds if they still fit on a connected display (a monitor may have been unplugged). */
function restoredBounds(): Partial<Bounds> {
  const b = readState().bounds;
  if (!b) return {};
  const area = screen.getDisplayMatching(b).workArea;
  const visible =
    b.x < area.x + area.width - 100 && b.y < area.y + area.height - 100 && b.x + b.width > area.x + 100;
  return visible ? b : { width: b.width, height: b.height };
}

export function createWindow(startHidden: boolean): BrowserWindow {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    ...restoredBounds(),
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Talkivio',
    icon: asset('assets/icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1120' : '#f6f8fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: asset('dist/preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Hidden or minimised, the dashboard keeps its realtime connection and timers running, so alerts arrive.
      backgroundThrottling: false,
      spellcheck: true,
      additionalArguments: [`--talkivio-version=${app.getVersion()}`],
    },
  });
  if (readState().maximized) win.maximize();
  win.once('ready-to-show', () => {
    if (!startHidden) win?.show();
  });

  let saveTimer: NodeJS.Timeout | null = null;
  const saveBounds = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      writeState({ maximized: win.isMaximized(), ...(win.isMaximized() ? {} : { bounds: win.getBounds() }) });
    }, 400);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('focus', () => win?.flashFrame(false));

  win.on('close', (e) => {
    if (life.quitting) return;
    e.preventDefault();
    if (win?.isFullScreen()) {
      // Leaving full screen first: hiding a full-screen window on macOS leaves an empty black Space behind.
      win.once('leave-full-screen', () => win?.hide());
      win.setFullScreen(false);
    } else win?.hide();
    backgroundHint();
  });
  win.on('closed', () => {
    win = null;
  });

  for (const setup of setups) setup(win);
  void win.loadURL(new URL(START_PATH, APP_URL).toString());
  return win;
}

/** Bring the window up (from the tray, the Dock, a notification or a second launch). */
export function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow(false);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

/** Once: tell the user the app is still running (and still alerting) after they close the window. */
function backgroundHint(): void {
  if (readState().closeHintShown || !Notification.isSupported()) return;
  writeState({ closeHintShown: true });
  const n = new Notification({
    title: 'Talkivio is still running',
    body:
      process.platform === 'darwin'
        ? 'You will keep getting chat and visitor alerts. Quit with Cmd+Q or from the menu bar icon.'
        : 'You will keep getting chat and visitor alerts. Quit from the Talkivio icon in the notification area.',
    icon: asset('assets/icon.png'),
    silent: true,
  });
  n.on('click', showWindow);
  n.show();
}
