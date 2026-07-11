import { describe, it, expect } from 'vitest';
import { neutralizeCsvFormula, escapeCsvValue, escapeCsvNumeric } from '../src/lib/csv.js';

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

  it('prefixes raw \\t-prefixed payload (Excel treats leading \\t as bypass)', () => {
    // A leading tab is itself a dangerous prefix — it must be neutralised, not
    // trimmed away before the check.
    expect(neutralizeCsvFormula('\tfoo')).toBe("'\tfoo");
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

  it('skips the formula guard for strictly numeric values (no caller opt-out needed)', () => {
    // A negative NUMERIC must export as "-12.34", not "'-12.34" — otherwise our
    // own importer NaN-drops it on a round-trip. A pure number can't be a
    // formula, so the guard self-disables instead of relying on a per-column flag.
    expect(escapeCsvValue('-12.34')).toBe('-12.34');
    expect(escapeCsvValue(-12.34)).toBe('-12.34');
    expect(escapeCsvValue('1234')).toBe('1234');
  });

  it('still guards number-like-but-not-numeric payloads', () => {
    // "-12+34" is a real formula; "-12,34" (EU decimal) is not strict numeric
    // and gets the guard + quoting — conservative but safe.
    expect(escapeCsvValue('-12+34')).toBe("'-12+34");
    expect(escapeCsvValue('-1E2+3')).toBe("'-1E2+3");
    expect(escapeCsvValue('+123')).toBe("'+123");
  });
});

describe('escapeCsvNumeric', () => {
  it('does NOT formula-guard a negative amount (leading "-" is a real minus)', () => {
    // Guarding it would export "'-12.34", which NaN-drops the row on re-import.
    expect(escapeCsvNumeric('-12.34')).toBe('-12.34');
    expect(escapeCsvNumeric('-1000')).toBe('-1000');
  });

  it('passes positive/zero numbers through untouched', () => {
    expect(escapeCsvNumeric('45.20')).toBe('45.20');
    expect(escapeCsvNumeric(0)).toBe('0');
  });

  it('returns empty string for null/undefined (e.g. a missing balance)', () => {
    expect(escapeCsvNumeric(null)).toBe('');
    expect(escapeCsvNumeric(undefined)).toBe('');
  });
});
