import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/repositories/infoRepositoryHelpers.js', async () => {
  const actual = await vi.importActual('../src/repositories/infoRepositoryHelpers.js');
  return {
    ...actual,
    batchConvertGroupsWithHistoricalRateFallback: vi.fn(),
  };
});

import { query } from '../src/database/connection.js';
import { batchConvertGroupsWithHistoricalRateFallback } from '../src/repositories/infoRepositoryHelpers.js';
import {
  getCashflowComparison,
  getCashflowForecastData,
  getCashflowForecastDataRolling,
  getCashflowForecastDataByCategory,
} from '../src/repositories/infoRepositoryForecast.js';
import { ValidationError } from '../src/middleware/errorHandler.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-04-15T12:00:00Z'));
});

afterEach(() => vi.useRealTimers());

describe('getCashflowComparison', () => {
  function setupEmpty() {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValue([[], [], [], []]);
  }

  it('runs four parallel queries (past, current, planned current, planned hist)', async () => {
    setupEmpty();
    await getCashflowComparison([], [], 'EUR');
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0][0]).toContain("date >= date_trunc('month', CURRENT_DATE) - interval '24 months'");
    expect(query.mock.calls[0][0]).toContain("date < date_trunc('month', CURRENT_DATE)");
    expect(query.mock.calls[1][0]).toContain('CURRENT_DATE');
    expect(query.mock.calls[2][0]).toContain('FROM planned_transactions');
    expect(query.mock.calls[3][0]).toContain('month_key');
    // Executed planned transactions must be excluded from the overlays, or an
    // executed non-recurring row double-counts against its real transaction.
    expect(query.mock.calls[2][0]).toContain('is_executed = false');
    expect(query.mock.calls[3][0]).toContain('is_executed = false');
  });

  it('returns days_in_month, current_day, month, year aligned to the system clock', async () => {
    setupEmpty();
    const r = await getCashflowComparison([], [], 'EUR');
    expect(r.month).toBe(4);
    expect(r.year).toBe(2025);
    expect(r.current_day).toBe(15);
    expect(r.days_in_month).toBe(30);
    expect(r.without_planned).toHaveLength(30);
    expect(r.with_planned).toHaveLength(30);
  });

  it('marks future-day current as null in the output', async () => {
    setupEmpty();
    const r = await getCashflowComparison([], [], 'EUR');
    const day20 = r.without_planned.find((d) => d.day === 20);
    expect(day20.current).toBeNull();
    const day10 = r.without_planned.find((d) => d.day === 10);
    expect(day10.current).toBe(0); // up to current day, value non-null
  });

  it('builds cumulative averages from past month data', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { day_of_month: 5, month_key: '2025-01', amount_eur: 100 },
        { day_of_month: 10, month_key: '2025-01', amount_eur: -30 },
        { day_of_month: 5, month_key: '2025-02', amount_eur: 60 },
      ],
      [
        { day_of_month: 1, amount_eur: 50 },
        { day_of_month: 3, amount_eur: -10 },
      ],
      [],
      [],
    ]);

    const r = await getCashflowComparison([], [], 'EUR');
    // Day 5: avg of (100 from Jan, 60 from Feb)/2 = 80
    expect(r.without_planned.find((d) => d.day === 5).average).toBe(80);
    // Day 10: ((100-30) + 60)/2 = 65
    expect(r.without_planned.find((d) => d.day === 10).average).toBe(65);
    // Current day 1: 50; day 3 cumulative: 40
    expect(r.without_planned.find((d) => d.day === 1).current).toBe(50);
    expect(r.without_planned.find((d) => d.day === 3).current).toBe(40);
    // Future day 20 has no current
    expect(r.without_planned.find((d) => d.day === 20).current).toBeNull();
  });

  it('binds category and recipient exclusion params with sequential numbering', async () => {
    setupEmpty();
    await getCashflowComparison([1, 2], [9], 'EUR');
    const [pastSql, params] = query.mock.calls[0];
    expect(pastSql).toContain('NOT IN ($1, $2)');
    expect(pastSql).toContain('NOT IN ($3)');
    expect(params).toEqual([1, 2, 9]);
  });

  it('skips JOIN when there are no exclusions', async () => {
    setupEmpty();
    await getCashflowComparison([], [], 'EUR');
    const [pastSql] = query.mock.calls[0];
    expect(pastSql).not.toContain('LEFT JOIN recipients');
  });
});

