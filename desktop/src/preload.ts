/**
 * The only bridge between the dashboard page and the app (sandboxed, context-isolated): it can tell it runs in the
 * desktop app and ask for the window to come forward (a notification was clicked). Nothing else is exposed.
 */
import { contextBridge, ipcRenderer } from 'electron';

const version = process.argv.find((a) => a.startsWith('--talkivio-version='))?.split('=')[1] ?? '';

contextBridge.exposeInMainWorld(
  'talkivioDesktop',
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    version,
    focus: () => ipcRenderer.send('talkivio:focus'),
  }),
);
