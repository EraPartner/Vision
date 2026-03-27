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
    expect(Array.isArray(result.patterns[0].amountChanges)).toBe(true);
  });
});
