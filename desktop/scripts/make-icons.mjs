#!/usr/bin/env node
/**
 * Generates the desktop app's icons from the brand master (docs/brand/talkivio-icon-master.png, the transparent mark):
 *
 *   build/icon.png            1024 px macOS app icon: the logo on transparency, as on the website
 *   build/icon-win.png        256 px Windows app icon (electron-builder makes the .ico)
 *   assets/icon.png           512 px window / notification icon
 *   assets/trayTemplate.png   18 + 36 px (@2x) black silhouette for the macOS menu bar (tinted by the system)
 *   assets/tray.png           32 px colour mark for the Windows notification area
 *   assets/badges/*.png       32 px red unread badges (1-9, 9+) for the Windows taskbar overlay
 *
 *   node scripts/make-icons.mjs   (outputs are committed; rerun only when the brand changes)
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = resolve(ROOT, '../docs/brand/talkivio-icon-master.png');
const out = (p) => {
  const f = resolve(ROOT, p);
  mkdirSync(dirname(f), { recursive: true });
  return f;
};

/** The mark scaled to fit a box, centred on a transparent canvas of that box. */
async function markIn(box, height) {
  const mark = await sharp(MASTER).resize({ height, fit: 'inside' }).png().toBuffer();
  const { width: w, height: h } = await sharp(mark).metadata();
  return sharp({
    create: { width: box, height: box, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: mark, left: Math.round((box - w) / 2), top: Math.round((box - h) / 2) }])
    .png()
    .toBuffer();
}

/** The logo itself on a transparent canvas, like the website's icon (docs/brand/talkivio-app-icon-512.png). */
async function appIcon(size, markHeight, file) {
  await sharp(await markIn(size, markHeight)).toFile(out(file));
}

/** Black silhouette of the mark (alpha kept) for a macOS template image. */
async function template(size, file) {
  const mark = await markIn(size, Math.round(size * 0.94));
  const alpha = await sharp(mark).extractChannel('alpha').toBuffer();
  await sharp({ create: { width: size, height: size, channels: 3, background: '#000000' } })
    .joinChannel(alpha)
    .png()
    .toFile(out(file));
}

function badgeSvg(label) {
  const small = label.length > 1;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
    <circle cx="16" cy="16" r="15" fill="#e5484d" stroke="#ffffff" stroke-width="2"/>
    <text x="16" y="${small ? 21 : 22.5}" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif"
      font-size="${small ? 14 : 19}" font-weight="700" fill="#ffffff">${label}</text>
  </svg>`);
}

// The mark fills most of the canvas (macOS keeps a small margin around free-form icons).
await appIcon(1024, 900, 'build/icon.png');
await appIcon(256, 240, 'build/icon-win.png');
await appIcon(512, 460, 'assets/icon.png');
await template(18, 'assets/trayTemplate.png');
await template(36, 'assets/trayTemplate@2x.png');
await sharp(await markIn(32, 30)).toFile(out('assets/tray.png'));
for (const label of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '9+'])
  await sharp(badgeSvg(label))
    .png()
    .toFile(out(`assets/badges/${label === '9+' ? '9plus' : label}.png`));
console.log('icons written to build/ and assets/');
