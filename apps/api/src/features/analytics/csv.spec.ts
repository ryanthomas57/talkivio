import { describe, expect, it } from 'vitest';
import { csvCell, neutralize, parseCsv, toCsv } from './csv';

describe('RFC 4180 CSV with formula neutralization', () => {
  it('neutralizes formula-looking text but not numbers', () => {
    expect(neutralize('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(neutralize('+1 555')).toBe("'+1 555");
    expect(neutralize('-2')).toBe("'-2");
    expect(neutralize('@cmd')).toBe("'@cmd");
    expect(neutralize('\tTab')).toBe("'\tTab");
    expect(neutralize('Alice')).toBe('Alice');
    expect(csvCell(-2.5)).toBe('-2.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('quotes separators, quotes and line breaks; lines end with CRLF', () => {
    const csv = toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', '=1+1']]);
    expect(csv).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\'=1+1\r\n');
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['x,y', 'say "hi"'],
      ['line\nbreak', "'=1+1"],
    ]);
  });

  it('rejects ragged rows', () => {
    expect(() => toCsv(['a', 'b'], [['only one']])).toThrow();
  });
});
