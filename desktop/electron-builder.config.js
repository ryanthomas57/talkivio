/**
 * Installers for Talkivio Desktop (electron-builder). See desktop/README.md.
 *   npm run dist:mac   → release/Talkivio-mac-universal.dmg (+ .zip for updates)
 *   npm run dist:win   → release/Talkivio-win-x64.exe
 * Artifact names carry no version so talkivio.com/download links to the latest release's files directly.
 *
 * Signing follows the environment: with CSC_LINK (a Developer ID Application certificate) the Mac app is signed and,
 * with APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID, notarized; without it the app gets an ad-hoc
 * signature (Apple silicon only runs signed code; users confirm "Open Anyway" once). Windows signs with CSC_LINK too.
 */
const signed = !!process.env.CSC_LINK;
const notarize = signed && !!process.env.APPLE_ID && !!process.env.APPLE_TEAM_ID;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.talkivio.desktop',
  productName: 'Talkivio',
  copyright: 'Copyright © 2026 Desverso LLC',
  artifactName: '${productName}-${os}-${arch}.${ext}',
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/**/*', 'assets/**/*', 'static/**/*', 'package.json'],
  asarUnpack: ['assets/**/*'],

  mac: {
    category: 'public.app-category.business',
    icon: 'build/icon.png',
    target: [
      { target: 'dmg', arch: 'universal' },
      { target: 'zip', arch: 'universal' },
    ],
    ...(signed ? {} : { identity: '-' }),
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize,
    extendInfo: { NSUserNotificationAlertStyle: 'alert' },
  },
  dmg: {
    title: 'Talkivio',
    contents: [
      { x: 140, y: 190 },
      { x: 400, y: 190, type: 'link', path: '/Applications' },
    ],
  },

  win: {
    icon: 'build/icon-win.png',
    target: [{ target: 'nsis', arch: 'x64' }],
  },
  nsis: {
    // Per-user, no administrator prompt: installs and updates in one click, like most chat apps.
    oneClick: true,
    perMachine: false,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'Talkivio',
    runAfterFinish: true,
  },

  publish: { provider: 'github', owner: 'ryanthomas57', repo: 'talkivio', releaseType: 'draft' },
};
