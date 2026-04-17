/**
 * Raw Transaction Import Service tests.
 * Mirrors raw transaction import logic from Python backend.
 * Tests CSV parsing, deduplication, and raw storage orchestration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/services/bankAdapters.js', () => ({
  createAdapter: vi.fn(),
}));

vi.mock('../src/services/importService.js', () => ({
  importCSV: vi.fn(),
}));

vi.mock('../src/services/deduplication.js', () => ({
  isDuplicateByFields: vi.fn(),
}));

vi.mock('../src/services/calculations/normalization.js', () => ({
  findBestRecipientMatch: vi.fn(),
  findBestRecipientMatches: vi.fn(async () => new Map()),
  normalizeForMatching: (s) => (s || '').toUpperCase().trim(),
  cleanRecipientName: (s) => s,
  cleanKbcRecipientName: (s) => s,
  normalizeToUppercase: (s) => (s || '').toUpperCase(),
  DEFAULT_MATCH_THRESHOLD: 0.7,
}));

vi.mock('../src/repositories/rawTransactionRepository.js', () => ({
  computeHash: vi.fn(() => 'abc123hash'),
  belfiusRawRepo: {
    create: vi.fn(),
  },
  revolutRawRepo: {
    create: vi.fn(),
  },
  kbcRawRepo: {
    create: vi.fn(),
  },
  sabbRawRepo: {
    create: vi.fn(),
  },
  wiseRawRepo: {
    create: vi.fn(),
  },
  visionRawRepo: {
    create: vi.fn(),
  },
  rawReferenceRepo: {
    create: vi.fn(),
  },
  isRawDuplicate: vi.fn(),
}));

import { importCSVWithRawStorage } from '../src/services/rawTransactionImportService.js';
import { createAdapter } from '../src/services/bankAdapters.js';
import { importCSV } from '../src/services/importService.js';
import { isDuplicateByFields } from '../src/services/deduplication.js';
import { query } from '../src/database/connection.js';
import { findBestRecipientMatch } from '../src/services/calculations/normalization.js';
import {
  belfiusRawRepo,
  revolutRawRepo,
  kbcRawRepo,
  sabbRawRepo,
  wiseRawRepo,
  visionRawRepo,
  rawReferenceRepo,
  computeHash,
  isRawDuplicate,
} from '../src/repositories/rawTransactionRepository.js';

function makeTx(overrides = {}) {
  return {
    date: new Date('2026-01-15T00:00:00.000Z'),
    amount: -50,
    recipient: 'SHOP',
    bankAccount: 'Main Account',
    currency: 'EUR',
    balance: 1000,
    memo: 'Payment',
    comment: '',
    rawData: 'line1;data;here',
    recipientAccount: 'BE123',
    recipientAddress: null,
    recipientBankName: 'TestBank',
    ...overrides,
  };
}

describe('Raw Transaction Import Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isDuplicateByFields.mockResolvedValue(false);
  });

  // ── Successful import ──────────────────────────────────────
  it('should import belfius transactions successfully', async () => {
    createAdapter.mockReturnValue(() => [makeTx({ bankAccount: 'Belfius', recipientBankName: 'Belfius' })]);

    isRawDuplicate.mockResolvedValue(false);
    belfiusRawRepo.create.mockResolvedValue({ id: 1 });
    query.mockResolvedValue({ rows: [{ id: 100 }] });
    rawReferenceRepo.create.mockResolvedValue({});

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result.total_processed).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('should detect duplicates via hash', async () => {
    createAdapter.mockReturnValue(() => [makeTx({ bankAccount: 'Belfius', rawData: 'duplicate;line' })]);

    isRawDuplicate.mockResolvedValue(true);

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result.duplicates).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('should handle revolut imports', async () => {
    createAdapter.mockReturnValue(() => [
      makeTx({ amount: -25.00, recipient: 'STORE', bankAccount: 'Revolut', rawData: 'revolut,data,line' }),
    ]);

    isRawDuplicate.mockResolvedValue(false);
    revolutRawRepo.create.mockResolvedValue({ id: 1 });
    query.mockResolvedValue({ rows: [{ id: 200 }] });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'revolut');

    expect(result.imported).toBe(1);
  });

  it('should handle kbc imports', async () => {
    createAdapter.mockReturnValue(() => [
      makeTx({ amount: -100.00, recipient: 'MERCHANT', bankAccount: 'KBC', rawData: 'kbc;data;line' }),
    ]);

    isRawDuplicate.mockResolvedValue(false);
    kbcRawRepo.create.mockResolvedValue({ id: 1 });
    query.mockResolvedValue({ rows: [{ id: 300 }] });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'kbc');

    expect(result.imported).toBe(1);
  });

  // ── Error handling ─────────────────────────────────────────
  it('should return error result when adapter throws', async () => {
    createAdapter.mockReturnValue(() => { throw new Error('Parse error'); });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(result.total_processed).toBe(0);
  });

  it('should skip transactions without rawData', async () => {
    createAdapter.mockReturnValue(() => [makeTx({ bankAccount: 'Belfius', rawData: null })]);

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result.errors).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('should continue when raw storage fails (table not exists)', async () => {
    createAdapter.mockReturnValue(() => [
      makeTx({ bankAccount: 'Belfius', rawData: 'line;data', recipientAccount: null, recipientAddress: null, recipientBankName: null }),
    ]);

    isRawDuplicate.mockResolvedValue(false);
    belfiusRawRepo.create.mockRejectedValue(new Error('relation does not exist'));
    query.mockResolvedValue({ rows: [{ id: 100 }] });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    // Should still import the normalized transaction
    expect(result.imported).toBe(1);
  });

  // ── Multiple transactions ──────────────────────────────────
  it('should process multiple transactions with mixed results', async () => {
    createAdapter.mockReturnValue(() => [
      makeTx({ date: new Date('2026-01-15T00:00:00.000Z'), amount: -50, recipient: 'A', bankAccount: 'Belfius', rawData: 'line1' }),
      makeTx({ date: new Date('2026-01-16T00:00:00.000Z'), amount: -30, recipient: 'B', bankAccount: 'Belfius', rawData: 'line2' }),
      makeTx({ date: new Date('2026-01-17T00:00:00.000Z'), amount: -20, recipient: 'C', bankAccount: 'Belfius', rawData: 'line3' }),
    ]);

    // First: new, Second: duplicate, Third: new
    isRawDuplicate
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    belfiusRawRepo.create.mockResolvedValue({ id: 1 });
    query.mockResolvedValue({ rows: [{ id: 100 }] });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result.total_processed).toBe(3);
    expect(result.imported).toBe(2);
    expect(result.duplicates).toBe(1);
  });

  it('should use dedup fallback when raw duplicate check throws and mark duplicate', async () => {
    createAdapter.mockReturnValue(() => [makeTx({ bankAccount: 'Belfius' })]);
    isRawDuplicate.mockRejectedValue(new Error('raw table missing'));
    isDuplicateByFields.mockResolvedValue(true);

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result).toEqual({ total_processed: 1, imported: 0, duplicates: 1, errors: 0 });
    expect(isDuplicateByFields).toHaveBeenCalledWith('2026-01-15', -50, 'SHOP', 'Payment');
    expect(belfiusRawRepo.create).not.toHaveBeenCalled();
  });

  // ── Generic bank fallback ──────────────────────────────────
  it('should delegate unknown bank imports to importCSV and return its result', async () => {
    createAdapter.mockReturnValue(() => [makeTx({ bankAccount: 'Unknown Account' })]);
    importCSV.mockResolvedValue({ total_processed: 7, imported: 5, duplicates: 1, errors: 1 });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'UnknownBank');

    expect(importCSV).toHaveBeenCalledWith('/tmp/test.csv', 'UnknownBank', null);
    expect(result).toEqual({ total_processed: 7, imported: 5, duplicates: 1, errors: 1 });
  });

  it('should keep import successful when raw reference creation fails', async () => {
    createAdapter.mockReturnValue(() => [makeTx({ bankAccount: 'Belfius' })]);
    isRawDuplicate.mockResolvedValue(false);
    belfiusRawRepo.create.mockResolvedValue({ id: 10 });
    query.mockResolvedValue({ rows: [{ id: 100 }] });
    rawReferenceRepo.create.mockRejectedValue(new Error('reference insert failed'));

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result.imported).toBe(1);
    expect(result.errors).toBe(0);
    expect(rawReferenceRepo.create).toHaveBeenCalled();
  });

  it('should add a new bank account for an existing recipient when account is missing', async () => {
    createAdapter.mockReturnValue(() => [
      makeTx({ bankAccount: 'Belfius', recipient: 'Known Recipient', recipientAccount: 'BE999', recipientBankName: 'Belfius' }),
    ]);
    isRawDuplicate.mockResolvedValue(false);
    belfiusRawRepo.create.mockResolvedValue({ id: 1 });
    rawReferenceRepo.create.mockResolvedValue({});
    findBestRecipientMatch.mockResolvedValue({
      recipientId: 42,
      normalizedName: 'KNOWN RECIPIENT',
      similarity: 1,
      exact: true,
    });

    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM recipient_bank_accounts')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO recipient_bank_accounts')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO transactions')) {
        return { rows: [{ id: 500 }] };
      }
      return { rows: [] };
    });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result.imported).toBe(1);
    expect(query.mock.calls.some(
      ([sql, params]) => typeof sql === 'string'
        && sql.includes('INSERT INTO recipient_bank_accounts')
        && sql.includes('false, true')
        && params[0] === 42
        && params[1] === 'BE999'
    )).toBe(true);
  });

  it('should create recipient, primary bank account, and address notes for new recipient', async () => {
    createAdapter.mockReturnValue(() => [
      makeTx({
        bankAccount: 'Belfius',
        recipient: 'Brand New',
        recipientAccount: 'BE222',
        recipientAddress: 'New Street 123',
        recipientBankName: 'Belfius',
      }),
    ]);
    isRawDuplicate.mockResolvedValue(false);
    belfiusRawRepo.create.mockResolvedValue({ id: 3 });
    rawReferenceRepo.create.mockResolvedValue({});
    findBestRecipientMatch.mockResolvedValue(null);

    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM recipients WHERE normalized_name = $1')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO recipients')) {
        return { rows: [{ id: 77 }] };
      }
      if (sql.includes('INSERT INTO recipient_bank_accounts')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE recipients SET notes = $1 WHERE id = $2')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO transactions')) {
        return { rows: [{ id: 900 }] };
      }
      return { rows: [] };
    });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result.imported).toBe(1);
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO recipients'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO recipient_bank_accounts') && sql.includes('true, true'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('UPDATE recipients SET notes = $1 WHERE id = $2'))).toBe(true);
  });

  it('should use sabb raw repository for SABB bank names', async () => {
    createAdapter.mockReturnValue(() => [
      makeTx({
        bankAccount: 'SABB',
        currency: 'SAR',
        rawData: '15/01/2026|15/01/2026|Salary Payment|1000||POSTED',
      }),
    ]);
    isRawDuplicate.mockResolvedValue(false);
    sabbRawRepo.create.mockResolvedValue({ id: 6 });
    query.mockResolvedValue({ rows: [{ id: 100 }] });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'SABB Personal');

    expect(result.imported).toBe(1);
    expect(sabbRawRepo.create).toHaveBeenCalledTimes(1);
  });

  it('should use wise raw repository for Wise bank names', async () => {
    createAdapter.mockReturnValue(() => [
      makeTx({
        bankAccount: 'Wise',
        rawData: 'id|COMPLETED|OUT|2026-01-15|2026-01-15|Source|100|1|EUR|EUR|Target|99|EUR|1.0|ref|batch|cat|note',
      }),
    ]);
    isRawDuplicate.mockResolvedValue(false);
    wiseRawRepo.create.mockResolvedValue({ id: 7 });
    query.mockResolvedValue({ rows: [{ id: 100 }] });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'Wise Europe');

    expect(result.imported).toBe(1);
    expect(wiseRawRepo.create).toHaveBeenCalledTimes(1);
  });

  it('should use vision raw repository for Vision bank names', async () => {
    createAdapter.mockReturnValue(() => [
      makeTx({
        bankAccount: 'Vision',
        rawData: '2026-01-15|-20|Vision|Store|Memo|EUR|1000|FOOD|Comment',
      }),
    ]);
    isRawDuplicate.mockResolvedValue(false);
    visionRawRepo.create.mockResolvedValue({ id: 8 });
    query.mockResolvedValue({ rows: [{ id: 100 }] });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'Vision Main');

    expect(result.imported).toBe(1);
    expect(visionRawRepo.create).toHaveBeenCalledTimes(1);
  });
});
