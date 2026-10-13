/**
 * RFC 4180 CSV writer with spreadsheet formula neutralization (ch. 51/52):
 * CRLF line endings, fields with comma/quote/CR/LF are quoted with doubled
 * quotes, and text cells beginning with = + - @ TAB or CR are prefixed with an
 * apostrophe so spreadsheet software never evaluates them. Finite numbers are
 * written as numbers (a negative number is data, not a formula).
 */

export type Cell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralize(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = neutralize(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly Cell[]>): string {
  const lines = [header.map((h) => csvCell(h)).join(',')];
  for (const r of rows) {
    if (r.length !== header.length) throw new Error(`CSV row has ${r.length} fields, header has ${header.length}`);
    lines.push(r.map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Minimal RFC 4180 parser (used by tests and export verification). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
