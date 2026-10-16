/**
 * How the window treats the web: only dashboard pages load inside the app (everything else opens in the default
 * browser), the dashboard may show notifications and nothing more, downloads go to the Downloads folder, a native
 * right-click menu with spelling suggestions, and an offline page when the dashboard cannot be reached.
 */
import {
  app,
  clipboard,
  Menu,
  Notification,
  session,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { APP_URL, asset, isAppDownload, isAppUrl } from './config';

/** Permissions the dashboard may use; every other request (camera, location, USB, ...) is refused. */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen']);

/** Downloads of these types open in their default app once saved; anything else is shown in its folder. */
const OPEN_AFTER_DOWNLOAD = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.pdf',
  '.txt',
  '.csv',
  '.json',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.mp3',
  '.m4a',
  '.wav',
  '.mp4',
  '.mov',
]);

/** Open a link in the user's browser or mail app (only web and mail links: no file:// or custom schemes). */
export function openExternal(raw: string): void {
  try {
    const u = new URL(raw);
    if (['https:', 'http:', 'mailto:', 'tel:'].includes(u.protocol)) void shell.openExternal(u.toString());
  } catch {
    /* not a URL */
  }
}

export function setupSession(): void {
  const ses = session.defaultSession;
  // The dashboard and the website can tell they run inside the app (e.g. to hide the download link).
  ses.setUserAgent(`${ses.getUserAgent()} TalkivioDesktop/${app.getVersion()}`);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(isAppUrl(details.requestingUrl) && ALLOWED_PERMISSIONS.has(permission)),
  );
  ses.setPermissionCheckHandler(
    (_wc, permission, origin) => isAppUrl(origin) && ALLOWED_PERMISSIONS.has(permission),
  );
  if (process.platform !== 'darwin') ses.setSpellCheckerLanguages(['en-US']);

  ses.on('will-download', (_e, item) => {
    const dir = app.getPath('downloads');
    const name = basename(item.getFilename() || 'download');
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let target = join(dir, name);
    for (let i = 1; existsSync(target); i++) target = join(dir, `${stem} (${i})${ext}`);
    item.setSavePath(target);
    item.once('done', (_ev, state) => {
      if (state !== 'completed') return;
      if (OPEN_AFTER_DOWNLOAD.has(ext.toLowerCase())) void shell.openPath(target);
      else shell.showItemInFolder(target);
      if (Notification.isSupported())
        new Notification({ title: 'Download complete', body: basename(target), silent: true }).show();
    });
  });
}

/** Navigation, new windows, the right-click menu and the offline page for the main window. */
export function guardWebContents(win: BrowserWindow): void {
  const wc = win.webContents;

  wc.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  wc.on('will-redirect', (e, url) => {
    if (isAppUrl(url) || !isAppUrl(wc.getURL())) return;
    // A dashboard page redirecting off-site (e.g. a hosted payment page): continue in the browser.
    e.preventDefault();
    openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isAppDownload(url)) wc.downloadURL(url);
    else if (url.startsWith('blob:') && isAppUrl(wc.getURL())) wc.downloadURL(url);
    else openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());

  wc.on('context-menu', (_e, p) => {
    const items: MenuItemConstructorOptions[] = [];
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5))
        items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      items.push(
        {
          label: 'Add to Dictionary',
          click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord),
        },
        { type: 'separator' },
      );
    }
    if (p.linkURL) {
      items.push(
        { label: 'Open Link in Browser', click: () => openExternal(p.linkURL) },
        { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Save Image', click: () => wc.downloadURL(p.srcURL) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      items.push(
        { role: 'undo', enabled: p.editFlags.canUndo },
        { role: 'redo', enabled: p.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: p.editFlags.canCut },
        { role: 'copy', enabled: p.editFlags.canCopy },
        { role: 'paste', enabled: p.editFlags.canPaste },
        { role: 'selectAll' },
      );
    } else if (p.selectionText.trim()) {
      items.push({ role: 'copy' });
    }
    while (items.length && items[items.length - 1]?.type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // The dashboard is unreachable (no internet, server restarting): a local page that retries on its own.
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: a navigation replaced this one */ || !isAppUrl(url))
      return;
    void wc.loadFile(asset('static/offline.html'), {
      query: { url, origin: APP_URL.origin, reason: description },
    });
  });
}
