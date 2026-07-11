import { describe, it, expect } from 'vitest';
import { splitCsvLines, parseCommaDecimal, parseDateWithFormat } from '../src/services/importPipeline/adapters/_shared.js';

describe('parseDateWithFormat round-trip validation', () => {
  it('parses a valid date for the chosen format', () => {
    expect(parseDateWithFormat('25/12/2024', '%d/%m/%Y')?.toISOString()).toBe('2024-12-25T00:00:00.000Z');
  });

  it('rejects a MM/DD value parsed as %d/%m/%Y instead of silently rolling over', () => {
    // "12/25/2024" as %d/%m/%Y → day 12, month 25 → Date.UTC would roll to 2026.
    expect(parseDateWithFormat('12/25/2024', '%d/%m/%Y')).toBeNull();
  });

  it('rejects a 2-digit year (would misparse as 19xx)', () => {
    expect(parseDateWithFormat('01/02/24', '%d/%m/%Y')).toBeNull();
  });

  it('rejects an impossible day', () => {
    expect(parseDateWithFormat('31/02/2024', '%d/%m/%Y')).toBeNull();
  });

  it('validates the %m/%d/%Y and ISO branches too', () => {
    expect(parseDateWithFormat('12/25/2024', '%m/%d/%Y')?.toISOString()).toBe('2024-12-25T00:00:00.000Z');
    expect(parseDateWithFormat('25/12/2024', '%m/%d/%Y')).toBeNull();
    expect(parseDateWithFormat('2024-12-25', '%Y-%m-%d')?.toISOString()).toBe('2024-12-25T00:00:00.000Z');
    expect(parseDateWithFormat('2024-13-25', '%Y-%m-%d')).toBeNull();
  });
});

describe('parseCommaDecimal', () => {
  it('parses EU dot-thousands + comma-decimal (was NaN → row silently dropped)', () => {
    expect(parseCommaDecimal('1.234,56')).toBe(1234.56);
    expect(parseCommaDecimal('1.234.567,89')).toBe(1234567.89);
  });

  it('parses a plain comma decimal', () => {
    expect(parseCommaDecimal('12,5')).toBe(12.5);
  });

  it('leaves a dot-decimal without a comma untouched', () => {
    expect(parseCommaDecimal('12.5')).toBe(12.5);
  });
});

describe('splitCsvLines', () => {
  it('splits LF-terminated content', () => {
    expect(splitCsvLines('a,b,c\n1,2,3')).toEqual(['a,b,c', '1,2,3']);
  });

  it('splits CRLF-terminated content (Windows)', () => {
    expect(splitCsvLines('a,b,c\r\n1,2,3')).toEqual(['a,b,c', '1,2,3']);
  });

  it('splits CR-terminated content (legacy Mac)', () => {
    expect(splitCsvLines('a,b,c\r1,2,3')).toEqual(['a,b,c', '1,2,3']);
  });

  it('strips a UTF-8 BOM from the start of the content (Excel export)', () => {
    expect(splitCsvLines('﻿a,b,c\n1,2,3')).toEqual(['a,b,c', '1,2,3']);
  });

  it('only strips a leading BOM, not BOMs inside the body', () => {
    expect(splitCsvLines('a,b,c\n﻿1,2,3')).toEqual(['a,b,c', '﻿1,2,3']);
  });

  it('handles non-string input by coercing it', () => {
    expect(splitCsvLines(null)).toEqual(['null']);
  });
});
