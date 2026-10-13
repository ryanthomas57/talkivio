import { describe, expect, it } from 'vitest';
import { csvCell, renderCsv, renderJson, renderPdf, renderTxt, rfc3339, type TranscriptDoc } from './transcript.render';

const doc: TranscriptDoc = {
  exportId: '7d3f6d1e-0000-4000-8000-000000000001',
  brand: 'Talkivio',
  generatedAt: new Date('2026-10-12T08:00:00.000Z'),
  timezone: 'Europe/London',
  audience: 'public',
  includeInternal: false,
  chats: [
    {
      id: 'c0ffee00-0000-4000-8000-000000000002',
      number: 7,
      site: { id: 's1', name: 'Demo store' },
      department: { id: 'd1', name: 'Support' },
      status: 'closed',
      startedAt: new Date('2026-10-12T07:59:00.000Z'),
      endedAt: new Date('2026-10-12T08:10:00.000Z'),
      closeReason: 'ended',
      participants: [
        { role: 'visitor', name: 'Ana' },
        { role: 'agent', name: 'Bea' },
      ],
      rating: { rating: 'good', comment: 'Great, "thanks"', submittedAt: new Date('2026-10-12T08:11:00.000Z') },
      messages: [
        { id: 'm1', seq: 1, sentAt: new Date('2026-10-12T08:00:01.250Z'), sender: { type: 'visitor', name: 'Ana' }, visibility: 'public', type: 'text', body: '=HYPERLINK("http://evil")', redacted: false, systemEvent: null, attachments: [] },
        { id: 'm3', seq: 3, sentAt: new Date('2026-10-12T08:00:05.000Z'), sender: { type: 'agent', name: 'Bea' }, visibility: 'public', type: 'text', body: 'مرحبا 👋\nline two, with comma', redacted: false, systemEvent: null, attachments: [{ id: 'a1', name: '@invoice.pdf', sizeBytes: 2048, mime: 'application/pdf', state: 'clean' }] },
        { id: 'm4', seq: 4, sentAt: new Date('2026-10-12T08:00:06.000Z'), sender: { type: 'visitor', name: 'Ana' }, visibility: 'public', type: 'text', body: null, redacted: true, systemEvent: null, attachments: [] },
      ],
    },
  ],
};

describe('rfc3339', () => {
  it('formats with the zone offset', () => {
    expect(rfc3339(new Date('2026-10-12T08:00:01.250Z'), 'Europe/London')).toBe('2026-10-12T09:00:01.250+01:00');
    expect(rfc3339(new Date('2026-01-12T08:00:00Z'), 'Europe/London')).toBe('2026-01-12T08:00:00Z');
    expect(rfc3339(new Date('2026-10-12T08:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-12T13:30:00+05:30');
    expect(rfc3339(new Date('2026-10-12T08:00:00Z'), 'America/New_York')).toBe('2026-10-12T04:00:00-04:00');
  });
});

describe('csv', () => {
  it('neutralises formula-leading cells and quotes per RFC 4180', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell(42)).toBe('42');
  });

  it('renders ordered rows with CRLF and neutralised content', () => {
    const csv = renderCsv(doc).toString('utf8');
    const lines = csv.split('\r\n');
    expect(lines[0]).toMatch(/^chat_id,chat_number,site/);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain("'[attachment] @invoice.pdf".slice(1));
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('json/txt/pdf', () => {
  it('keeps exact ids and Unicode in JSON', () => {
    const j = JSON.parse(renderJson(doc).toString('utf8'));
    expect(j.chats[0].id).toBe(doc.chats[0]!.id);
    expect(j.chats[0].messages.map((m: { seq: number }) => m.seq)).toEqual([1, 3, 4]);
    expect(j.chats[0].messages[1].body).toBe('مرحبا 👋\nline two, with comma');
    expect(j.chats[0].messages[0].sent_at).toBe('2026-10-12T09:00:01.250+01:00');
    expect(j.chats[0].messages[2]).toMatchObject({ body: null, redacted: true });
  });

  it('renders TXT with redaction notice and placeholders', () => {
    const t = renderTxt(doc).toString('utf8');
    expect(t).toContain('Chat #7 (c0ffee00-0000-4000-8000-000000000002)');
    expect(t).toContain('[4] 2026-10-12T09:00:06+01:00 Ana: [redacted]');
    expect(t).toContain('[attachment] @invoice.pdf (2.0 KB, application/pdf)');
    expect(t).toMatch(/Notice: This transcript contains only the messages visible to the visitor/);
  });

  it('renders a PDF without remote resources', async () => {
    const pdf = await renderPdf(doc);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).not.toMatch(/\/URI|\/JavaScript|\/Launch/);
  });
});
