import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  withSavepointIfInTransaction: vi.fn((_n, fn) => fn()),
}));

import { mapPortfolioTxRow } from '../src/repositories/portfolioTxRepo.reads.js';

describe('mapPortfolioTxRow — wire shape', () => {
  it('emits DATE columns as calendar-day strings, not raw pg Dates', () => {
    // pg parses DATE into a local-midnight Date; JSON-serializing that emits
    // an ISO timestamp of the PREVIOUS day east of UTC, which the edit dialog
    // T-split and wrote back — date−1 per save.
    const prevTz = process.env.TZ;
    process.env.TZ = 'Europe/Brussels';
    try {
      const row = mapPortfolioTxRow({
        id: 1,
        date: new Date(2026, 6, 1), // local midnight July 1 (pg shape)
        recurrence_end_date: new Date(2026, 11, 31),
        amount: '1000.50',
        units: '10',
      });
      expect(row.date).toBe('2026-07-01');
      expect(row.recurrence_end_date).toBe('2026-12-31');
      expect(row.amount).toBe(1000.5); // NUMERIC coercion still applies
    } finally {
      process.env.TZ = prevTz;
    }
  });

  it('passes through string dates and null untouched', () => {
    const row = mapPortfolioTxRow({ id: 2, date: '2026-07-01', recurrence_end_date: null, amount: '1' });
    expect(row.date).toBe('2026-07-01');
    expect(row.recurrence_end_date).toBeNull();
  });
});
