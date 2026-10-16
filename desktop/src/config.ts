/** Where the app points and which pages count as "inside" it. */
import { app } from 'electron';
import { join } from 'node:path';

/** The dashboard. `TALKIVIO_URL` points a development build at a local or staging dashboard. */
export const APP_URL = new URL(process.env.TALKIVIO_URL ?? 'https://talkivio.com');
export const START_PATH = '/inbox';
export const DOWNLOAD_PAGE = new URL('/download', APP_URL).toString();
export const SUPPORT_EMAIL = 'support@talkivio.com';

/** Bundled files (icons, the offline page): next to `dist/` in development and inside the app archive when packaged. */
export const asset = (...parts: string[]) => join(app.getAppPath(), ...parts);

const www = `www.${APP_URL.hostname}`;

/** A page of the dashboard (the same origin, or its www alias that redirects to it). */
export function isAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.origin === APP_URL.origin || (u.protocol === APP_URL.protocol && u.hostname === www);
  } catch {
    return false;
  }
}

/** A file download served by the dashboard (signed attachment and export URLs). */
export function isAppDownload(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (isAppUrl(raw) && u.pathname.startsWith('/api/')) || u.hostname === `files.${APP_URL.hostname}`;
  } catch {
    return false;
  }
}
