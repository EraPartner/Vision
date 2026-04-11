/**
 * Import service tests.
 * Mirrors: apps/backend/tests/test_import.py
 *
 * Tests import orchestration logic with mocked database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/services/bankAdapters.js', () => ({
  createAdapter: vi.fn(),
}));

vi.mock('../src/services/deduplication.js', () => ({
  isDuplicateByFields: vi.fn(),
}));

vi.mock('../src/services/textNormalization.js', () => ({
  normalizeForMatching: vi.fn((value) => String(value || '').toUpperCase().trim()),
}));

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createAdapter } from '../src/services/bankAdapters.js';
import { isDuplicateByFields } from '../src/services/deduplication.js';
import { normalizeForMatching } from '../src/services/textNormalization.js';
import { importCSV } from '../src/services/importService.js';
import { query } from '../src/database/connection.js';

function makeTx(overrides = {}) {
  return {
    date: new Date('2026-02-15T00:00:00.000Z'),
    amount: -12.5,
    recipient: 'Coffee Shop',
    recipientAccount: 'BE1000',
    recipientAddress: 'Main Street',
    recipientBankName: 'Revolut',
    bankAccount: 'BE0001',
    memo: 'latte',
    currency: 'EUR',
    balance: 100,
    comment: '',
    ...overrides,
  };
}

describe('Import Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    normalizeForMatching.mockImplementation((value) => String(value || '').toUpperCase().trim());
  });

  it('should return error result for unsupported bank', async () => {
    createAdapter.mockImplementation(() => {
      throw new Error('No configuration found for bank');
    });

    const result = await importCSV('/tmp/test.csv', 'UnknownBank');

    expect(result.total_processed).toBe(0);
    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('should import non-duplicate transactions and resolve existing recipients', async () => {
    const txRows = [
      makeTx({ recipient: 'Coffee Shop', amount: -12.5 }),
      makeTx({ recipient: 'Existing Shop', amount: -33.0, memo: 'groceries' }),
      makeTx({ recipient: 'New Vendor', amount: -40.0, memo: 'bill payment' }),
    ];

    createAdapter.mockReturnValue(() => txRows);
    isDuplicateByFields.mockResolvedValue(false);

    const recipients = new Map([['EXISTING SHOP', 7]]);
    let nextRecipientId = 20;

    query.mockImplementation(async (sql, params = []) => {
      if (typeof sql !== 'string') return { rows: [] };

      if (sql.includes('INSERT INTO recipients')) {
        const normalizedName = params[1];
        if (normalizedName === 'EXISTING SHOP') {
          return { rows: [] };
        }

        const createdId = recipients.get(normalizedName) || (nextRecipientId += 1);
        recipients.set(normalizedName, createdId);
        return { rows: [{ id: createdId }] };
      }

      if (sql.includes('SELECT id FROM recipients WHERE normalized_name = $1')) {
        const existingId = recipients.get(params[0]);
        return { rows: existingId ? [{ id: existingId }] : [] };
      }

      if (sql.includes('INSERT INTO recipient_bank_accounts')) {
        return { rows: [] };
      }

      if (sql.includes('UPDATE recipients SET notes = $1')) {
        return { rows: [] };
      }

      if (sql.includes('INSERT INTO transactions')) {
        return { rows: [], rowCount: 3 };
      }

      return { rows: [] };
    });

    const result = await importCSV('/tmp/test.csv', 'revolut');

    expect(result).toEqual({
      total_processed: 3,
      imported: 3,
      duplicates: 0,
      errors: 0,
    });

    expect(isDuplicateByFields).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('SELECT id FROM recipients WHERE normalized_name = $1'))).toBe(true);

    const txInsertCall = query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO transactions')
    );
    expect(txInsertCall).toBeTruthy();
    expect(txInsertCall[1]).toHaveLength(24);
  });

  it('should increment duplicates when deduplication matches', async () => {
    const txRows = [
      makeTx({ amount: -10, recipient: 'Duplicate Vendor' }),
      makeTx({ amount: -20, recipient: 'Unique Vendor' }),
    ];

    createAdapter.mockReturnValue(() => txRows);
    isDuplicateByFields.mockImplementation(async (_date, amount) => amount === -10);

    query.mockImplementation(async (sql) => {
      if (typeof sql !== 'string') return { rows: [] };
      if (sql.includes('INSERT INTO recipients')) return { rows: [{ id: 1 }] };
      if (sql.includes('INSERT INTO transactions')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO recipient_bank_accounts')) return { rows: [] };
      if (sql.includes('UPDATE recipients SET notes = $1')) return { rows: [] };
      return { rows: [] };
    });

    const result = await importCSV('/tmp/test.csv', 'revolut');

    expect(result.total_processed).toBe(2);
    expect(result.imported).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('should count failed batch inserts as errors', async () => {
    const txRows = [
      makeTx({ recipient: 'Vendor A' }),
      makeTx({ recipient: 'Vendor B', amount: -30 }),
    ];

    createAdapter.mockReturnValue(() => txRows);
    isDuplicateByFields.mockResolvedValue(false);

    query.mockImplementation(async (sql) => {
      if (typeof sql !== 'string') return { rows: [] };
      if (sql.includes('INSERT INTO recipients')) return { rows: [{ id: 1 }] };
      if (sql.includes('INSERT INTO transactions')) {
        throw new Error('insert failed');
      }
      if (sql.includes('INSERT INTO recipient_bank_accounts')) return { rows: [] };
      if (sql.includes('UPDATE recipients SET notes = $1')) return { rows: [] };
      return { rows: [] };
    });

    const result = await importCSV('/tmp/test.csv', 'revolut');

    expect(result.total_processed).toBe(2);
    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toBe(2);
  });
});
