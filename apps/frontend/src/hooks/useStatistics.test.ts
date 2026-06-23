import { describe, expect, it } from 'vitest';
import { mapToStatisticsData } from './useStatistics';

// ── Fixture builders ──────────────────────────────────────────────────────────

function monthlySummary(
  months: Array<{
    year: number;
    month: number;
    total_income: number;
    total_spending: number;
    net_amount: number;
    transaction_count?: number;
  }>,
) {
  return {
    months: months.map((m) => ({
      ...m,
      period_start: `${m.year}-${String(m.month).padStart(2, '0')}-01`,
      period_end: `${m.year}-${String(m.month).padStart(2, '0')}-28`,
      transaction_count: m.transaction_count ?? 1,
    })),
    summary: { total_spending: 0, total_income: 0, net_amount: 0, transaction_count: 0, period_start: '', period_end: '' },
  };
}

function categoryPivot(entries: Record<string, Array<{ categoryId: number | null; categoryName: string; total: number; income?: number; expense?: number; transactionCount?: number }>>) {
  return {
    categoryPivot: Object.fromEntries(
      Object.entries(entries).map(([period, items]) => [
        period,
        items.map((i) => ({ ...i, transactionCount: i.transactionCount ?? 1 })),
      ]),
    ),
  };
}

function recipientInsights(
  topMerchants: Array<{ recipientId: number; name: string; totalSpend: number; transactionCount?: number }>,
) {
  return {
    topMerchants: topMerchants.map((m) => ({
      ...m,
      avgAmount: 0,
      firstSeen: '2026-01-01',
      lastSeen: '2026-12-31',
      transactionCount: m.transactionCount ?? 1,
    })),
    monthOverMonth: [],
  };
}

