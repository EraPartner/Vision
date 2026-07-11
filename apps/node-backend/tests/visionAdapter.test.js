/**
 * Vision Bank Adapter Tests
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAdapter } from '../src/services/bankAdapters.js';

function writeTempCSV(content) {
  const tmpPath = path.join(os.tmpdir(), `test_vision_${Date.now()}.csv`);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  return tmpPath;
}

describe('VisionAdapter', () => {
  let tmpPath;
  const parse = createAdapter('vision');

  afterEach(() => {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  });

  it('parses valid rows and skips invalid date or amount rows', async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-01,Main Account,John Doe,Dinner,-45.20,EUR,954.80,FOOD,Shared meal
INVALID_DATE,Main Account,Skip Date,Note,-10.00,EUR,944.80,OTHER,invalid date
2026-03-02,Main Account,Skip Amount,Note,INVALID,EUR,944.80,OTHER,invalid amount
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].recipient).toBe('JOHN DOE');
    expect(txns[0].amount).toBe(-45.2);
  });

  it("re-imports guard-quoted negative amounts and balances (export round-trip)", async () => {
    // Older exports ran numeric cells through the CSV formula-injection guard,
    // which prepended "'" to negatives. The adapter must strip it so the
    // expense row is not NaN-dropped and the balance not silently nulled.
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-01,Main Account,John Doe,Dinner,'-45.20,EUR,'-12.00,FOOD,Shared meal
`;
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(-45.2);
    expect(txns[0].balance).toBe(-12);
  });

  it('uses UNKNOWN recipient when recipient is empty', async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-03,Main Account,,transfer,25.00,EUR,979.80,INCOME,
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].recipient).toBe('UNKNOWN');
  });

  it('defaults bank account to VISION and currency to EUR', async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-04,,Acme Corp,salary,1000.00,,1979.80,INCOME,
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].bankAccount).toBe('VISION');
    expect(txns[0].currency).toBe('EUR');
  });

  it('builds comment from imported category and existing comment', async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-05,Personal,Electric Company,bill,-120.00,EUR,1859.80,UTILITIES,Paid by direct debit
2026-03-06,Personal,No Comment,none,-5.00,EUR,1854.80,,
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(2);
    expect(txns[0].comment).toBe('Imported Category: UTILITIES | Paid by direct debit');
    expect(txns[1].comment).toBeNull();
  });

  it('normalizes memo to uppercase', async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-07,Personal,Some Recipient,mixEd Case Memo,-1.25,EUR,1853.55,MISC,
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].memo).toBe('MIXED CASE MEMO');
  });
});
