import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from './helpers/mockLogger.js';

const mockQuery = vi.fn();

vi.mock('../src/database/connection.js', () => ({
  query: (...args) => mockQuery(...args),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import {
  detectCategoryOutliers,
  filterDismissedFindings,
  __clearCategoryOutlierCacheForTests,
} from '../src/services/categoryOutlierService.js';

/** Expense row as returned by the service's SELECT (pg NUMERIC = string). */
const row = (date, amount, categoryId = 1, categoryName = 'FOOD:GROCERIES') => ({
  date,
  amount,
  category_id: categoryId,
  category_name: categoryName,
});

/**
 * Six prior months (Jan–Jun 2026) with one windowed expense each on day 5.
 * Windowed totals [100, 105, 95, 108, 92, 100] → median 100, MAD 5.
 */
const jitteredPriorRows = (categoryId = 1, categoryName = 'FOOD:GROCERIES') => [
  row('2026-01-05', '-100.00', categoryId, categoryName),
  row('2026-02-05', '-105.00', categoryId, categoryName),
  row('2026-03-05', '-95.00', categoryId, categoryName),
  row('2026-04-05', '-108.00', categoryId, categoryName),
  row('2026-05-05', '-92.00', categoryId, categoryName),
  row('2026-06-05', '-100.00', categoryId, categoryName),
];

describe('detectCategoryOutliers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The service memoises raw findings in a short-TTL cache; clear it so each
    // case exercises its own mocked query result rather than a leftover one.
    __clearCategoryOutlierCacheForTests();
    // The algorithm windows every month to day 1..N where N = today's
    // day-of-month, so "today" must be deterministic: July 15, 2026 (local).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flags a clear overspend outlier with the modified z-score contract fields', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        // One prior-month row as a pg-style local-midnight Date object — the
        // service must handle both Dates and 'YYYY-MM-DD' strings.
        row('2026-01-05', '-100.00'),
        row('2026-02-05', '-105.00'),
        row('2026-03-05', '-95.00'),
        row('2026-04-05', '-108.00'),
        row('2026-05-05', '-92.00'),
        row(new Date(2026, 5, 5), '-100.00'),
        // Current month (day 10 ≤ window day 15): 400 vs median 100, MAD 5
        // → modified z = 0.6745 * 300 / 5 = 40.47
        row('2026-07-10', '-400.00'),
      ],
    });

    const findings = await detectCategoryOutliers();

    expect(findings).toEqual([
      {
        categoryId: 1,
        categoryName: 'FOOD:GROCERIES',
        monthKey: '2026-07',
        currentAmount: 400,
        baselineMedian: 100,
        deviation: 40.47,
        direction: 'increased',
      },
    ]);
  });

  it('does not flag a category within normal variation, nor an underspend', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        // Category 1: current 104 vs median 100, MAD 5 → z ≈ 0.54, well under 3.5
        ...jitteredPriorRows(1),
        row('2026-07-08', '-104.00', 1),
        // Category 2: massive UNDERspend (20 vs median ~200) must never flag —
        // only overspend "creep" is surfaced.
        row('2026-01-06', '-200.00', 2, 'TRANSPORT:FUEL'),
        row('2026-02-06', '-205.00', 2, 'TRANSPORT:FUEL'),
        row('2026-03-06', '-195.00', 2, 'TRANSPORT:FUEL'),
        row('2026-04-06', '-208.00', 2, 'TRANSPORT:FUEL'),
        row('2026-05-06', '-192.00', 2, 'TRANSPORT:FUEL'),
        row('2026-06-06', '-200.00', 2, 'TRANSPORT:FUEL'),
        row('2026-07-03', '-20.00', 2, 'TRANSPORT:FUEL'),
      ],
    });

    const findings = await detectCategoryOutliers();

    expect(findings).toEqual([]);
  });

  it('skips a category with fewer than 4 populated prior months', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        // Only Apr/May/Jun have spend inside the day-1..15 window.
        row('2026-04-05', '-100.00'),
        row('2026-05-05', '-100.00'),
        row('2026-06-05', '-100.00'),
        // March spent only AFTER day 15 — outside the like-for-like window,
        // so it does NOT count as a populated month.
        row('2026-03-20', '-100.00'),
        // A blatant overspend that would flag if the baseline were trusted.
        row('2026-07-10', '-500.00'),
      ],
    });

    const findings = await detectCategoryOutliers();

    expect(findings).toEqual([]);
  });

  it('applies the absolute euro floor when the MAD is near zero', async () => {
    // Perfectly flat history: every prior window exactly 100 → MAD 0. The
    // naive z-score would be infinite for any overspend, so the floor governs.
    const flatPriors = [
      row('2026-01-05', '-100.00'),
      row('2026-02-05', '-100.00'),
      row('2026-03-05', '-100.00'),
      row('2026-04-05', '-100.00'),
      row('2026-05-05', '-100.00'),
      row('2026-06-05', '-100.00'),
    ];

    // Overspend of 40 EUR: below the 50 EUR floor → NOT flagged.
    mockQuery.mockResolvedValueOnce({
      rows: [...flatPriors, row('2026-07-10', '-140.00')],
    });
    expect(await detectCategoryOutliers()).toEqual([]);

    // Overspend of 60 EUR: above the floor → flagged.
    __clearCategoryOutlierCacheForTests();
    mockQuery.mockResolvedValueOnce({
      rows: [...flatPriors, row('2026-07-10', '-160.00')],
    });
    const findings = await detectCategoryOutliers();

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      categoryId: 1,
      monthKey: '2026-07',
      currentAmount: 160,
      baselineMedian: 100,
      direction: 'increased',
    });
    expect(findings[0].deviation).toBeGreaterThan(3.5);
  });

  it('compares like-for-like windows — never a full prior month vs the partial current month', async () => {
    // Spending is split: ~155 in days 1..15 and another 150 on day 25 of every
    // prior month (full months ≈ 305). Today is July 15, current spend 158.
    // Like-for-like (day 1..15 windows [155,158,153,158,151,158], median
    // 156.5, MAD 1.5) → z ≈ 0.67: perfectly normal, must NOT flag. Comparing
    // the partial current month against FULL prior months would make it look
    // like an extreme deviation.
    mockQuery.mockResolvedValueOnce({
      rows: [
        row('2026-01-05', '-75.00'), row('2026-01-15', '-80.00'), row('2026-01-25', '-150.00'),
        row('2026-02-05', '-78.00'), row('2026-02-15', '-80.00'), row('2026-02-25', '-150.00'),
        row('2026-03-05', '-74.00'), row('2026-03-15', '-79.00'), row('2026-03-25', '-150.00'),
        row('2026-04-05', '-76.00'), row('2026-04-15', '-82.00'), row('2026-04-25', '-150.00'),
        row('2026-05-05', '-73.00'), row('2026-05-15', '-78.00'), row('2026-05-25', '-150.00'),
        row('2026-06-05', '-77.00'), row('2026-06-15', '-81.00'), row('2026-06-25', '-150.00'),
        // Current month through day 15 (day-15 row checks boundary inclusion)
        row('2026-07-04', '-80.00'), row('2026-07-15', '-78.00'),
      ],
    });

    const findings = await detectCategoryOutliers();

    expect(findings).toEqual([]);
  });

  it('suppresses a finding dismissed within the last 14 days', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [...jitteredPriorRows(1), row('2026-07-10', '-400.00')],
    });

    // Dismissed 3 days ago at the same deviation → suppressed.
    const suppressed = await detectCategoryOutliers({
      dismissRecords: [
        {
          categoryId: 1,
          monthKey: '2026-07',
          dismissedAt: new Date(2026, 6, 12).toISOString(),
          deviationAtDismiss: 40.47,
        },
      ],
    });
    expect(suppressed).toEqual([]);

    // A dismissal older than 14 days no longer suppresses (raw findings come
    // from the cache — no second query needed).
    const aged = await detectCategoryOutliers({
      dismissRecords: [
        {
          categoryId: 1,
          monthKey: '2026-07',
          dismissedAt: new Date(2026, 5, 25).toISOString(),
          deviationAtDismiss: 40.47,
        },
      ],
    });
    expect(aged).toHaveLength(1);
    expect(aged[0].monthKey).toBe('2026-07');
    // A dismissal of a DIFFERENT category never suppresses.
    const otherCategory = await detectCategoryOutliers({
      dismissRecords: [
        {
          categoryId: 99,
          monthKey: '2026-07',
          dismissedAt: new Date(2026, 6, 12).toISOString(),
          deviationAtDismiss: 40.47,
        },
      ],
    });
    expect(otherCategory).toHaveLength(1);
    // All three calls shared one cached raw computation.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('re-alerts when the deviation visibly exceeds deviationAtDismiss', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [...jitteredPriorRows(1), row('2026-07-10', '-400.00')],
    });

    // Dismissed 3 days ago at a much lower deviation (10) — the current 40.47
    // visibly exceeds it → re-alert despite the fresh dismissal.
    const realerted = await detectCategoryOutliers({
      dismissRecords: [
        {
          categoryId: 1,
          monthKey: '2026-07',
          dismissedAt: new Date(2026, 6, 12).toISOString(),
          deviationAtDismiss: 10,
        },
      ],
    });
    expect(realerted).toHaveLength(1);
    expect(realerted[0].deviation).toBe(40.47);

    // Within the re-alert margin (40.47 < 40.4 + 0.5) → still suppressed.
    const withinMargin = await detectCategoryOutliers({
      dismissRecords: [
        {
          categoryId: 1,
          monthKey: '2026-07',
          dismissedAt: new Date(2026, 6, 12).toISOString(),
          deviationAtDismiss: 40.4,
        },
      ],
    });
    expect(withinMargin).toEqual([]);
  });

  it('serves cached raw findings within the TTL without re-querying', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [...jitteredPriorRows(1), row('2026-07-10', '-400.00')],
    });

    const first = await detectCategoryOutliers();
    const callsAfterFirst = mockQuery.mock.calls.length;

    const second = await detectCategoryOutliers();

    // Suppression runs outside the cache, so the arrays are fresh copies —
    // but the content matches and no additional DB round-trip happened.
    expect(second).toEqual(first);
    expect(mockQuery.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('filterDismissedFindings', () => {
  const finding = {
    categoryId: 1,
    categoryName: 'FOOD:GROCERIES',
    monthKey: '2026-07',
    currentAmount: 400,
    baselineMedian: 100,
    deviation: 5,
    direction: 'increased',
  };
  const now = new Date(2026, 6, 15, 12, 0, 0);

  it('passes findings through untouched when there are no dismiss records', () => {
    expect(filterDismissedFindings([finding], [], now)).toEqual([finding]);
  });

  it('uses the most recent dismissal when several target the same key', () => {
    // Older record would re-alert (deviation 5 ≥ 1 + margin), but the LATEST
    // record was dismissed at the current deviation → suppressed.
    const result = filterDismissedFindings(
      [finding],
      [
        { categoryId: 1, monthKey: '2026-07', dismissedAt: new Date(2026, 6, 10).toISOString(), deviationAtDismiss: 1 },
        { categoryId: 1, monthKey: '2026-07', dismissedAt: new Date(2026, 6, 14).toISOString(), deviationAtDismiss: 5 },
      ],
      now
    );
    expect(result).toEqual([]);
  });

  it('ignores malformed dismiss records instead of throwing', () => {
    const result = filterDismissedFindings(
      [finding],
      [null, { categoryId: 1, monthKey: '2026-07', dismissedAt: 'not-a-date', deviationAtDismiss: 5 }],
      now
    );
    expect(result).toEqual([finding]);
  });
});
