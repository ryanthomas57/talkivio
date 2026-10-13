import { describe, expect, it } from 'vitest';
import { neutralizeCell, parseCsv, toCsv, unneutralizeCell } from './csv';
import { parsePlaceholders, renderPlaceholders } from './placeholders';

describe('canned reply placeholders (SHORT01)', () => {
  it('accepts only allowlisted keys', () => {
    expect(parsePlaceholders('Hi {{visitor.name}}, I am {{ agent.display_name }}').errors).toEqual([]);
    expect(parsePlaceholders('Hi {{visitor.email}}').errors.length).toBe(1);
    expect(parsePlaceholders('{{constructor.prototype}}').errors.length).toBe(1);
    expect(parsePlaceholders('Hi {{visitor.name').errors.length).toBe(1);
  });

  it('uses fallbacks and reports unresolved tokens', () => {
    const r = renderPlaceholders('Hi {{visitor.name|there}} from {{department.name}} at {{site.name}}', { 'site.name': 'Acme' });
    expect(r.text).toBe('Hi there from {{department.name}} at Acme');
    expect(r.unresolved).toEqual(['department.name']);
  });

  it('is single-pass plain text: values are never re-expanded, HTML stays literal', () => {
    const r = renderPlaceholders('Hello {{visitor.name}}!', { 'visitor.name': '<b>{{agent.display_name}}</b>\n' });
    expect(r.text).toBe('Hello <b>{{agent.display_name}}</b>!');
    expect(r.unresolved).toEqual([]);
  });
});

describe('RFC 4180 CSV', () => {
  it('round-trips quotes, commas, newlines and neutralized formulas', () => {
    const rows = [
      ['slug', 'title', 'body'],
      ['refund', 'Refund, "fast"', 'Line 1\r\nLine 2'],
      ['calc', '=SUM(A1)', '@cmd'],
    ];
    const text = toCsv(rows);
    expect(text).toContain("'=SUM(A1)"); // neutralized cell
    const parsed = parseCsv(text);
    expect(parsed.error).toBeNull();
    expect(parsed.rows.map((r) => r.map(unneutralizeCell))).toEqual(rows);
  });

  it('neutralizes every formula prefix', () => {
    for (const p of ['=', '+', '-', '@', '\t', '\r']) expect(neutralizeCell(`${p}x`).startsWith("'")).toBe(true);
    expect(neutralizeCell('plain')).toBe('plain');
  });

  it('reports malformed input', () => {
    expect(parseCsv('a,"b\n').error).toMatch(/Unterminated/);
    expect(parseCsv('a,b"c\n').error).toMatch(/quote/);
  });
});
