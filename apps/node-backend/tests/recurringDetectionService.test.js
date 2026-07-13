import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../src/database/connection.js', () => ({
  query: (...args) => mockQuery(...args),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { detectRecurringPatterns } from '../src/services/recurringDetectionService.js';

describe('detectRecurringPatterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles Date objects in transaction date field without throwing', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            date: new Date('2026-01-01T00:00:00.000Z'),
            amount: '-50.00',
            currency: 'EUR',
            memo: 'Gym Jan',
            bank_account: 'BE00',
            recipient_id: 42,
            recipient_name: 'Gym',
            category_id: 7,
            category_name: 'HEALTH:GYM',
          },
          {
            id: 2,
            date: new Date('2026-02-01T00:00:00.000Z'),
            amount: '-50.00',
            currency: 'EUR',
            memo: 'Gym Feb',
            bank_account: 'BE00',
            recipient_id: 42,
            recipient_name: 'Gym',
            category_id: 7,
            category_name: 'HEALTH:GYM',
          },
          {
            id: 3,
            date: new Date('2026-03-01T00:00:00.000Z'),
            amount: '-55.00',
            currency: 'EUR',
            memo: 'Gym Mar',
            bank_account: 'BE00',
            recipient_id: 42,
            recipient_name: 'Gym',
            category_id: 7,
            category_name: 'HEALTH:GYM',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await detectRecurringPatterns();

    expect(result.total).toBe(1);
    expect(result.patterns[0].recipientId).toBe(42);
    expect(result.patterns[0].direction).toBe('expense');
    expect(Array.isArray(result.patterns[0].amountChanges)).toBe(true);
  });

  it('partitions income and expense flows from the same recipient', async () => {
    // Bucketing by recipient alone blended a €2000 monthly salary with €50
    // monthly payments into one nonsensical averaged pattern.
    const tx = (id, date, amount) => ({
      id,
      date: new Date(`${date}T00:00:00.000Z`),
      amount,
      currency: 'EUR',
      memo: `tx ${id}`,
      bank_account: 'BE00',
      recipient_id: 42,
      recipient_name: 'Employer & Landlord',
      category_id: 7,
      category_name: 'MISC:MISC',
    });
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          // ORDER BY recipient_id, date — directions interleave per month
          tx(1, '2026-01-01', '2000.00'), tx(2, '2026-01-05', '-50.00'),
          tx(3, '2026-02-01', '2000.00'), tx(4, '2026-02-05', '-50.00'),
          tx(5, '2026-03-01', '2000.00'), tx(6, '2026-03-05', '-50.00'),
        ],
      })
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await detectRecurringPatterns();

    expect(result.total).toBe(2);
    const income = result.patterns.find((p) => p.direction === 'income');
    const expense = result.patterns.find((p) => p.direction === 'expense');
    expect(income?.averageAmount).toBe(2000);
    expect(expense?.averageAmount).toBe(50);
    // Both detected as monthly, not the ~17-day blend of the merged series
    expect(income?.detectedPattern).toBe('monthly');
    expect(expense?.detectedPattern).toBe('monthly');
  });
});
