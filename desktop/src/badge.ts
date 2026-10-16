/**
 * Unread badge: the dashboard prefixes its title with the waiting + unread count ("(3) Talkivio"). The app mirrors it
 * on the Dock icon (macOS), as a taskbar overlay (Windows) and on the tray icon, and asks for attention (Dock bounce,
 * taskbar flash) when the count goes up while the window is not in front.
 */
import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import { asset } from './config';
import { setTrayCount } from './tray';

let current = 0;
const overlays = new Map<string, NativeImage>();

export function countFromTitle(title: string): number {
  const m = /^\((\d+)\+?\)/.exec(title.trim());
  return m ? Number(m[1]) : 0;
}

function overlay(count: number): NativeImage {
  const key = count > 9 ? '9plus' : String(count);
  let img = overlays.get(key);
  if (!img) {
    img = nativeImage.createFromPath(asset('assets/badges', `${key}.png`));
    overlays.set(key, img);
  }
  return img;
}

export function setBadge(win: BrowserWindow, count: number): void {
  if (count === current) return;
  const rose = count > current;
  current = count;
  const label = count > 99 ? '99+' : count ? String(count) : '';
  if (process.platform === 'darwin') app.dock?.setBadge(label);
  else if (process.platform === 'win32')
    win.setOverlayIcon(count ? overlay(count) : null, count ? `${label} waiting or unread` : '');
  else app.setBadgeCount(count);
  setTrayCount(count);
  if (rose && !win.isFocused()) {
    if (process.platform === 'darwin') app.dock?.bounce('informational');
    else win.flashFrame(true);
  }
}

export function badgeCount(): number {
  return current;
}

/** Follow the dashboard's title. */
export function trackBadge(win: BrowserWindow): void {
  win.webContents.on('page-title-updated', (_e, title) => setBadge(win, countFromTitle(title)));
  // Signed out or offline page: no count.
  win.webContents.on('did-navigate', () => setBadge(win, countFromTitle(win.webContents.getTitle())));
}
