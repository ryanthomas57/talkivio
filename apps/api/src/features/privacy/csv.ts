/**
 * RFC 4180 CSV with spreadsheet formula neutralization (OWASP CSV injection):
 * cells beginning with = + - @ TAB or CR are prefixed with a single quote, every
 * field is quoted, embedded quotes doubled, records end with CRLF.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = '';
  else if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}
