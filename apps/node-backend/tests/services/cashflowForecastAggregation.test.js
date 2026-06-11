import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/repositories/plannedTransactionRepository.js', () => ({
  default: { getForForecast: vi.fn() },
}));

import plannedTransactionRepository from '../../src/repositories/plannedTransactionRepository.js';
import { computeCashflowForecast } from '../../src/services/calculations/aggregation/cashflowForecast.js';

describe('computeCashflowForecast — pg DATE handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00Z'));
    plannedTransactionRepository.getForForecast.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not throw and buckets correctly when planned_date is a JS Date', async () => {
    // node-postgres returns DATE columns as a local-midnight Date; the old
    // String(date).slice(0,10) produced "Mon Jun 15…" which crashed the strict
    // appDateStringToUtc parser — a 500 whenever any planned transaction existed.
    plannedTransactionRepository.getForForecast.mockResolvedValue([
      {
        id: 1,
        planned_date: new Date(2026, 5, 15), // 2026-06-15 local midnight
        amount: '-100.00',
        currency: 'EUR',
        memo: null,
        is_recurring: false,
        recurrence_pattern: null,
        recipient_name: null,
        category_name: null,
      },
    ]);

    const result = await computeCashflowForecast({ months: 3 });
    const june = result.data.find((b) => b.month === '2026-06');

    expect(june).toBeDefined();
    expect(june.expenses).toBe(-100);
  });
});
