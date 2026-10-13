/**
 * Transcript renderers (ch. 20): TXT, JSON, CSV (RFC 4180 + formula-injection
 * neutralisation) and PDF (pdfkit, local fonts only, no remote resources).
 * Input is an already-authorised projection — renderers never decide visibility.
 */
import PDFDocument from 'pdfkit';

export type TranscriptAudience = 'public' | 'staff';

export interface TranscriptAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  mime: string;
  state: string;
}

export interface TranscriptMessage {
  id: string;
  seq: number;
  sentAt: Date;
  sender: { type: 'visitor' | 'agent' | 'system'; name: string };
  visibility: 'public' | 'internal';
  type: 'text' | 'attachment' | 'system';
  body: string | null;
  redacted: boolean;
  systemEvent: string | null;
  attachments: TranscriptAttachment[];
}

export interface TranscriptChat {
  id: string;
  number: number;
  site: { id: string; name: string };
  department: { id: string; name: string } | null;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  closeReason: string | null;
  participants: Array<{ role: 'visitor' | 'agent'; name: string }>;
  rating: { rating: string; comment: string | null; submittedAt: Date } | null;
  messages: TranscriptMessage[];
}

export interface TranscriptDoc {
  exportId: string | null;
  brand: string;
  generatedAt: Date;
  timezone: string;
  audience: TranscriptAudience;
  includeInternal: boolean;
  chats: TranscriptChat[];
}

export type RenderFormat = 'txt' | 'json' | 'csv' | 'pdf';

export const FORMAT_META: Record<RenderFormat, { mime: string; ext: string }> = {
  txt: { mime: 'text/plain', ext: 'txt' },
  json: { mime: 'application/json', ext: 'json' },
  csv: { mime: 'text/csv', ext: 'csv' },
  pdf: { mime: 'application/pdf', ext: 'pdf' },
};

// ───────────────────────── Time ─────────────────────────

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** RFC 3339 timestamp in the given IANA zone, with numeric offset (`Z` for UTC). */
export function rfc3339(d: Date, tz: string): string {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value])) as Record<string, string>;
  const y = Number(p.year);
  const mo = Number(p.month);
  const da = Number(p.day);
  const h = Number(p.hour) % 24;
  const mi = Number(p.minute);
  const s = Number(p.second);
  const wholeSecondUtc = Math.floor(d.getTime() / 1000) * 1000;
  const offsetMin = Math.round((Date.UTC(y, mo - 1, da, h, mi, s) - wholeSecondUtc) / 60_000);
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const ms = d.getTime() - wholeSecondUtc;
  const base = `${String(y).padStart(4, '0')}-${pad(mo)}-${pad(da)}T${pad(h)}:${pad(mi)}:${pad(s)}${ms ? `.${pad(ms, 3)}` : ''}`;
  if (offsetMin === 0) return `${base}Z`;
  return `${base}${offsetMin < 0 ? '-' : '+'}${pad(Math.trunc(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
}

// ───────────────────────── Shared text ─────────────────────────

export function redactionNotice(doc: Pick<TranscriptDoc, 'audience' | 'includeInternal'>): string {
  const scope =
    doc.audience === 'public'
      ? 'This transcript contains only the messages visible to the visitor.'
      : doc.includeInternal
        ? 'This staff export includes internal notes. Handle it as confidential.'
        : 'This staff export excludes internal notes.';
  return `${scope} Payment card numbers are masked, and removed or erased content is shown as [redacted]. File contents are not included; attachments are listed by name, size and type only.`;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function messageText(m: TranscriptMessage): string {
  if (m.redacted) return '[redacted]';
  return m.body ?? '';
}

function attachmentLine(a: TranscriptAttachment): string {
  return a.state === 'removed' ? '[attachment removed]' : `[attachment] ${a.name} (${humanSize(a.sizeBytes)}, ${a.mime}${a.state === 'clean' ? '' : `, ${a.state}`})`;
}

function senderLabel(m: TranscriptMessage): string {
  return `${m.sender.name}${m.visibility === 'internal' ? ' (internal note)' : ''}${m.type === 'system' ? ' (event)' : ''}`;
}

// ───────────────────────── TXT ─────────────────────────

export function renderTxt(doc: TranscriptDoc): Buffer {
  const L: string[] = [];
  L.push(`${doc.brand} chat transcript`);
  L.push(`Generated: ${rfc3339(doc.generatedAt, doc.timezone)} (${doc.timezone})`);
  if (doc.exportId) L.push(`Export: ${doc.exportId}`);
  L.push(`Notice: ${redactionNotice(doc)}`);
  for (const c of doc.chats) {
    L.push('', `=== Chat #${c.number} (${c.id}) ===`);
    L.push(`Site: ${c.site.name}`);
    L.push(`Department: ${c.department?.name ?? '—'}`);
    L.push(`Started: ${rfc3339(c.startedAt, doc.timezone)}`);
    L.push(`Ended: ${c.endedAt ? rfc3339(c.endedAt, doc.timezone) : '—'}${c.closeReason ? ` (${c.closeReason})` : ''}`);
    L.push(`Participants: ${c.participants.map((p) => `${p.name} (${p.role})`).join('; ') || '—'}`);
    if (c.rating) L.push(`Rating: ${c.rating.rating}${c.rating.comment ? ` — "${c.rating.comment.replace(/\r?\n/g, ' ')}"` : ''}`);
    L.push('');
    for (const m of c.messages) {
      const lines = messageText(m).split(/\r?\n/);
      L.push(`[${m.seq}] ${rfc3339(m.sentAt, doc.timezone)} ${senderLabel(m)}: ${lines[0] ?? ''}`);
      for (const extra of lines.slice(1)) L.push(`    ${extra}`);
      for (const a of m.attachments) L.push(`    ${attachmentLine(a)}`);
    }
  }
  L.push('');
  return Buffer.from(L.join('\n'), 'utf8');
}

