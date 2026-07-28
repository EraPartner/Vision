import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../src/services/currency/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(),
}));

import { query } from '../../src/database/connection.js';
import { convertRowsToEur } from '../../src/services/currency/currencyConversionService.js';
import { computeSankeyFlow } from '../../src/services/calculations/aggregation/sankey.js';

beforeEach(() => {
  query.mockReset();
  convertRowsToEur.mockReset();
});

describe('computeSankeyFlow (SQL-grouped rows)', () => {
  it('builds income → category links and a savings node from grouped, multi-currency rows', async () => {
    // SQL now returns one row per (category, currency, is_income) with SUM(ABS).
    query.mockResolvedValueOnce({
      rows: [
        { category_name: 'Income: Salary', currency: 'EUR', is_income: true, amount: '1000' },
        { category_name: 'Income: Salary', currency: 'USD', is_income: true, amount: '100' },
        { category_name: 'Food: Groceries', currency: 'EUR', is_income: false, amount: '300' },
        { category_name: 'Housing: Rent', currency: 'EUR', is_income: false, amount: '400' },
      ],
    });
    // Latest-rate conversion: USD → ×0.9, EUR → ×1.
    convertRowsToEur.mockImplementation(async (rows) =>
      rows.map((r) => ({ ...r, amount_eur: r.currency === 'USD' ? r.amount * 0.9 : r.amount })),
    );

    const env = await computeSankeyFlow({ targetCurrency: 'EUR', year: 2025 });
    const { nodes, links } = env.data;

    // Income = 1000 + 100*0.9 = 1090; spending = 300 + 400 = 700; savings = 390.
    const income = nodes.find((n) => n.label === 'Income');
    expect(income.value).toBe(1090);
    const savings = nodes.find((n) => n.label === 'Savings / Unspent');
    expect(savings.value).toBe(390);

    const rentLink = links.find((l) => l.target === 'cat:Housing: Rent');
    expect(rentLink.value).toBe(400);
    // All links flow from the single income node.
    expect(links.every((l) => l.source === income.id)).toBe(true);

    // GROUP BY pushed into SQL (no per-transaction streaming).
    expect(query.mock.calls[0][0]).toContain('GROUP BY 1, 2, 3');
    expect(query.mock.calls[0][0]).toContain('SUM(ABS(t.amount))');
  });

  // The emitted SQL must resolve the effective category over all THREE levels
  // (own → recipient default → PRIMARY recipient's default), in the category
  // JOIN *and* in the exclusion clause. With the former 2-level resolution a
  // row recorded under an alias whose PRIMARY carries the default category
  // landed in "Uncategorised" and survived an exclusion of that same category.
  // Behavioural coverage lives in tests/aliasCategoryResolution.db.test.js.
  it('resolves the effective category over three levels in the join and the exclusion clause', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await computeSankeyFlow({ year: 2025, excludedCategoryIds: [7] });

    const sql = query.mock.calls[0][0];
    expect(sql).toContain('LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id');
    expect(sql).toContain(
      'LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id',
    );
    expect(sql).toContain(
      'AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id) != ALL($3)',
    );
  });
});
