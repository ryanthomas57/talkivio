/** Text utilities shared by API, dashboard and widget. */

/**
 * Mask payment card numbers (13–19 digits, Luhn-valid). Keeps the first 6 and
 * last 4 digits, matching classic redaction. Digits inside URLs are left alone.
 */
export function maskCreditCards(input: string): string {
  // 13–19 digits with single spaces/dashes between them; the match always ends on a digit, so the space or word
  // after a number is kept.
  return input.replace(/(https?:\/\/\S+)|\b\d(?:[ -]?\d){12,18}\b/g, (match, url: string | undefined) => {
    if (url) return match;
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return match;
    return `${digits.slice(0, 6)}${'*'.repeat(digits.length - 10)}${digits.slice(-4)}`;
  });
}

export function containsCreditCard(input: string): boolean {
  return maskCreditCards(input) !== input;
}

export function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function truncate(input: string, max = 140): string {
  const s = input.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Deterministic, accessible avatar color for a visitor/agent id. */
const AVATAR_COLORS = ['#07778A', '#3675C9', '#8A5A2B', '#7B4BB7', '#B5475E', '#2E7D4F', '#A2672A', '#4A5D7A', '#0F7A8A', '#9A4A2F'];
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Generated visitor display name, e.g. "Visitor 48213", derived from the id. */
export function generatedVisitorName(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) >>> 0;
  return `Visitor ${10000 + (h % 90000)}`;
}

export interface TextToken {
  kind: 'text' | 'link';
  value: string;
  href?: string;
}

/**
 * Split text into plain/link tokens for safe rendering (no HTML is ever produced from user content).
 * Only http(s) and mailto links are recognised.
 */
export function tokenizeLinks(input: string): TextToken[] {
  const re = /\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]|www\.[^\s<>"']+[^\s<>"'.,;:!?)\]]|[\w.+-]+@[\w-]+\.[\w.-]+\w)/gi;
  const out: TextToken[] = [];
  let last = 0;
  for (const m of input.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: 'text', value: input.slice(last, idx) });
    const raw = m[0];
    let href = raw;
    if (raw.includes('@') && !raw.startsWith('http')) href = `mailto:${raw}`;
    else if (raw.toLowerCase().startsWith('www.')) href = `https://${raw}`;
    out.push({ kind: 'link', value: raw, href });
    last = idx + raw.length;
  }
  if (last < input.length) out.push({ kind: 'text', value: input.slice(last) });
  return out;
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '—';
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}