// ───────────────────────── JSON ─────────────────────────

export function renderJson(doc: TranscriptDoc): Buffer {
  const t = (d: Date | null) => (d ? rfc3339(d, doc.timezone) : null);
  const out = {
    format: 'talkivio.transcript',
    version: 1,
    export_id: doc.exportId,
    generated_at: t(doc.generatedAt),
    timezone: doc.timezone,
    audience: doc.audience,
    include_internal: doc.includeInternal,
    redaction_notice: redactionNotice(doc),
    chats: doc.chats.map((c) => ({
      id: c.id,
      number: c.number,
      site: { id: c.site.id, name: c.site.name },
      department: c.department ? { id: c.department.id, name: c.department.name } : null,
      status: c.status,
      started_at: t(c.startedAt),
      ended_at: t(c.endedAt),
      close_reason: c.closeReason,
      participants: c.participants.map((p) => ({ role: p.role, name: p.name })),
      rating: c.rating ? { rating: c.rating.rating, comment: c.rating.comment, submitted_at: t(c.rating.submittedAt) } : null,
      messages: c.messages.map((m) => ({
        id: m.id,
        seq: m.seq,
        sent_at: t(m.sentAt),
        sender: { type: m.sender.type, name: m.sender.name },
        visibility: m.visibility,
        type: m.type,
        body: m.redacted ? null : m.body,
        redacted: m.redacted,
        system_event: m.systemEvent,
        attachments: m.attachments.map((a) => ({ id: a.id, name: a.name, size_bytes: a.sizeBytes, mime: a.mime, state: a.state })),
      })),
    })),
  };
  return Buffer.from(`${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

// ───────────────────────── CSV ─────────────────────────

/** Leading characters that make spreadsheet applications evaluate a cell (incl. full-width forms). */
const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

/** RFC 4180 field with spreadsheet formula-injection neutralisation for text cells. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  'chat_id',
  'chat_number',
  'site',
  'department',
  'chat_started_at',
  'message_id',
  'seq',
  'sent_at',
  'timezone',
  'sender_type',
  'sender_name',
  'visibility',
  'message_type',
  'body',
  'attachments',
  'redacted',
] as const;

export function renderCsv(doc: TranscriptDoc): Buffer {
  const rows: string[] = [CSV_COLUMNS.join(',')];
  for (const c of doc.chats) {
    for (const m of c.messages) {
      rows.push(
        [
          c.id,
          c.number,
          c.site.name,
          c.department?.name ?? '',
          rfc3339(c.startedAt, doc.timezone),
          m.id,
          m.seq,
          rfc3339(m.sentAt, doc.timezone),
          doc.timezone,
          m.sender.type,
          m.sender.name,
          m.visibility,
          m.type,
          m.redacted ? '[redacted]' : (m.body ?? ''),
          m.attachments.map(attachmentLine).join('; '),
          m.redacted ? 'true' : 'false',
        ]
          .map((v) => csvCell(v as string | number))
          .join(','),
      );
    }
  }
  return Buffer.from(`${rows.join('\r\n')}\r\n`, 'utf8');
}

// ───────────────────────── PDF ─────────────────────────

function fontPath(file: string): string {
  return require.resolve(`dejavu-fonts-ttf/ttf/${file}`);
}

/**
 * PDF via pdfkit with embedded local DejaVu fonts (Latin, Greek, Cyrillic, Arabic,
 * Hebrew …). Glyphs the font lacks (e.g. emoji, CJK) are replaced with U+FFFD.
 * Limitation: pdfkit applies OpenType shaping but no Unicode bidi reordering, so
 * right-to-left runs (Arabic/Hebrew) inside mixed lines are laid out left-to-right.
 */
export function renderPdf(doc: TranscriptDoc): Promise<Buffer> {
  return new Promise((resolvePdf, reject) => {
    const pdf = new PDFDocument({
      size: 'A4',
      margins: { top: 54, bottom: 54, left: 54, right: 54 },
      info: { Title: `${doc.brand} chat transcript`, Producer: doc.brand, Creator: doc.brand, CreationDate: doc.generatedAt },
      autoFirstPage: true,
      pdfVersion: '1.7',
    });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolvePdf(Buffer.concat(chunks)));
    pdf.on('error', reject);
    try {
      pdf.registerFont('body', fontPath('DejaVuSans.ttf'));
      pdf.registerFont('bold', fontPath('DejaVuSans-Bold.ttf'));
      pdf.font('body');
      const glyphs = (pdf as unknown as { _font?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } })._font?.font;
      const safe = (s: string) => {
        if (!glyphs?.hasGlyphForCodePoint) return s;
        let out = '';
        for (const ch of s) {
          const cp = ch.codePointAt(0)!;
          out += cp === 0x0a || cp === 0x09 || glyphs.hasGlyphForCodePoint(cp) ? ch : '�';
        }
        return out;
      };
      const grey = '#4C5D70';
      pdf.font('bold').fontSize(16).fillColor('#17222E').text(safe(`${doc.brand} chat transcript`));
      pdf.moveDown(0.3);
      pdf.font('body').fontSize(9).fillColor(grey).text(safe(`Generated ${rfc3339(doc.generatedAt, doc.timezone)} (${doc.timezone})${doc.exportId ? ` · Export ${doc.exportId}` : ''}`));
      pdf.moveDown(0.3).text(safe(redactionNotice(doc)));
      doc.chats.forEach((c, idx) => {
        if (idx > 0) pdf.addPage();
        else pdf.moveDown(1);
        pdf.font('bold').fontSize(13).fillColor('#17222E').text(safe(`Chat #${c.number}`));
        pdf.font('body').fontSize(9).fillColor(grey);
        const meta = [
          `Chat ID: ${c.id}`,
          `Site: ${c.site.name}`,
          `Department: ${c.department?.name ?? '—'}`,
          `Started: ${rfc3339(c.startedAt, doc.timezone)}`,
          `Ended: ${c.endedAt ? rfc3339(c.endedAt, doc.timezone) : '—'}${c.closeReason ? ` (${c.closeReason})` : ''}`,
          `Participants: ${c.participants.map((p) => `${p.name} (${p.role})`).join('; ') || '—'}`,
          ...(c.rating ? [`Rating: ${c.rating.rating}${c.rating.comment ? ` — “${c.rating.comment}”` : ''}`] : []),
        ];
        for (const line of meta) pdf.text(safe(line));
        pdf.moveDown(0.6);
        for (const m of c.messages) {
          pdf.font('bold').fontSize(9).fillColor(m.visibility === 'internal' ? '#8A5A00' : '#17222E').text(safe(`[${m.seq}] ${senderLabel(m)} · ${rfc3339(m.sentAt, doc.timezone)}`));
          const text = messageText(m);
          if (text) pdf.font('body').fontSize(10).fillColor('#17222E').text(safe(text), { lineGap: 1 });
          for (const a of m.attachments) pdf.font('body').fontSize(9).fillColor(grey).text(safe(attachmentLine(a)), { indent: 12 });
          pdf.moveDown(0.4);
        }
      });
      pdf.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}

export async function renderTranscript(doc: TranscriptDoc, format: RenderFormat): Promise<Buffer> {
  switch (format) {
    case 'txt':
      return renderTxt(doc);
    case 'json':
      return renderJson(doc);
    case 'csv':
      return renderCsv(doc);
    case 'pdf':
      return renderPdf(doc);
  }
}