function recipientByYear(entries: Record<string, Array<{ recipientId: number; name: string; totalSpend: number; transactionCount?: number }>>) {
  return {
    recipientsByYear: Object.fromEntries(
      Object.entries(entries).map(([year, recs]) => [
        year,
        recs.map((r) => ({ ...r, transactionCount: r.transactionCount ?? 1 })),
      ]),
    ),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('mapToStatisticsData', () => {
  it('returns zeros for empty dataset', () => {
    const result = mapToStatisticsData(
      monthlySummary([]),
      categoryPivot({}),
      recipientInsights([]),
      recipientByYear({}),
    );
    expect(result.monthlyData).toHaveLength(0);
    expect(result.categoryPivot).toHaveLength(0);
    expect(result.topRecipients).toHaveLength(0);
    expect(result.topRecipientsByYear).toEqual({});
    expect(result.yearlyComparison).toHaveLength(0);
    expect(result.totalIncome).toBe(0);
    expect(result.totalSpending).toBe(0);
  });

  it('maps total_spending negative to positive spending field', () => {
    const result = mapToStatisticsData(
      monthlySummary([{ year: 2026, month: 1, total_income: 1000, total_spending: -400, net_amount: 600 }]),
      categoryPivot({}),
      recipientInsights([]),
      recipientByYear({}),
    );
    const m = result.monthlyData[0];
    expect(m.income).toBe(1000);
    expect(m.spending).toBe(400);
    expect(m.net).toBe(600);
    expect(result.totalIncome).toBe(1000);
    expect(result.totalSpending).toBe(400);
  });

  it('sorts monthlyData by period ascending', () => {
    const result = mapToStatisticsData(
      monthlySummary([
        { year: 2026, month: 3, total_income: 0, total_spending: -30, net_amount: -30 },
        { year: 2026, month: 1, total_income: 0, total_spending: -10, net_amount: -10 },
        { year: 2026, month: 2, total_income: 0, total_spending: -20, net_amount: -20 },
      ]),
      categoryPivot({}),
      recipientInsights([]),
      recipientByYear({}),
    );
    expect(result.monthlyData.map((m) => m.period)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('derives yearlyComparison from monthlyData', () => {
    const result = mapToStatisticsData(
      monthlySummary([
        { year: 2025, month: 12, total_income: 1000, total_spending: -200, net_amount: 800, transaction_count: 5 },
        { year: 2026, month: 1, total_income: 1200, total_spending: -400, net_amount: 800, transaction_count: 8 },
        { year: 2026, month: 2, total_income: 1100, total_spending: -300, net_amount: 800, transaction_count: 6 },
      ]),
      categoryPivot({}),
      recipientInsights([]),
      recipientByYear({}),
    );
    const y2025 = result.yearlyComparison.find((y) => y.year === 2025)!;
    const y2026 = result.yearlyComparison.find((y) => y.year === 2026)!;
    expect(y2025.totalIncome).toBe(1000);
    expect(y2025.totalSpending).toBe(200);
    expect(y2025.transactionCount).toBe(5);
    expect(y2026.totalIncome).toBe(2300);
    expect(y2026.totalSpending).toBe(700);
    expect(y2026.transactionCount).toBe(14);
    expect(result.yearlyComparison.map((y) => y.year)).toEqual([2025, 2026]);
  });

  it('computes averageMonthlySpending and averageMonthlyIncome', () => {
    const result = mapToStatisticsData(
      monthlySummary([
        { year: 2026, month: 1, total_income: 1000, total_spending: -400, net_amount: 600 },
        { year: 2026, month: 2, total_income: 1200, total_spending: -600, net_amount: 600 },
      ]),
      categoryPivot({}),
      recipientInsights([]),
      recipientByYear({}),
    );
    expect(result.averageMonthlySpending).toBe(500);
    expect(result.averageMonthlyIncome).toBe(1100);
  });

  describe('categoryPivot mapping', () => {
    it('accumulates absTotal, expenseTotal, incomeTotal, netTotal across periods', () => {
      const result = mapToStatisticsData(
        monthlySummary([]),
        categoryPivot({
          '2026-01': [
            { categoryId: 1, categoryName: 'Food: Groceries', total: 100 },  // income
            { categoryId: 1, categoryName: 'Food: Groceries', total: -40 },  // expense
          ],
          '2026-02': [
            { categoryId: 1, categoryName: 'Food: Groceries', total: -30 },  // expense
          ],
        }),
        recipientInsights([]),
        recipientByYear({}),
      );
      const food = result.categoryPivot.find((c) => c.categoryId === 1)!;
      expect(food).toBeDefined();
      expect(food.total).toBe(170);       // 100 + 40 + 30
      expect(food.incomeTotal).toBe(100);
      expect(food.expenseTotal).toBe(70);
      expect(food.netTotal).toBe(30);     // 100 - 40 - 30
    });

    it('uses explicit income/expense for a mixed-sign month (not the net sign)', () => {
      const result = mapToStatisticsData(
        monthlySummary([]),
        categoryPivot({
          // −300 purchases + 500 refund: net +200, but income 500 / expense 300.
          '2026-01': [{ categoryId: 1, categoryName: 'Food: Groceries', total: 200, income: 500, expense: -300 }],
        }),
        recipientInsights([]),
        recipientByYear({}),
      );
      const food = result.categoryPivot.find((c) => c.categoryId === 1)!;
      expect(food.incomeMonths['2026-01']).toBe(500); // not 200 (the net)
      expect(food.expenseMonths['2026-01']).toBe(300); // not 0
      expect(food.netMonths['2026-01']).toBe(200);
      expect(food.months['2026-01']).toBe(200); // absolute column = |net|
    });

    it('tracks per-period income, expense, net, and abs months', () => {
      const result = mapToStatisticsData(
        monthlySummary([]),
        categoryPivot({
          '2026-01': [{ categoryId: 1, categoryName: 'Food: Groceries', total: -40 }],
          '2026-02': [{ categoryId: 1, categoryName: 'Food: Groceries', total: -30 }],
        }),
        recipientInsights([]),
        recipientByYear({}),
      );
      const food = result.categoryPivot.find((c) => c.categoryId === 1)!;
      expect(food.expenseMonths['2026-01']).toBe(40);
      expect(food.expenseMonths['2026-02']).toBe(30);
      expect(food.incomeMonths['2026-01']).toBe(0);
      expect(food.months['2026-01']).toBe(40);
      expect(food.netMonths['2026-01']).toBe(-40);
    });

    it('handles null categoryId', () => {
      const result = mapToStatisticsData(
        monthlySummary([]),
        categoryPivot({
          '2026-01': [{ categoryId: null, categoryName: 'Uncategorized', total: -50 }],
        }),
        recipientInsights([]),
        recipientByYear({}),
      );
      const uncategorized = result.categoryPivot.find((c) => c.categoryId === null)!;
      expect(uncategorized).toBeDefined();
      expect(uncategorized.expenseTotal).toBe(50);
    });

    it('sorts categoryPivot by total descending', () => {
      const result = mapToStatisticsData(
        monthlySummary([]),
        categoryPivot({
          '2026-01': [
            { categoryId: 1, categoryName: 'Small', total: -10 },
            { categoryId: 2, categoryName: 'Large', total: -100 },
          ],
        }),
        recipientInsights([]),
        recipientByYear({}),
      );
      expect(result.categoryPivot[0].categoryId).toBe(2);
      expect(result.categoryPivot[1].categoryId).toBe(1);
    });
  });

  describe('topRecipients', () => {
    it('maps topMerchants to topRecipients', () => {
      const result = mapToStatisticsData(
        monthlySummary([]),
        categoryPivot({}),
        recipientInsights([
          { recipientId: 1, name: 'Store A', totalSpend: 400, transactionCount: 5 },
          { recipientId: 2, name: 'Store B', totalSpend: 200, transactionCount: 3 },
        ]),
        recipientByYear({}),
      );
      expect(result.topRecipients).toHaveLength(2);
      expect(result.topRecipients[0]).toEqual({ name: 'Store A', total: 400, count: 5 });
      expect(result.topRecipients[1]).toEqual({ name: 'Store B', total: 200, count: 3 });
    });

    it('slices to at most 20 recipients', () => {
      const merchants = Array.from({ length: 25 }, (_, i) => ({
        recipientId: i + 1,
        name: `Store ${i + 1}`,
        totalSpend: 100 - i,
        transactionCount: 1,
      }));
      const result = mapToStatisticsData(
        monthlySummary([]),
        categoryPivot({}),
        recipientInsights(merchants),
        recipientByYear({}),
      );
      expect(result.topRecipients).toHaveLength(20);
    });
  });

  describe('topRecipientsByYear', () => {
    it('maps recipientsByYear keyed by year string', () => {
      const result = mapToStatisticsData(
        monthlySummary([]),
        categoryPivot({}),
        recipientInsights([]),
        recipientByYear({
          '2026': [{ recipientId: 1, name: 'Store A', totalSpend: 400, transactionCount: 5 }],
          '2025': [{ recipientId: 2, name: 'Store B', totalSpend: 200, transactionCount: 3 }],
        }),
      );
      expect(result.topRecipientsByYear['2026']).toHaveLength(1);
      expect(result.topRecipientsByYear['2026'][0]).toEqual({ name: 'Store A', total: 400, count: 5 });
      expect(result.topRecipientsByYear['2025'][0]).toEqual({ name: 'Store B', total: 200, count: 3 });
    });
  });

  it('populates allPeriods and allYears correctly', () => {
    const result = mapToStatisticsData(
      monthlySummary([
        { year: 2025, month: 12, total_income: 0, total_spending: 0, net_amount: 0 },
        { year: 2026, month: 1, total_income: 0, total_spending: 0, net_amount: 0 },
      ]),
      categoryPivot({}),
      recipientInsights([]),
      recipientByYear({}),
    );
    expect(result.allPeriods).toEqual(['2025-12', '2026-01']);
    expect(result.allYears).toEqual([2025, 2026]);
  });

  it('does not mutate input payloads', () => {
    const ms = monthlySummary([{ year: 2026, month: 1, total_income: 1000, total_spending: -400, net_amount: 600 }]);
    const cp = categoryPivot({ '2026-01': [{ categoryId: 1, categoryName: 'Food', total: -40 }] });
    const ri = recipientInsights([{ recipientId: 1, name: 'A', totalSpend: 100 }]);
    const rby = recipientByYear({ '2026': [{ recipientId: 1, name: 'A', totalSpend: 100 }] });
    const msSnapshot = JSON.stringify(ms);
    const cpSnapshot = JSON.stringify(cp);
    mapToStatisticsData(ms, cp, ri, rby);
    expect(JSON.stringify(ms)).toBe(msSnapshot);
    expect(JSON.stringify(cp)).toBe(cpSnapshot);
  });
});
