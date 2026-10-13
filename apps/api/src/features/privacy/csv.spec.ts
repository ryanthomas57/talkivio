import { describe, expect, it } from 'vitest';
import { safeDiffOut } from './audit-events.service';
import { csvCell, csvRow } from './csv';
import { loadPrivacyConfig } from './config';

describe('audit CSV', () => {
  it('quotes every field, doubles quotes and ends rows with CRLF (RFC 4180)', () => {
    expect(csvRow(['a', 'b"c', 'd,e', 'line\nbreak'])).toBe('"a","b""c","d,e","line\nbreak"\r\n');
  });

  it('neutralizes spreadsheet formulas', () => {
    for (const v of ['=HYPERLINK("http://x")', '+1', '-2+3', '@SUM(A1)', '\tx', '\rx'])
      expect(csvCell(v).startsWith(`"'`)).toBe(true);
    expect(csvCell('webhook.created')).toBe('"webhook.created"');
  });

  it('serializes dates, objects and nulls', () => {
    expect(csvCell(new Date('2026-10-12T00:00:00Z'))).toBe('"2026-10-12T00:00:00.000Z"');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe('""');
  });
});

describe('audit safe diff output', () => {
  it('re-redacts sensitive keys from legacy rows', () => {
    expect(safeDiffOut({ email: 'a@b.c', name: 'x', nested: { token: 'rdt_x' } })).toEqual({
      email: '[changed]',
      name: 'x',
      nested: { token: '[changed]' },
    });
  });
});

describe('privacy config', () => {
  it('defaults favour minimum data', () => {
    const c = loadPrivacyConfig({});
    expect(c.transcriptPolicy).toBe('subject_chats');
    expect(c.accessExportIncludeNotes).toBe(false);
    expect(c.exportTtlDays).toBe(7);
    expect(loadPrivacyConfig({ TALKIVIO_PRIVACY_EXPORT_TTL_DAYS: '999' }).exportTtlDays).toBe(30);
  });
});
