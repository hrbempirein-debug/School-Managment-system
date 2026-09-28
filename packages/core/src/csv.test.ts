import { describe, expect, it } from 'vitest';
import { csvFormulaSafe, parseCsv, serializeCsv } from './csv.js';

describe('parseCsv', () => {
  it('parses simple unquoted rows', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles CRLF and lone-CR line endings', () => {
    expect(parseCsv('a,b\r\nc,d\r\ne,f')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    expect(parseCsv('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps quoted fields with embedded commas/newlines and "" escapes', () => {
    const rows = parseCsv('name,note\n"Doe, John","line1\nline2 ""quoted"""\n');
    expect(rows).toEqual([
      ['name', 'note'],
      ['Doe, John', 'line1\nline2 "quoted"'],
    ]);
  });

  it('strips a leading BOM from the first field', () => {
    expect(parseCsv('\uFEFFa,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('tolerates trailing unclosed quotes without losing the field content', () => {
    expect(parseCsv('x,y\n"unclosed\n')).toEqual([
      ['x', 'y'],
      ['unclosed\n'],
    ]);
  });

  it('preserves empty cells and skips fully blank lines', () => {
    expect(parseCsv('a,,c\n\n,,x\n')).toEqual([
      ['a', '', 'c'],
      ['', '', 'x'],
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('serializeCsv', () => {
  it('writes plain rows with CRLF endings and trailing newline', () => {
    expect(serializeCsv([['a', 'b'], ['1', '2']])).toBe('a,b\r\n1,2\r\n');
  });

  it('quotes fields containing commas, quotes or newlines', () => {
    expect(serializeCsv([['a,b', 'say "hi"', 'x\ny']])).toBe('"a,b","say ""hi""","x\ny"\r\n');
  });

  it('round-trips through parseCsv', () => {
    const rows: string[][] = [
      ['student_no', 'first', 'note'],
      ['S001', 'Ada', 'value with, comma'],
      ['S002', 'Grace', 'line\nbreak and "quote"'],
    ];
    expect(parseCsv(serializeCsv(rows))).toEqual(rows);
  });
});

describe('csvFormulaSafe', () => {
  it.each(['=cmd', '+1', '-1', '@x', '=1+1'])('neutralizes %s', (value) => {
    expect(csvFormulaSafe(value)).toBe(`'${value}`);
  });

  it('neutralizes formula triggers even after leading whitespace', () => {
    expect(csvFormulaSafe('   =SUM(A1:A2)')).toBe(`'   =SUM(A1:A2)`);
    expect(csvFormulaSafe('\t-1')).toBe(`'\t-1`);
  });

  it.each(['plain', '1,000', '', 'Marco "safe"', "'=already-neutral", '\tcut listed'])(
    'passes through benign values unchanged (%s)',
    (value) => {
      expect(csvFormulaSafe(value)).toBe(value);
    },
  );
});