import { describe, it, expect } from 'vitest';
import { splitCsvLines } from '../src/services/importPipeline/adapters/_shared.js';

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
