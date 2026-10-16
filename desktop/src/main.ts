/**
 * Talkivio desktop app (Mac and Windows): the live dashboard in its own window, running in the menu bar /
 * notification area when the window is closed so chat and visitor alerts keep coming, with an unread badge on the
 * app icon, native notifications, sounds that always play, downloads, spell check and automatic updates.
 */
import { app, ipcMain } from 'electron';
import { trackBadge } from './badge';
import { isAppUrl } from './config';
import { setAppMenu } from './menu';
import { createTray } from './tray';
import { startUpdater } from './updater';
import { guardWebContents, setupSession } from './web';
import { createWindow, life, onWindowCreated, showWindow } from './window';

if (!app.requestSingleInstanceLock()) {
  // Already running: that instance shows its window (second-instance below).
  app.quit();
} else {
  app.setAppUserModelId('com.talkivio.desktop');
  // Alert sounds play without a click first (browsers wait for one).
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  const startHidden =
    process.argv.includes('--hidden') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true);

  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => {
    life.quitting = true;
  });
  // The window only hides; this keeps the app alive if it is ever destroyed (e.g. a crash) on Windows.
  app.on('window-all-closed', () => undefined);

  ipcMain.on('talkivio:focus', (e) => {
    if (isAppUrl(e.senderFrame?.url ?? '')) showWindow();
  });

  onWindowCreated((win) => {
    guardWebContents(win);
    trackBadge(win);
    win.webContents.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit') win.webContents.reload();
    });
  });

  void app.whenReady().then(() => {
    setupSession();
    setAppMenu();
    createWindow(startHidden);
    createTray();
    startUpdater();
  });
}
