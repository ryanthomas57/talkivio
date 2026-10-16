# Talkivio Desktop

The Talkivio desktop app for Mac and Windows (Electron). It shows the live dashboard (https://talkivio.com) in its own
window and adds what a browser tab cannot:

- keeps running in the menu bar / notification area when the window is closed, so chat and visitor alerts keep coming
  (the dashboard stays connected: no background throttling);
- the waiting + unread count on the Dock icon (macOS) or as a taskbar overlay (Windows), with a Dock bounce / taskbar
  flash when it goes up while the window is in the background;
- native notifications (allowed automatically; clicking one brings the window forward through the preload bridge) and
  alert sounds that play without a click first;
- Open at Login (starts in the background), automatic updates, downloads saved to the Downloads folder, a right-click
  menu with spelling suggestions, an offline page that reconnects by itself, and a Go menu (Cmd/Ctrl+1 to 6).

Only dashboard pages load inside the window; every other link opens in the default browser. The page gets one
permission (notifications) and a minimal, context-isolated bridge (`window.talkivioDesktop`). The dashboard and the
website detect the app through it and the `TalkivioDesktop/<version>` user agent suffix.

## Develop

```bash
cd desktop
npm install
npm start                                  # against https://talkivio.com
TALKIVIO_URL=http://localhost:3000 npm start   # against the local dashboard
```

`npm run icons` regenerates `build/` and `assets/` from `docs/brand/talkivio-icon-master.png` (outputs are committed).

## Test

`npm test` builds the app and drives it with Playwright: it identifies itself, links off the dashboard open in the
browser, permissions, the Dock badge, close-to-background, the offline page, and (against a local stack only, with the
dashboard's UI test owner) the Go menu. `TALKIVIO_URL` picks the dashboard (default `http://localhost:3000`);
`TALKIVIO_APP_PATH` tests an installed build instead of the sources.

## Installers and releases

```bash
npm run dist:mac   # release/Talkivio-mac-universal.dmg + .zip (Apple silicon and Intel), latest-mac.yml
npm run dist:win   # release/Talkivio-win-x64.exe, latest.yml (build on Windows or in CI)
```

The `Desktop` workflow (`.github/workflows/desktop.yml`) builds and tests both on every change under `desktop/`.
To release: bump `version` in `package.json`, commit, then push a tag `vX.Y.Z` with the same version. The workflow
creates the GitHub release with the installers and the update feeds and publishes it once both builds pass.
https://talkivio.com/download links to the latest release's files (fixed names), and installed apps update from it.

## Signing

Without certificates the builds are unsigned: the Mac app has an ad-hoc signature and users confirm Open Anyway in
System Settings > Privacy & Security once; Windows shows SmartScreen's More info > Run anyway once. Mac apps also
cannot update themselves unsigned, so they announce new versions and open the download page instead.

To sign, add these repository secrets (the workflow and `electron-builder.config.js` pick them up, no code changes):

| Secret                                                     | What                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`                     | Developer ID Application certificate exported as .p12, base64, and its password (Apple Developer Program, $99/year) |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization: the Apple ID, an app-specific password from appleid.apple.com, the team ID                            |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`                     | Windows code signing certificate (.pfx, base64) and its password                                                    |

Then set `DESKTOP.signed` to `true` in `apps/dashboard/src/components/site/site-config.ts` so the download page stops
explaining the first-open warning.
