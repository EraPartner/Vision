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

vi.mock('../src/repositories/rawTransactionRepository.js', () => ({
  computeHash: vi.fn(() => 'abc123hash'),
  belfiusRawRepo: {
    create: vi.fn(),
    existsByHash: vi.fn(),
  },
  revolutRawRepo: {
    create: vi.fn(),
    existsByHash: vi.fn(),
  },
  kbcRawRepo: {
    create: vi.fn(),
    existsByHash: vi.fn(),
  },
  rawReferenceRepo: {
    create: vi.fn(),
  },
  isRawDuplicate: vi.fn(),
}));

import { importCSVWithRawStorage } from '../src/services/rawTransactionImportService.js';
import { createAdapter } from '../src/services/bankAdapters.js';
import { query } from '../src/database/connection.js';
import { belfiusRawRepo, revolutRawRepo, kbcRawRepo, rawReferenceRepo, computeHash } from '../src/repositories/rawTransactionRepository.js';

describe('Raw Transaction Import Service', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Successful import ──────────────────────────────────────
  it('should import belfius transactions successfully', async () => {
    createAdapter.mockReturnValue(() => [
      {
        date: new Date('2026-01-15'), amount: -50.00, recipient: 'SHOP',
        bankAccount: 'Belfius', currency: 'EUR', balance: 1000,
        memo: 'Payment', comment: '', rawData: 'line1;data;here',
        recipientAccount: 'BE123', recipientAddress: null, recipientBankName: 'Belfius',
      },
    ]);

    belfiusRawRepo.existsByHash.mockResolvedValue(false);
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
    createAdapter.mockReturnValue(() => [
      {
        date: new Date('2026-01-15'), amount: -50.00, recipient: 'SHOP',
        bankAccount: 'Belfius', currency: 'EUR', rawData: 'duplicate;line',
      },
    ]);

    belfiusRawRepo.existsByHash.mockResolvedValue(true);

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result.duplicates).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('should handle revolut imports', async () => {
    createAdapter.mockReturnValue(() => [
      {
        date: new Date('2026-01-15'), amount: -25.00, recipient: 'STORE',
        bankAccount: 'Revolut', currency: 'EUR', rawData: 'revolut,data,line',
      },
    ]);

    revolutRawRepo.existsByHash.mockResolvedValue(false);
    revolutRawRepo.create.mockResolvedValue({ id: 1 });
    query.mockResolvedValue({ rows: [{ id: 200 }] });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'revolut');

    expect(result.imported).toBe(1);
  });

  it('should handle kbc imports', async () => {
    createAdapter.mockReturnValue(() => [
      {
        date: new Date('2026-01-15'), amount: -100.00, recipient: 'MERCHANT',
        bankAccount: 'KBC', currency: 'EUR', rawData: 'kbc;data;line',
      },
    ]);

    kbcRawRepo.existsByHash.mockResolvedValue(false);
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
    createAdapter.mockReturnValue(() => [
      {
        date: new Date('2026-01-15'), amount: -50.00, recipient: 'SHOP',
        bankAccount: 'Belfius', currency: 'EUR', rawData: null, // missing
      },
    ]);

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    expect(result.errors).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('should continue when raw storage fails (table not exists)', async () => {
    createAdapter.mockReturnValue(() => [
      {
        date: new Date('2026-01-15'), amount: -50.00, recipient: 'SHOP',
        bankAccount: 'Belfius', currency: 'EUR', rawData: 'line;data',
        recipientAccount: null, recipientAddress: null, recipientBankName: null,
      },
    ]);

    belfiusRawRepo.existsByHash.mockResolvedValue(false);
    belfiusRawRepo.create.mockRejectedValue(new Error('relation does not exist'));
    query.mockResolvedValue({ rows: [{ id: 100 }] });

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'belfius');

    // Should still import the normalized transaction
    expect(result.imported).toBe(1);
  });

  // ── Multiple transactions ──────────────────────────────────
  it('should process multiple transactions with mixed results', async () => {
    createAdapter.mockReturnValue(() => [
      { date: new Date('2026-01-15'), amount: -50, recipient: 'A', bankAccount: 'Belfius', currency: 'EUR', rawData: 'line1' },
      { date: new Date('2026-01-16'), amount: -30, recipient: 'B', bankAccount: 'Belfius', currency: 'EUR', rawData: 'line2' },
      { date: new Date('2026-01-17'), amount: -20, recipient: 'C', bankAccount: 'Belfius', currency: 'EUR', rawData: 'line3' },
    ]);

    // First: new, Second: duplicate, Third: new
    belfiusRawRepo.existsByHash
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

  // ── Generic bank fallback ──────────────────────────────────
  it('should use legacy import for generic/unknown bank type', async () => {
    // For generic banks, it dynamically imports importService
    // We can't easily test this without more complex mocking, but we verify
    // the function doesn't crash for unknown bank names
    createAdapter.mockReturnValue(() => []);

    const result = await importCSVWithRawStorage('/tmp/test.csv', 'UnknownBank');

    // Generic bank with no transactions returns 0
    expect(result.total_processed).toBe(0);
  });
});
