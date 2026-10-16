/**
 * Menu bar (macOS) / notification area (Windows) icon: the way back to a closed window, the unread count, start at
 * login, updates and Quit.
 */
import { app, Menu, nativeImage, Tray } from 'electron';
import { asset } from './config';
import { checkForUpdatesManually } from './updater';
import { life, showWindow } from './window';

let tray: Tray | null = null;
let count = 0;

/**
 * Start at login, in the background (no window: macOS reports `wasOpenedAtLogin`, Windows passes `--hidden`), so
 * alerts are ready as soon as the agent signs in to the Mac or PC.
 */
export function setOpenAtLogin(on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, args: on ? ['--hidden'] : [] });
}

export function opensAtLogin(): boolean {
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open Talkivio', click: showWindow },
    { type: 'separator' },
    {
      label: 'Open at Login',
      type: 'checkbox',
      checked: opensAtLogin(),
      click: (item) => {
        setOpenAtLogin(item.checked);
        refreshTray();
      },
    },
    { label: 'Check for Updates…', click: () => void checkForUpdatesManually() },
    { type: 'separator' },
    {
      label: 'Quit Talkivio',
      accelerator: process.platform === 'darwin' ? 'Cmd+Q' : undefined,
      click: () => {
        life.quitting = true;
        app.quit();
      },
    },
  ]);
}

function tooltip(): string {
  return count ? `Talkivio: ${count} waiting or unread` : 'Talkivio';
}

export function createTray(): Tray {
  const icon =
    process.platform === 'darwin'
      ? nativeImage.createFromPath(asset('assets/trayTemplate.png'))
      : nativeImage.createFromPath(asset('assets/tray.png')).resize({ width: 16, height: 16 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(tooltip());
  tray.setContextMenu(buildMenu());
  // Windows: a click on the icon opens the window (the menu stays on right-click).
  if (process.platform !== 'darwin') tray.on('click', showWindow);
  return tray;
}

export function refreshTray(): void {
  tray?.setContextMenu(buildMenu());
}

export function setTrayCount(n: number): void {
  count = n;
  if (!tray) return;
  tray.setToolTip(tooltip());
  if (process.platform === 'darwin') tray.setTitle(n ? String(n > 99 ? '99+' : n) : '');
}
