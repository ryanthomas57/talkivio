/**
 * Upload policy (ch. 19): allowlisted types, MIME↔extension consistency, filename
 * sanitisation and server-side content inspection (magic bytes, container structure,
 * macro/active-content detection). Pure functions — no I/O — so they are unit tested.
 */
import { inflateRawSync } from 'node:zlib';

export const PLATFORM_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 5;

export type FileKind = 'image' | 'pdf' | 'text' | 'ooxml' | 'odf';

export interface AllowedType {
  mime: string;
  exts: string[];
  kind: FileKind;
  /** OOXML: part that must exist; ODF: required mimetype entry value is `mime`. */
  marker?: string;
}

export const ALLOWED_TYPES: readonly AllowedType[] = [
  { mime: 'image/jpeg', exts: ['.jpg', '.jpeg'], kind: 'image' },
  { mime: 'image/png', exts: ['.png'], kind: 'image' },
  { mime: 'image/webp', exts: ['.webp'], kind: 'image' },
  { mime: 'application/pdf', exts: ['.pdf'], kind: 'pdf' },
  { mime: 'text/plain', exts: ['.txt'], kind: 'text' },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', exts: ['.docx'], kind: 'ooxml', marker: 'word/document.xml' },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', exts: ['.xlsx'], kind: 'ooxml', marker: 'xl/workbook.xml' },
  { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', exts: ['.pptx'], kind: 'ooxml', marker: 'ppt/presentation.xml' },
  { mime: 'application/vnd.oasis.opendocument.text', exts: ['.odt'], kind: 'odf' },
  { mime: 'application/vnd.oasis.opendocument.spreadsheet', exts: ['.ods'], kind: 'odf' },
];

const BY_MIME = new Map(ALLOWED_TYPES.map((t) => [t.mime, t]));
const BY_EXT = new Map(ALLOWED_TYPES.flatMap((t) => t.exts.map((e) => [e, t] as const)));

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};

/** Why a file type is refused (safe for users; never scanner internals). */
export type BlockReason =
  | 'executable'
  | 'script'
  | 'html'
  | 'svg'
  | 'archive'
  | 'macro'
  | 'type_not_allowed'
  | 'type_mismatch'
  | 'pdf_active_content'
  | 'corrupt'
  | 'image_too_large'
  | 'encrypted'
  | 'malware'
  | 'checksum_mismatch'
  | 'size_mismatch';

const BLOCKED_EXTS: Record<string, BlockReason> = {};
for (const e of ['exe', 'dll', 'msi', 'msp', 'com', 'scr', 'pif', 'cpl', 'sys', 'bin', 'elf', 'app', 'apk', 'ipa', 'dmg', 'deb', 'rpm', 'jar', 'class', 'so', 'dylib', 'o', 'out'])
  BLOCKED_EXTS[`.${e}`] = 'executable';
for (const e of ['js', 'mjs', 'cjs', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'sh', 'bash', 'zsh', 'csh', 'ksh', 'py', 'pyc', 'pl', 'rb', 'php', 'phtml', 'lnk', 'hta', 'reg', 'scpt', 'applescript', 'command', 'url', 'inf', 'gadget', 'msc'])
  BLOCKED_EXTS[`.${e}`] = 'script';
for (const e of ['html', 'htm', 'xhtml', 'shtml', 'mht', 'mhtml', 'xht', 'xml', 'xsl', 'xslt', 'swf']) BLOCKED_EXTS[`.${e}`] = 'html';
for (const e of ['svg', 'svgz']) BLOCKED_EXTS[`.${e}`] = 'svg';
for (const e of ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'xz', 'txz', 'iso', 'img', 'cab', 'arj', 'lz', 'lzh', 'lzma', 'zst', 'z', 'ace', 'war', 'ear'])
  BLOCKED_EXTS[`.${e}`] = 'archive';
