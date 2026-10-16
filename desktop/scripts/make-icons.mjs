#!/usr/bin/env node
/**
 * Generates the desktop app's icons from the brand master (docs/brand/talkivio-icon-master.png, the transparent mark):
 *
 *   build/icon.png            1024 px macOS app icon: the mark on a rounded navy square inside Apple's icon grid
 *   build/icon-win.png        256 px Windows app icon: the same square, full bleed (electron-builder makes the .ico)
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

/** Navy rounded square with a soft teal glow behind the mark (matches the dark dashboard and apple-icon). */
function squareSvg(size, inset, radius) {
  const s = size - inset * 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#101a33"/><stop offset="1" stop-color="#070b17"/>
      </linearGradient>
      <radialGradient id="glow" cx="0.5" cy="0.42" r="0.55">
        <stop offset="0" stop-color="#05b0bd" stop-opacity="0.28"/><stop offset="1" stop-color="#05b0bd" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect x="${inset}" y="${inset}" width="${s}" height="${s}" rx="${radius}" fill="url(#bg)"/>
    <rect x="${inset}" y="${inset}" width="${s}" height="${s}" rx="${radius}" fill="url(#glow)"/>
    <rect x="${inset + 1}" y="${inset + 1}" width="${s - 2}" height="${s - 2}" rx="${radius - 1}" fill="none"
      stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>
  </svg>`);
}

async function appIcon(size, inset, radius, markHeight, file) {
  await sharp(squareSvg(size, inset, radius))
    .composite([{ input: await markIn(size, markHeight) }])
    .png()
    .toFile(out(file));
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

// Apple's grid: 1024 canvas, 824 square at 100 px with a ~185 px corner radius.
await appIcon(1024, 100, 185, 560, 'build/icon.png');
await appIcon(256, 0, 48, 168, 'build/icon-win.png');
await appIcon(512, 50, 92, 280, 'assets/icon.png');
await template(18, 'assets/trayTemplate.png');
await template(36, 'assets/trayTemplate@2x.png');
await sharp(await markIn(32, 30)).toFile(out('assets/tray.png'));
for (const label of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '9+'])
  await sharp(badgeSvg(label))
    .png()
    .toFile(out(`assets/badges/${label === '9+' ? '9plus' : label}.png`));
console.log('icons written to build/ and assets/');
