/**
 * SABB Bank Adapter Tests
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAdapter } from '../src/services/bankAdapters.js';

function writeTempCSV(content) {
  const tmpPath = path.join(os.tmpdir(), `test_sabb_${Date.now()}.csv`);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  return tmpPath;
}

describe('SABBAdapter', () => {
  let tmpPath;
  const parse = createAdapter('sabb');

  afterEach(() => {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  it('parses valid date and amount from Amount(SAR) style values', () => {
    const csv = `Transaction date,Amount(SAR),Description,Status,Posting date,Amount(Other Currency)
25 Feb 2026,-153.01 SAR,1234567890123456Starbucks Riyadh,BOOKED,26 Feb 2026,
`;

    tmpPath = writeTempCSV(csv);
    const txns = parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].date.getFullYear()).toBe(2026);
    expect(txns[0].date.getMonth()).toBe(1);
    expect(txns[0].date.getDate()).toBe(25);
    expect(txns[0].amount).toBe(-153.01);
    expect(txns[0].currency).toBe('SAR');
  });

  it('strips 16-digit card prefix and uses UNKNOWN recipient when description empty', () => {
    const csv = `Transaction date,Amount(SAR),Description,Status,Posting date,Amount(Other Currency)
26 Feb 2026,-20.00 SAR,1234567890123456Amazon Marketplace,POSTED,27 Feb 2026,
27 Feb 2026,-5.00 SAR,,POSTED,28 Feb 2026,
`;

    tmpPath = writeTempCSV(csv);
    const txns = parse(tmpPath);

    expect(txns).toHaveLength(2);
    expect(txns[0].recipient).toBe('AMAZON MARKETPLACE');
    expect(txns[0].memo).toBe('1234567890123456AMAZON MARKETPLACE');
    expect(txns[1].recipient).toBe('UNKNOWN');
    expect(txns[1].memo).toBe('');
  });

  it('builds comment when status posting date and other currency are present', () => {
    const csv = `Transaction date,Amount(SAR),Description,Status,Posting date,Amount(Other Currency)
28 Feb 2026,-100.00 SAR,1234567890123456Hotel Booking,SETTLED,01 Mar 2026,-26.67 USD
`;

    tmpPath = writeTempCSV(csv);
    const txns = parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].comment).toContain('Status: SETTLED');
    expect(txns[0].comment).toContain('Posting Date: 01 Mar 2026');
    expect(txns[0].comment).toContain('Other Currency: -26.67 USD');
  });

  it('returns null comment when optional comment fields are absent', () => {
    const csv = `Transaction date,Amount(SAR),Description,Status,Posting date,Amount(Other Currency)
01 Mar 2026,-10.00 SAR,Cafe,
`;

    tmpPath = writeTempCSV(csv);
    const txns = parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].comment).toBeNull();
  });

  it('extracts currency code and falls back to SAR when missing 3-letter code', () => {
    const csv = `Transaction date,Amount(SAR),Description,Status,Posting date,Amount(Other Currency)
02 Mar 2026,-44.10 USD,1234567890123456Online Store,BOOKED,03 Mar 2026,
03 Mar 2026,-33.00,1234567890123456Local Store,BOOKED,04 Mar 2026,
`;

    tmpPath = writeTempCSV(csv);
    const txns = parse(tmpPath);

    expect(txns).toHaveLength(2);
    expect(txns[0].currency).toBe('USD');
    expect(txns[1].currency).toBe('SAR');
  });

  it('skips malformed date and malformed amount rows', () => {
    const csv = `Transaction date,Amount(SAR),Description,Status,Posting date,Amount(Other Currency)
INVALID_DATE,-10.00 SAR,1234567890123456Skip Date,BOOKED,04 Mar 2026,
04 Mar 2026,INVALID,1234567890123456Skip Amount,BOOKED,05 Mar 2026,
05 Mar 2026,-9.50 SAR,1234567890123456Valid Merchant,BOOKED,06 Mar 2026,
`;

    tmpPath = writeTempCSV(csv);
    const txns = parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].recipient).toBe('VALID MERCHANT');
    expect(txns[0].amount).toBe(-9.5);
  });
});
