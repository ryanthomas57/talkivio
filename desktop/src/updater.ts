/**
 * Updates from the GitHub releases (electron-updater): checked at start and every 4 hours, downloaded in the
 * background and installed on restart. macOS only installs updates into a Developer ID signed app, so an unsigned
 * build tells the user a new version exists and opens the download page instead.
 */
import { app, dialog, Notification, shell } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { execFile } from 'node:child_process';
import { asset, DOWNLOAD_PAGE } from './config';
import { getWindow, life } from './window';

const CHECK_EVERY_MS = 4 * 3600_000;
let installs: Promise<boolean> | null = null;
let downloaded: UpdateInfo | null = null;
let announced: string | null = null;

/** Can this copy install updates itself? Windows: yes. macOS: only when signed with a Developer ID. */
function installsUpdates(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(true);
  installs ??= new Promise((resolve) => {
    const bundle = process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
    execFile('codesign', ['-dv', '--verbose=2', bundle], (err, _out, stderr) =>
      resolve(!err && /Authority=Developer ID Application/.test(String(stderr))),
    );
  });
  return installs;
}

function restartToUpdate(): void {
  life.quitting = true;
  autoUpdater.quitAndInstall();
}

function notify(title: string, body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: asset('assets/icon.png') });
  n.on('click', onClick);
  n.show();
}

export function startUpdater(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    downloaded = info;
    notify(
      'Talkivio update ready',
      `Version ${info.version} installs when you restart Talkivio. Click to restart now.`,
      restartToUpdate,
    );
  });
  autoUpdater.on('update-available', (info) => {
    if (autoUpdater.autoDownload || announced === info.version) return;
    announced = info.version;
    notify(
      'A new version of Talkivio is available',
      `Version ${info.version}: click to download it.`,
      () => void shell.openExternal(DOWNLOAD_PAGE),
    );
  });
  autoUpdater.on('error', (err) => console.warn(`update check failed: ${err.message}`));
  void (async () => {
    autoUpdater.autoDownload = await installsUpdates();
    const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
    check();
    setInterval(check, CHECK_EVERY_MS).unref();
  })();
}

/** "Check for Updates…" from the menus: always answers, with a dialog. */
export async function checkForUpdatesManually(): Promise<void> {
  const win = getWindow() ?? undefined;
  const show = (message: string, detail: string, buttons = ['OK']) =>
    win
      ? dialog.showMessageBox(win, { type: 'info', message, detail, buttons })
      : dialog.showMessageBox({ type: 'info', message, detail, buttons });
  if (!app.isPackaged) {
    await show('Updates', 'Updates are checked in the installed app, not in a development build.');
    return;
  }
  if (downloaded) {
    const r = await show(`Talkivio ${downloaded.version} is ready`, 'Restart Talkivio to finish updating.', [
      'Restart Now',
      'Later',
    ]);
    if (r.response === 0) restartToUpdate();
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo.version;
    if (!result || !latest || result.isUpdateAvailable === false || latest === app.getVersion()) {
      await show("You're up to date", `Talkivio ${app.getVersion()} is the latest version.`);
    } else if (await installsUpdates()) {
      await show(`Downloading Talkivio ${latest}`, "You'll be told when it's ready to install.");
    } else {
      const r = await show(
        `Talkivio ${latest} is available`,
        'Download it from talkivio.com and replace this copy.',
        ['Download', 'Later'],
      );
      if (r.response === 0) void shell.openExternal(DOWNLOAD_PAGE);
    }
  } catch (err) {
    await show("Couldn't check for updates", (err as Error).message);
  }
}