describe('getCashflowForecastData', () => {
  it('issues 4 parallel queries with the configured history window', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], [], [], []]);

    const r = await getCashflowForecastData(12, [], [], 'EUR');
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0][0]).toContain("interval '12 months'");
    expect(r).toMatchObject({ historyMonths: 12 });
  });

  it('aggregates transactions by date and sorts ascending', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { date: '2025-02-15', amount_eur: 50 },
        { date: '2025-02-15', amount_eur: -20 },
        { date: '2025-01-30', amount_eur: 100 },
      ],
      [],
      [],
      [],
    ]);

    const r = await getCashflowForecastData(3);
    expect(r.history).toEqual([
      { date: '2025-01-30', net: 100 },
      { date: '2025-02-15', net: 30 },
    ]);
    expect(r.currentActual).toEqual([]);
  });

  it('formats Date instances as YYYY-MM-DD', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [{ date: new Date('2025-03-10T05:00:00Z'), amount_eur: 25 }],
      [], [], [],
    ]);
    const r = await getCashflowForecastData(1);
    expect(r.history[0].date).toBe('2025-03-10');
  });

  it('coerces non-numeric amount_eur to 0', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [{ date: '2025-03-10', amount_eur: 'not a number' }, { date: '2025-03-10', amount_eur: 5 }],
      [], [], [],
    ]);
    const r = await getCashflowForecastData(1);
    expect(r.history[0].net).toBe(5);
  });
});

describe('getCashflowForecastDataRolling', () => {
  it('rejects out-of-range historyMonths', async () => {
    // ValidationError (not a plain Error) so the route surface answers 400, not 500.
    await expect(getCashflowForecastDataRolling(0, 30, 60)).rejects.toBeInstanceOf(ValidationError);
    await expect(getCashflowForecastDataRolling(0, 30, 60)).rejects.toThrow(/historyMonths/);
    await expect(getCashflowForecastDataRolling(121, 30, 60)).rejects.toThrow(/historyMonths/);
    await expect(getCashflowForecastDataRolling(1.5, 30, 60)).rejects.toThrow(/historyMonths/);
  });

  it('rejects out-of-range daysBack', async () => {
    await expect(getCashflowForecastDataRolling(12, 0, 60)).rejects.toThrow(/daysBack/);
    await expect(getCashflowForecastDataRolling(12, 366, 60)).rejects.toThrow(/daysBack/);
  });

  it('rejects out-of-range daysForward', async () => {
    await expect(getCashflowForecastDataRolling(12, 30, 0)).rejects.toThrow(/daysForward/);
    await expect(getCashflowForecastDataRolling(12, 30, 366)).rejects.toThrow(/daysForward/);
  });

  it('runs three parallel queries (history, current rolling, planned future)', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], [], []]);

    await getCashflowForecastDataRolling(12, 30, 60);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toContain("interval '30 days'");
    expect(query.mock.calls[2][0]).toContain('planned_date > CURRENT_DATE');
  });

  it('returns ascending-date series for all three buckets', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [{ date: '2025-02-01', amount_eur: 10 }, { date: '2025-01-15', amount_eur: 20 }],
      [{ date: '2025-04-01', amount_eur: 5 }],
      [{ date: '2025-05-15', amount_eur: 100 }],
    ]);
    const r = await getCashflowForecastDataRolling(3, 30, 60);
    expect(r.history.map((d) => d.date)).toEqual(['2025-01-15', '2025-02-01']);
    expect(r.currentActual).toEqual([{ date: '2025-04-01', net: 5 }]);
    expect(r.plannedCurrent).toEqual([{ date: '2025-05-15', net: 100 }]);
  });
});

describe('getCashflowForecastDataByCategory', () => {
  it('runs two parallel queries (history + current) joined to categories', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);

    await getCashflowForecastDataByCategory(6);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain('LEFT JOIN categories cat');
    expect(query.mock.calls[0][0]).toContain("interval '6 months'");
  });

  it('aggregates by date AND category, preserving labels', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { date: '2025-03-01', category_id: 1, general: 'Food', detail: 'Groceries', amount_eur: -50 },
        { date: '2025-03-01', category_id: 1, general: 'Food', detail: 'Groceries', amount_eur: -25 },
        { date: '2025-03-01', category_id: 2, general: 'Bills', detail: 'Rent', amount_eur: -1000 },
      ],
      [],
    ]);

    const r = await getCashflowForecastDataByCategory(3);
    expect(r.historyByCategory).toEqual([
      { date: '2025-03-01', category_id: 1, general: 'Food', detail: 'Groceries', net: -75 },
      { date: '2025-03-01', category_id: 2, general: 'Bills', detail: 'Rent', net: -1000 },
    ]);
  });

  it('replaces missing category metadata with Uncategorized', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [{ date: '2025-03-01', category_id: null, general: null, detail: null, amount_eur: -10 }],
      [],
    ]);
    const r = await getCashflowForecastDataByCategory(3);
    expect(r.historyByCategory[0]).toMatchObject({
      category_id: null,
      general: 'Uncategorized',
      detail: 'Uncategorized',
    });
  });

  it('binds exclusion params correctly across both filters', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);

    await getCashflowForecastDataByCategory(3, [10, 11], [22]);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([10, 11, 22]);
  });
});