for (const e of ['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'xlsb', 'pptm', 'potm', 'ppsm', 'ppam', 'sldm', 'doc', 'dot', 'xls', 'xlt', 'ppt', 'pps', 'pot', 'odb', 'rtf'])
  BLOCKED_EXTS[`.${e}`] = 'macro';

export class PolicyViolation extends Error {
  constructor(
    readonly code: 'FILE_TYPE_BLOCKED' | 'FILE_TOO_LARGE' | 'FILE_REJECTED' | 'VALIDATION_FAILED',
    readonly reason: BlockReason | 'name' | 'size',
    message: string,
  ) {
    super(message);
  }
}

/** Human message for a block reason (no scanner output). */
export function reasonMessage(reason: BlockReason | 'name' | 'size'): string {
  switch (reason) {
    case 'executable':
      return 'Programs and executable files cannot be shared.';
    case 'script':
      return 'Script files cannot be shared.';
    case 'html':
    case 'svg':
      return 'Web pages, SVG and markup files cannot be shared.';
    case 'archive':
      return 'Archives (zip, rar, 7z …) cannot be shared.';
    case 'macro':
      return 'Documents that can contain macros cannot be shared.';
    case 'type_mismatch':
      return 'The file contents do not match its type or extension.';
    case 'pdf_active_content':
      return 'PDFs with embedded scripts, launch actions or attached files cannot be shared.';
    case 'corrupt':
      return 'The file appears to be damaged.';
    case 'image_too_large':
      return 'The image dimensions are too large.';
    case 'encrypted':
      return 'Password-protected documents cannot be checked and were blocked.';
    case 'malware':
      return 'The file failed the security check.';
    case 'checksum_mismatch':
    case 'size_mismatch':
      return 'The upload was incomplete or changed during transfer. Please try again.';
    case 'size':
      return 'The file is too large.';
    case 'name':
      return 'The file name is not valid.';
    default:
      return 'This file type is not allowed.';
  }
}

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

/**
 * Safe display/download name: basename only, NFC, no control or bidi-override
 * characters, no reserved path characters, bounded length (extension preserved).
 */
export function sanitizeFilename(input: string): string {
  let name = input.normalize('NFC');
  name = name.split(/[\\/]/).pop() ?? '';
  name = name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (name.length > 180) {
    const ext = extensionOf(name).slice(0, 12);
    name = name.slice(0, 180 - ext.length).trimEnd() + ext;
  }
  return name;
}

export function canonicalMime(declared: string | null | undefined, ext: string): string {
  let mime = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  mime = MIME_ALIASES[mime] ?? mime;
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    mime = BY_EXT.get(ext)?.mime ?? mime;
  }
  return mime;
}

/** Tenant allow-list entries are MIME types or `.ext`; the platform allow-list always applies. */
export function tenantAllows(type: AllowedType, tenantAllowed: readonly string[] | null | undefined): boolean {
  if (!tenantAllowed || !tenantAllowed.length) return true;
  const set = new Set(tenantAllowed.map((s) => s.toLowerCase()));
  return set.has(type.mime) || type.exts.some((e) => set.has(e));
}

export interface DeclaredFile {
  name: string;
  mime: string;
  ext: string;
  type: AllowedType;
}

/** Validates the client's declaration before any bytes are transferred. */
export function validateDeclaration(input: { name: string; mime: string; sizeBytes: number }, policy: { maxBytes: number; tenantAllowed?: readonly string[] | null }): DeclaredFile {
  const name = sanitizeFilename(input.name);
  if (!name) throw new PolicyViolation('VALIDATION_FAILED', 'name', reasonMessage('name'));
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new PolicyViolation('VALIDATION_FAILED', 'size', 'The file is empty.');
  if (input.sizeBytes > Math.min(policy.maxBytes, PLATFORM_MAX_FILE_BYTES)) {
    throw new PolicyViolation('FILE_TOO_LARGE', 'size', `Files can be at most ${Math.floor(Math.min(policy.maxBytes, PLATFORM_MAX_FILE_BYTES) / (1024 * 1024))} MB.`);
  }
  const ext = extensionOf(name);
  const blocked = BLOCKED_EXTS[ext];
  if (blocked) throw new PolicyViolation('FILE_TYPE_BLOCKED', blocked, reasonMessage(blocked));
  const mime = canonicalMime(input.mime, ext);
  if (mime === 'image/svg+xml') throw new PolicyViolation('FILE_TYPE_BLOCKED', 'svg', reasonMessage('svg'));
  if (/html|javascript|ecmascript|x-sh|x-msdownload|x-executable|zip|compressed|x-rar|x-7z|x-tar|macroenabled/i.test(mime)) {
    const reason: BlockReason = /html/i.test(mime) ? 'html' : /zip|compressed|rar|7z|tar/i.test(mime) ? 'archive' : /macro/i.test(mime) ? 'macro' : /msdownload|executable/i.test(mime) ? 'executable' : 'script';
    throw new PolicyViolation('FILE_TYPE_BLOCKED', reason, reasonMessage(reason));
  }
  const type = BY_MIME.get(mime);
  if (!type || !tenantAllows(type, policy.tenantAllowed)) throw new PolicyViolation('FILE_TYPE_BLOCKED', 'type_not_allowed', reasonMessage('type_not_allowed'));
  if (!type.exts.includes(ext)) throw new PolicyViolation('FILE_TYPE_BLOCKED', 'type_mismatch', 'The file extension does not match its type.');
  return { name, mime, ext, type };
}

// ───────────────────────── Content inspection ─────────────────────────

// Built from parts so this source file is not itself detected as the test signature.
const EICAR = Buffer.from(['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-', 'TEST-FILE!$H+H*'].join(''), 'latin1');

/** The EICAR anti-malware test signature (deterministic built-in check, all scan modes). */
export function containsEicar(buf: Buffer): boolean {
  return buf.includes(EICAR);
}

export type InspectResult =
  | { ok: true; detectedMime: string }
  | { ok: false; code: 'FILE_TYPE_BLOCKED' | 'FILE_REJECTED'; reason: BlockReason; detail: string };

const block = (reason: BlockReason, detail: string): InspectResult => ({
  ok: false,
  code: reason === 'malware' || reason === 'corrupt' || reason === 'checksum_mismatch' || reason === 'size_mismatch' || reason === 'image_too_large' ? 'FILE_REJECTED' : 'FILE_TYPE_BLOCKED',
  reason,
  detail,
});

const startsWith = (buf: Buffer, bytes: number[], offset = 0) => buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
const ascii = (buf: Buffer, s: string, offset = 0) => buf.length >= offset + s.length && buf.toString('latin1', offset, offset + s.length) === s;

/** Container/format detection from leading bytes. */
export function sniff(buf: Buffer): string {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(buf, 'RIFF') && ascii(buf, 'WEBP', 8)) return 'image/webp';
  if (ascii(buf, '%PDF-')) return 'application/pdf';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (ascii(buf, 'MZ')) return 'executable';
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return 'executable';
  if ([[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((m) => startsWith(buf, m))) return 'executable';
  if (ascii(buf, '\0asm')) return 'executable';
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole2';
  if (ascii(buf, 'Rar!') || startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || startsWith(buf, [0x1f, 0x8b]) || ascii(buf, 'BZh') || startsWith(buf, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) || ascii(buf, 'ustar', 257) || startsWith(buf, [0x28, 0xb5, 0x2f, 0xfd]) || ascii(buf, 'MSCF')) return 'archive';
  if (ascii(buf, 'GIF87a') || ascii(buf, 'GIF89a')) return 'image/gif';
  if (ascii(buf, '{\\rtf')) return 'rtf';
  if (ascii(buf, '#!')) return 'script';
  return 'unknown';
}

function imageDimensions(buf: Buffer, mime: string): { w: number; h: number } | null {
  try {
    if (mime === 'image/png') {
      if (!ascii(buf, 'IHDR', 12)) return null;
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (mime === 'image/webp') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b0 = buf[21]!;
        const b1 = buf[22]!;
        const b2 = buf[23]!;
        const b3 = buf[24]!;
        return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
      }
      if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      return null;
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1]!;
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          i += 2;
          continue;
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

const MAX_SIDE = 16_384;
const MAX_PIXELS = 50_000_000;

function inspectImage(buf: Buffer, mime: string): InspectResult {
  const d = imageDimensions(buf, mime);
  if (!d || d.w <= 0 || d.h <= 0) return block('corrupt', 'image header unreadable');
  if (d.w > MAX_SIDE || d.h > MAX_SIDE || d.w * d.h > MAX_PIXELS) return block('image_too_large', `${d.w}x${d.h}`);
  return { ok: true, detectedMime: mime };
}

/** Rejects PDFs carrying active content (JavaScript, launch actions, embedded files, rich media). */
function inspectPdf(buf: Buffer): InspectResult {
  // Decode #xx escapes in names (e.g. /J#61vaScript) before matching.
  const text = buf.toString('latin1').replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  // Active content inside compressed object streams is left to the malware scanner's PDF engine.
  const m = /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia)(?=[\s/<>[\]()%{}]|$)/.exec(text);
  if (m) return block('pdf_active_content', `/${m[1]}`);
  return { ok: true, detectedMime: 'application/pdf' };
}

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

function inspectText(buf: Buffer): InspectResult {
  let s: string;
  try {
    s = TEXT_DECODER.decode(buf);
  } catch {
    return block('type_mismatch', 'not valid UTF-8 text');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(s)) return block('type_mismatch', 'binary control characters');
  const head = s.replace(/^﻿/, '').trimStart().slice(0, 64).toLowerCase();
  if (/^(<!doctype|<html|<head|<body|<script|<iframe|<\?xml|<svg|<!--)/.test(head)) return block('html', 'markup content');
  if (head.startsWith('#!')) return block('script', 'shebang');
  return { ok: true, detectedMime: 'text/plain' };
}

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Minimal ZIP central-directory reader with bomb/traversal/encryption limits. */
export function readZipEntries(buf: Buffer): ZipEntry[] | null {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > buf.length || count > 10_000) return null;
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) return null;
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipEntryData(buf: Buffer, e: ZipEntry, maxBytes: number): Buffer | null {
  if (e.localOffset + 30 > buf.length || buf.readUInt32LE(e.localOffset) !== 0x04034b50) return null;
  const start = e.localOffset + 30 + buf.readUInt16LE(e.localOffset + 26) + buf.readUInt16LE(e.localOffset + 28);
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return raw.subarray(0, Math.min(raw.length, maxBytes));
  if (e.method === 8) {
    try {
      return inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch {
      return null;
    }
  }
  return null;
}

const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;

function inspectZipDocument(buf: Buffer, declared: AllowedType): InspectResult {
  const entries = readZipEntries(buf);
  if (!entries || !entries.length) return block('corrupt', 'zip directory unreadable');
  let total = 0;
  for (const e of entries) {
    if (e.flags & 0x1) return block('encrypted', 'encrypted entry');
    if (e.name.includes('..') || e.name.startsWith('/') || e.name.includes('\\')) return block('corrupt', 'unsafe entry path');
    total += e.uncompressedSize;
    if (total > MAX_TOTAL_UNCOMPRESSED) return block('archive', 'expands too much');
    if (e.uncompressedSize > 1024 * 1024 && e.compressedSize > 0 && e.uncompressedSize / e.compressedSize > 200) return block('archive', 'compression ratio');
    if (/(^|\/)vbaProject\.bin$|(^|\/)vbaData\.xml$|(^|\/)activeX\/|\.(exe|dll|js|vbs|bat|cmd|ps1|scr|jar|msi)$/i.test(e.name)) return block('macro', 'macro or executable part');
  }
  const names = new Set(entries.map((e) => e.name));
  if (declared.kind === 'ooxml') {
    const ct = entries.find((e) => e.name === '[Content_Types].xml');
    if (!ct) return block('type_mismatch', 'not an Office Open XML package');
    const marker = declared.marker!;
    if (!names.has(marker)) return block('type_mismatch', `missing ${marker}`);
    const ctXml = zipEntryData(buf, ct, 1024 * 1024)?.toString('utf8');
    if (ctXml === undefined) return block('corrupt', 'content types unreadable');
    if (/macroEnabled|vbaProject|ms-office\.vbaProject/i.test(ctXml)) return block('macro', 'macro-enabled content type');
    return { ok: true, detectedMime: declared.mime };
  }
  // OpenDocument: `mimetype` must be the first entry, stored, matching the declared type.
  const first = entries[0]!;
  if (first.name !== 'mimetype') return block('type_mismatch', 'not an OpenDocument package');
  const mt = zipEntryData(buf, first, 256)?.toString('ascii').trim();
  if (mt !== declared.mime) return block('type_mismatch', 'OpenDocument mimetype differs');
  if (!names.has('content.xml')) return block('corrupt', 'missing content.xml');
  if (entries.some((e) => /^(Basic|Scripts)\//.test(e.name))) return block('macro', 'OpenDocument macros');
  return { ok: true, detectedMime: declared.mime };
}

/**
 * Full content inspection for a declared type. Order: test signature, magic bytes,
 * type equality with the declaration, then format-specific structure checks.
 */
export function inspectContent(buf: Buffer, declaredMime: string): InspectResult {
  if (containsEicar(buf)) return block('malware', 'Eicar-Test-Signature');
  const declared = BY_MIME.get(declaredMime);
  if (!declared) return block('type_not_allowed', declaredMime);
  const detected = sniff(buf);
  switch (detected) {
    case 'executable':
      return block('executable', 'executable magic bytes');
    case 'script':
      return block('script', 'script magic bytes');
    case 'archive':
      return block('archive', 'archive magic bytes');
    case 'ole2':
    case 'rtf':
      return block('macro', 'legacy Office/RTF container');
    case 'image/gif':
      return block('type_not_allowed', 'gif');
  }
  switch (declared.kind) {
    case 'image':
      return detected === declared.mime ? inspectImage(buf, declared.mime) : block('type_mismatch', `detected ${detected}`);
    case 'pdf':
      return detected === 'application/pdf' ? inspectPdf(buf) : block('type_mismatch', `detected ${detected}`);
    case 'text':
      return detected === 'unknown' ? inspectText(buf) : block('type_mismatch', `detected ${detected}`);
    case 'ooxml':
    case 'odf':
      return detected === 'zip' ? inspectZipDocument(buf, declared) : block('type_mismatch', `detected ${detected}`);
  }
}

export function isImageMime(mime: string): boolean {
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp';
}
