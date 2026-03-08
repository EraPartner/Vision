/**
 * Raw Transaction Repository tests.
 * Tests hash computation, deduplication, and CRUD for bank-specific raw tables.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { query } from '../src/database/connection.js';
import {
  computeHash,
  belfiusRawRepo,
  revolutRawRepo,
  kbcRawRepo,
  rawReferenceRepo,
  isRawDuplicate,
} from '../src/repositories/rawTransactionRepository.js';

describe('Raw Transaction Repository', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── computeHash ────────────────────────────────────────────
  describe('computeHash', () => {
    it('should return consistent SHA256 hash', () => {
      const hash1 = computeHash('test data');
      const hash2 = computeHash('test data');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex length
    });

    it('should return different hashes for different data', () => {
      const hash1 = computeHash('data one');
      const hash2 = computeHash('data two');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = computeHash('');
      expect(hash).toHaveLength(64);
    });

    it('should handle special characters', () => {
      const hash = computeHash('Données spéciales: €, ñ, ü');
      expect(hash).toHaveLength(64);
    });
  });

  // ── Belfius Raw Repo ───────────────────────────────────────
  describe('belfiusRawRepo', () => {
    it('should create raw transaction', async () => {
      query.mockResolvedValue({ rows: [{ id: 1, deduplication_hash: 'abc' }] });

      const result = await belfiusRawRepo.create({
        deduplication_hash: 'abc', account_number: 'BE123',
        transaction_date: '2026-01-15', statement_number: '001',
        transaction_number: '001', recipient_account: 'BE456',
        recipient_name: 'SHOP', recipient_street: null,
        recipient_location: null, recipient_bic: null,
        recipient_country: null, transaction_description: 'Payment',
        value_date: '2026-01-15', amount: -50, currency: 'EUR',
        balance: 1000, additional_message: null, raw_csv_line: 'raw;data',
      });

      expect(result.id).toBe(1);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('should check existence by hash', async () => {
      query.mockResolvedValue({ rows: [{ id: 1 }] });
      const exists = await belfiusRawRepo.existsByHash('abc123');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent hash', async () => {
      query.mockResolvedValue({ rows: [] });
      const exists = await belfiusRawRepo.existsByHash('notfound');
      expect(exists).toBe(false);
    });

    it('should find by account and date range', async () => {
      query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
      const result = await belfiusRawRepo.findByAccountAndDateRange('BE123', '2026-01-01', '2026-01-31');
      expect(result).toHaveLength(2);
    });

    it('should get latest balance', async () => {
      query.mockResolvedValue({ rows: [{ balance: '1500.50' }] });
      const balance = await belfiusRawRepo.getLatestBalance('BE123');
      expect(balance).toBe(1500.50);
    });

    it('should return null for no balance', async () => {
      query.mockResolvedValue({ rows: [] });
      const balance = await belfiusRawRepo.getLatestBalance('BE123');
      expect(balance).toBeNull();
    });
  });

  // ── Revolut Raw Repo ───────────────────────────────────────
  describe('revolutRawRepo', () => {
    it('should create raw transaction', async () => {
      query.mockResolvedValue({ rows: [{ id: 1 }] });

      const result = await revolutRawRepo.create({
        deduplication_hash: 'abc', transaction_type: 'CARD_PAYMENT',
        product: 'Current', started_date: '2026-01-15',
        completed_date: '2026-01-15', description: 'STORE',
        amount: -25, fee: 0, currency: 'EUR', state: 'COMPLETED',
        balance: 500, raw_csv_line: 'raw,data',
      });

      expect(result.id).toBe(1);
    });

    it('should check existence by hash', async () => {
      query.mockResolvedValue({ rows: [] });
      const exists = await revolutRawRepo.existsByHash('notfound');
      expect(exists).toBe(false);
    });

    it('should find by product and date range', async () => {
      query.mockResolvedValue({ rows: [{ id: 1 }] });
      const result = await revolutRawRepo.findByProductAndDateRange('Current', '2026-01-01', '2026-01-31');
      expect(result).toHaveLength(1);
    });

    it('should get latest balance', async () => {
      query.mockResolvedValue({ rows: [{ balance: '750.00' }] });
      const balance = await revolutRawRepo.getLatestBalance('Current');
      expect(balance).toBe(750.00);
    });
  });

  // ── KBC Raw Repo ───────────────────────────────────────────
  describe('kbcRawRepo', () => {
    it('should create raw transaction', async () => {
      query.mockResolvedValue({ rows: [{ id: 1 }] });

      const result = await kbcRawRepo.create({
        deduplication_hash: 'abc', account_number: 'BE789',
        category_name: 'Payment', account_holder_name: 'John',
        currency: 'EUR', statement_number: '001',
        transaction_date: '2026-01-15', value_date: '2026-01-15',
        description: 'Transfer', amount: -100, balance: 2000,
        credit_amount: null, debit_amount: 100,
        counterparty_account: 'BE456', counterparty_bic: 'KREDBEBB',
        counterparty_name: 'MERCHANT', counterparty_address: null,
        structured_communication: null, free_communication: 'Test',
        raw_csv_line: 'raw;kbc;data',
      });

      expect(result.id).toBe(1);
    });

    it('should check existence by hash', async () => {
      query.mockResolvedValue({ rows: [{ id: 1 }] });
      const exists = await kbcRawRepo.existsByHash('found');
      expect(exists).toBe(true);
    });

    it('should find by account and date range', async () => {
      query.mockResolvedValue({ rows: [] });
      const result = await kbcRawRepo.findByAccountAndDateRange('BE789', '2026-01-01', '2026-01-31');
      expect(result).toEqual([]);
    });

    it('should get latest balance', async () => {
      query.mockResolvedValue({ rows: [] });
      const balance = await kbcRawRepo.getLatestBalance('BE789');
      expect(balance).toBeNull();
    });
  });

  // ── Raw Reference Repo ─────────────────────────────────────
  describe('rawReferenceRepo', () => {
    it('should create raw reference', async () => {
      query.mockResolvedValue({ rows: [{ id: 1, transaction_id: 100, raw_source_type: 'belfius', raw_source_id: 1 }] });

      const result = await rawReferenceRepo.create({
        transactionId: 100, rawSourceType: 'belfius', rawSourceId: 1,
      });

      expect(result.transaction_id).toBe(100);
    });

    it('should get reference by transaction ID', async () => {
      query.mockResolvedValue({ rows: [{ transaction_id: 100, raw_source_type: 'belfius' }] });

      const result = await rawReferenceRepo.getByTransactionId(100);
      expect(result.raw_source_type).toBe('belfius');
    });

    it('should return null for no reference', async () => {
      query.mockResolvedValue({ rows: [] });

      const result = await rawReferenceRepo.getByTransactionId(999);
      expect(result).toBeNull();
    });
  });

  // ── isRawDuplicate ─────────────────────────────────────────
  describe('isRawDuplicate', () => {
    it('should check belfius duplicates', async () => {
      query.mockResolvedValue({ rows: [{ id: 1 }] });
      const result = await isRawDuplicate('belfius', 'raw;data');
      expect(result).toBe(true);
    });

    it('should check revolut duplicates', async () => {
      query.mockResolvedValue({ rows: [] });
      const result = await isRawDuplicate('revolut', 'raw,data');
      expect(result).toBe(false);
    });

    it('should check kbc duplicates', async () => {
      query.mockResolvedValue({ rows: [] });
      const result = await isRawDuplicate('kbc', 'raw;data');
      expect(result).toBe(false);
    });

    it('should throw for unsupported bank type', async () => {
      await expect(isRawDuplicate('unknown', 'data')).rejects.toThrow('Unsupported bank type');
    });
  });
});
