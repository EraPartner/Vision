import { describe, it, expect } from 'vitest';
import { splitCsvLines, parseCommaDecimal } from '../src/services/importPipeline/adapters/_shared.js';

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
