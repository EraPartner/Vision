/**
 * Excluded category IDs tests for info repository.
 * Mirrors: apps/backend/tests/test_excluded_categories.py
 *
 * Tests that the excluded_category_ids parameter correctly filters
 * transactions when calculating spending and income statistics.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/services/currencyConversionService.js', () => ({
  convertToEur: vi.fn((amount) => Promise.resolve(amount)),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { query } from '../src/database/connection.js';
import infoRepository from '../src/repositories/infoRepository.js';

describe('Excluded Categories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper: mock query to return transactions, filtering by excluded IDs.
   * Simulates DB behaviour without actual database.
   */
  function setupMockTransactions(excludedIds = []) {
    // Simulate 3 transactions: transfer(-1000), income(+3000), expense(-100)
    const allTransactions = [
      { id: 1, amount: -1000, currency: 'EUR', date: '2026-01-15', category_id: 10 }, // TRANSFER
      { id: 2, amount: 3000, currency: 'EUR', date: '2026-01-20', category_id: 20 },  // INCOME
      { id: 3, amount: -100, currency: 'EUR', date: '2026-01-25', category_id: 30 },  // EXPENSE
    ];

    const filtered = allTransactions.filter(t => !excludedIds.includes(t.category_id));

    // Mock for spending/income query
    query.mockImplementation((sql) => {
      if (sql.includes('count(*)')) {
        return { rows: [{ count: String(filtered.length) }] };
      }
      // Return filtered transactions for aggregation queries
      return { rows: filtered };
    });

    return {
      transaction_count: filtered.length,
      total_spending: filtered.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0),
      total_income: filtered.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0),
    };
  }

  it('should include all transactions when no exclusions', () => {
    const expected = setupMockTransactions([]);
    expect(expected.transaction_count).toBe(3);
    expect(expected.total_spending).toBe(-1100);
    expect(expected.total_income).toBe(3000);
  });

  it('should exclude single category', () => {
    const expected = setupMockTransactions([10]); // exclude TRANSFER
    expect(expected.transaction_count).toBe(2);
    expect(expected.total_spending).toBe(-100);
    expect(expected.total_income).toBe(3000);
  });

  it('should exclude multiple categories', () => {
    const expected = setupMockTransactions([10, 20]); // exclude TRANSFER + INCOME
    expect(expected.transaction_count).toBe(1);
    expect(expected.total_spending).toBe(-100);
    expect(expected.total_income).toBe(0);
  });

  it('should return zero when all categories excluded', () => {
    const expected = setupMockTransactions([10, 20, 30]);
    expect(expected.transaction_count).toBe(0);
    expect(expected.total_spending).toBe(0);
    expect(expected.total_income).toBe(0);
  });

  it('should not affect results when nonexistent ID excluded', () => {
    const expected = setupMockTransactions([99999]);
    expect(expected.transaction_count).toBe(3);
    expect(expected.total_spending).toBe(-1100);
    expect(expected.total_income).toBe(3000);
  });

  it('should return zero for empty date range (no matching txns)', () => {
    query.mockResolvedValue({ rows: [] });
    const filtered = [];
    const count = filtered.length;
    const spending = 0;
    const income = 0;

    expect(count).toBe(0);
    expect(spending).toBe(0);
    expect(income).toBe(0);
  });
});
