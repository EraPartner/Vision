import { describe, it, expect } from 'vitest';
import { neutralizeCsvFormula, escapeCsvValue } from '../src/lib/csv.js';

describe('neutralizeCsvFormula', () => {
  it('prefixes leading =, +, -, @', () => {
    expect(neutralizeCsvFormula('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(neutralizeCsvFormula('+1+1')).toBe("'+1+1");
    expect(neutralizeCsvFormula('-2')).toBe("'-2");
    expect(neutralizeCsvFormula('@cmd')).toBe("'@cmd");
  });

  it('prefixes leading tab + formula bypass', () => {
    expect(neutralizeCsvFormula('\t=SUM(A1)')).toBe("'\t=SUM(A1)");
  });

  it('prefixes leading carriage return + formula bypass', () => {
    expect(neutralizeCsvFormula('\r=cmd')).toBe("'\r=cmd");
  });

  it('prefixes raw \\t-only payload (Excel treats leading \\t as bypass)', () => {
    expect(neutralizeCsvFormula('\tfoo')).toBe('\tfoo');
  });

  it('leaves benign strings untouched', () => {
    expect(neutralizeCsvFormula('hello')).toBe('hello');
    expect(neutralizeCsvFormula('  hello  ')).toBe('  hello  ');
    expect(neutralizeCsvFormula('')).toBe('');
    expect(neutralizeCsvFormula(null)).toBe(null);
  });

  it('handles NBSP-padded payloads', () => {
    expect(neutralizeCsvFormula('\u00a0=SUM(1)')).toBe("'\u00a0=SUM(1)");
  });
});

describe('escapeCsvValue', () => {
  it('quotes values containing comma, quote, or newline', () => {
    expect(escapeCsvValue('a,b')).toBe('"a,b"');
    expect(escapeCsvValue('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCsvValue('line1\nline2')).toBe('"line1\nline2"');
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
  });

  it('combines neutralization with quoting', () => {
    expect(escapeCsvValue('=SUM(A1,B1)')).toBe('"\'=SUM(A1,B1)"');
  });
});
