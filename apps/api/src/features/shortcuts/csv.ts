/**
 * RFC 4180 CSV for canned-reply import/export. Export neutralizes spreadsheet
 * formula injection (cells starting with = + - @ TAB CR are prefixed with an
 * apostrophe); import reverses exactly that prefix so exports round-trip.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralizeCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function unneutralizeCell(value: string): string {
  return value.length > 1 && value[0] === "'" && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize rows with CRLF record separators and formula-injection neutralization. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return rows.map((r) => r.map((c) => quote(neutralizeCell(c))).join(',')).join('\r\n') + '\r\n';
}

export interface CsvParseResult {
  rows: string[][];
  error: string | null;
}

/**
 * Parse RFC 4180 text (quoted fields may contain commas, quotes and line breaks).
 * Accepts CRLF or LF and an optional UTF-8 BOM. Stops after `maxRows` records.
 */
export function parseCsv(text: string, maxRows = 10_000): CsvParseResult {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        if (i < src.length && src[i] !== ',' && src[i] !== '\r' && src[i] !== '\n') {
          return { rows, error: `Line ${rows.length + 1}: unexpected character after closing quote` };
        }
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && !fieldStarted && field === '') {
      quoted = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (ch === ',') {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), error: `Too many rows (maximum ${maxRows - 1} data rows)` };
      continue;
    }
    if (ch === '"') return { rows, error: `Line ${rows.length + 1}: quote inside an unquoted field` };
    field += ch;
    fieldStarted = true;
    i++;
  }
  if (quoted) return { rows, error: 'Unterminated quoted field' };
  if (field !== '' || row.length) endRow();
  if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), error: `Too many rows (maximum ${maxRows - 1} data rows)` };
  return { rows, error: null };
}
