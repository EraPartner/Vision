import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { splitCsvLines, splitDelimitedRecord, parseCommaDecimal, parseDateWithFormat, readTextWithEncodingFallback } from '../src/services/importPipeline/adapters/_shared.js';

describe('splitDelimitedRecord', () => {
  it('splits a plain semicolon record', () => {
    expect(splitDelimitedRecord('a;b;c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps a quoted delimiter inside one field (the naive split(";") bug)', () => {
    expect(splitDelimitedRecord('1;"Factuur 123; klant 456";2,50')).toEqual([
      '1',
      'Factuur 123; klant 456',
      '2,50',
    ]);
  });

  it('unescapes doubled quotes and drops the wrapping quotes', () => {
    expect(splitDelimitedRecord('x;"he said ""hi""";y')).toEqual(['x', 'he said "hi"', 'y']);
  });

  it('keeps empty fields', () => {
    expect(splitDelimitedRecord('a;;c;')).toEqual(['a', '', 'c', '']);
  });

  it('tolerates a stray quote mid-field (relax_quotes)', () => {
    const parts = splitDelimitedRecord('a;5" screw;c');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('a');
    expect(parts[2]).toBe('c');
  });
});

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

describe('readTextWithEncodingFallback', () => {
  const files = [];
  afterEach(() => {
    while (files.length) {
      const p = files.pop();
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });
  const writeBytes = (buffer) => {
    const p = path.join(os.tmpdir(), `test_encfallback_${Date.now()}_${files.length}.csv`);
    fs.writeFileSync(p, buffer);
    files.push(p);
    return p;
  };

  it('decodes a latin1 (windows-1252) file with é (byte 0xE9) instead of corrupting it', async () => {
    // "Sofié" where é is the single latin1 byte 0xE9 — decoded as UTF-8 this
    // byte is invalid and becomes U+FFFD, corrupting the recipient name.
    const buffer = Buffer.concat([Buffer.from('Naam;Sofi', 'latin1'), Buffer.from([0xe9])]);
    const content = await readTextWithEncodingFallback(writeBytes(buffer));
    expect(content).toContain('Sofié');
    expect(content).not.toContain('\uFFFD');
  });

  it('decodes a valid UTF-8 file (multi-byte é) unchanged', async () => {
    const buffer = Buffer.from('Naam;Sofié', 'utf-8');
    const content = await readTextWithEncodingFallback(writeBytes(buffer));
    expect(content).toBe('Naam;Sofié');
  });
});
