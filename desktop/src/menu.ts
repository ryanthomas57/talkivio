/** Application menu: the standard macOS menus (Windows shows it with Alt) plus Go shortcuts to the main pages. */
import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { APP_URL, SUPPORT_EMAIL } from './config';
import { checkForUpdatesManually } from './updater';
import { openExternal } from './web';
import { getWindow, life, showWindow } from './window';

/** Open a dashboard page: a client-side navigation through its own sidebar link when it is there (no reload). */
export function goTo(path: string): void {
  const win = getWindow();
  if (!win) return showWindow();
  showWindow();
  const js = `(() => { const a = document.querySelector('a[href="${path}"]'); if (a) { a.click(); return true; } return false; })()`;
  win.webContents
    .executeJavaScript(js, true)
    .then((done: boolean) => {
      if (!done) void win.loadURL(new URL(path, APP_URL).toString());
    })
    .catch(() => void win.loadURL(new URL(path, APP_URL).toString()));
}

const PAGES: Array<[string, string]> = [
  ['Inbox', '/inbox'],
  ['Visitors', '/visitors'],
  ['History', '/history'],
  ['Overview', '/overview'],
  ['Analytics', '/analytics'],
  ['Team', '/team'],
];

export function setAppMenu(): void {
  const mac = process.platform === 'darwin';
  const settings: MenuItemConstructorOptions = {
    label: mac ? 'Settings…' : 'Settings',
    accelerator: 'CmdOrCtrl+,',
    click: () => goTo('/settings/account'),
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { label: 'Check for Updates…', click: () => void checkForUpdatesManually() },
              { type: 'separator' },
              settings,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              {
                label: 'Quit Talkivio',
                accelerator: 'Cmd+Q',
                click: () => {
                  life.quitting = true;
                  app.quit();
                },
              },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : [
          {
            label: 'File',
            submenu: [
              settings,
              { type: 'separator' },
              {
                label: 'Quit Talkivio',
                accelerator: 'Ctrl+Q',
                click: () => {
                  life.quitting = true;
                  app.quit();
                },
              },
            ],
          } satisfies MenuItemConstructorOptions,
        ]),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        ...PAGES.map(([label, path], i): MenuItemConstructorOptions => ({
          label,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => goTo(path),
        })),
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: mac ? 'Cmd+[' : 'Alt+Left',
          click: () => getWindow()?.webContents.navigationHistory.goBack(),
        },
        {
          label: 'Forward',
          accelerator: mac ? 'Cmd+]' : 'Alt+Right',
          click: () => getWindow()?.webContents.navigationHistory.goForward(),
        },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Talkivio Website', click: () => openExternal(APP_URL.origin) },
        { label: 'Contact Support', click: () => openExternal(`mailto:${SUPPORT_EMAIL}`) },
        ...(mac
          ? []
          : [
              { type: 'separator' } as const,
              { label: 'Check for Updates…', click: () => void checkForUpdatesManually() },
            ]),
        ...(mac ? [] : [{ role: 'about' } as const]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
