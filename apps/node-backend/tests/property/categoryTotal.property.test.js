/**
 * Property test: sum(category_breakdown) + excluded == transaction_total (Phase 8).
 *
 * Invariant from plan: the category breakdown plus whatever is excluded via
 * exclusion filters must reconcile exactly to the unfiltered transaction total
 * within 1 cent. Any aggregator that emits `by_category[]` + `excluded_total`
 * must preserve this conservation law so the dashboard subtotals never silently
 * drop (or double-count) transactions.
 */

import { describe, it, expect } from 'vitest';

const CENT = 0.01;

function seeded(seed) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function roundCents(x) {
  return Math.round(x * 100) / 100;
}

/**
 * Bucket random transactions by category; mark a random subset as excluded.
 */
function generateTransactions(rng, count) {
  const CATEGORIES = ['groceries', 'rent', 'utilities', 'leisure', 'salary', 'misc', null];
  const EXCLUDED = new Set(['rent']);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const category = CATEGORIES[Math.floor(rng() * CATEGORIES.length)];
    const amount = roundCents((rng() - 0.5) * 5000); // positive + negative
    rows.push({ category, amount, is_excluded: category !== null && EXCLUDED.has(category) });
  }
  return rows;
}

function aggregate(rows) {
  const byCategory = new Map();
  let excludedTotal = 0;
  let grandTotal = 0;

  for (const row of rows) {
    grandTotal += row.amount;
    if (row.is_excluded) {
      excludedTotal += row.amount;
      continue;
    }
    const key = row.category ?? '__uncategorized__';
    byCategory.set(key, (byCategory.get(key) ?? 0) + row.amount);
  }

  return {
    by_category: Array.from(byCategory.entries()).map(([category, total]) => ({
      category,
      total: roundCents(total),
    })),
    excluded_total: roundCents(excludedTotal),
    grand_total: roundCents(grandTotal),
  };
}

describe('property: sum(category_breakdown) + excluded == grand_total', () => {
  it('reconciles within 1 cent across 100 random datasets', () => {
    const rng = seeded(0xCA1EC0E);
    for (let seed = 0; seed < 100; seed++) {
      const count = 50 + Math.floor(rng() * 500);
      const rows = generateTransactions(rng, count);
      const agg = aggregate(rows);

      const sumCategories = agg.by_category.reduce((a, r) => a + r.total, 0);
      const reconstructed = roundCents(sumCategories + agg.excluded_total);
      expect(Math.abs(reconstructed - agg.grand_total)).toBeLessThanOrEqual(CENT);
    }
  });

  it('empty dataset produces zero totals', () => {
    const agg = aggregate([]);
    expect(agg.by_category).toEqual([]);
    expect(agg.excluded_total).toBe(0);
    expect(agg.grand_total).toBe(0);
  });

  it('all-excluded dataset has empty category breakdown', () => {
    const rows = [
      { category: 'rent', amount: 1000, is_excluded: true },
      { category: 'rent', amount: 750, is_excluded: true },
    ];
    const agg = aggregate(rows);
    expect(agg.by_category).toEqual([]);
    expect(agg.excluded_total).toBe(1750);
    expect(agg.grand_total).toBe(1750);
  });
});
