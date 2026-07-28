/**
 * Transaction-derived Belgian deduction candidates for a calendar year.
 *
 * Single source of truth for the classify-and-aggregate step shared by the
 * getDeductibles AI-chat tool and GET /api/info/deduction-candidates (the Tax
 * Overview review card). It scans the year's active outflow transactions,
 * classifies each user category via the explicit name-based classifier
 * (deductionClassifier.js — precision over recall, unrecognized categories are
 * excluded) and rolls the matches up per deduction type WITH the contributing
 * categories nested under each type, which the review UI needs to show where a
 * candidate total comes from.
 *
 * Pure with respect to time: `year` is always provided by the caller (routes
 * default it to the current calendar year; the AI tool requires it), so this
 * module never reads the clock.
 */

import { parseCategoryName } from '@vision/shared-utils';
import { transactionRepository } from '../../repositories/transactionRepository.js';
import { toDecimal, roundToCents } from '../../lib/money.js';
import { classifyDeduction } from './deductionClassifier.js';

/** A decimal.js money value, as produced by the shared `toDecimal` helper. */
/** @typedef {ReturnType<typeof toDecimal>} Money */

/**
 * Compute per-deduction-type candidate totals for one calendar year.
 *
 * @param {{ year: number }} params - validated calendar year (the caller is
 *   responsible for validation/defaulting).
 * @returns {Promise<{
 *   year: number,
 *   from: string,
 *   to: string,
 *   currency: 'EUR',
 *   byDeductionType: Array<{
 *     deductionType: string,
 *     total: number,
 *     categoryCount: number,
 *     categories: Array<{ category: string, total: number, count: number }>,
 *   }>,
 * }>} groups sorted by total desc; nested categories sorted by total desc.
 */
export async function computeDeductionCandidates({ year }) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const rows = await transactionRepository.getAll({
    startDate: from,
    endDate: to,
    limit: 100_000,
    offset: 0,
    active: true,
  });

  // Pass 1: group outflows by raw category name, classifying each category.
  /** @type {Map<string, { category: string, deductionType: string, total: Money, count: number }>} */
  const byCategory = new Map();
  for (const row of rows) {
    const amount = toDecimal(row.amount ?? 0);
    if (amount.gte(0)) continue; // outflows only

    if (!row.category_name) continue;
    const { general, detail } = parseCategoryName(row.category_name);
    const deductionType = classifyDeduction(general, detail);
    if (!deductionType) continue; // not a recognized deductible

    const key = row.category_name;
    const entry = byCategory.get(key) || {
      category: key,
      deductionType,
      total: toDecimal(0),
      count: 0,
    };
    entry.total = entry.total.plus(amount.abs());
    entry.count += 1;
    byCategory.set(key, entry);
  }

  // Pass 2: roll categories up per deduction type, keeping the contributors
  // nested (totals stay Decimal until the final rounding).
  /** @type {Map<string, { total: Money, categories: Array<{ category: string, total: number, count: number }> }>} */
  const typeAgg = new Map();
  for (const entry of byCategory.values()) {
    const agg = typeAgg.get(entry.deductionType) || { total: toDecimal(0), categories: [] };
    agg.total = agg.total.plus(entry.total);
    agg.categories.push({
      category: entry.category,
      total: roundToCents(entry.total).toNumber(),
      count: entry.count,
    });
    typeAgg.set(entry.deductionType, agg);
  }

  const byDeductionType = Array.from(typeAgg.entries())
    .map(([deductionType, agg]) => ({
      deductionType,
      total: roundToCents(agg.total).toNumber(),
      categoryCount: agg.categories.length,
      categories: agg.categories.sort((a, b) => b.total - a.total),
    }))
    .sort((a, b) => b.total - a.total);

  return { year, from, to, currency: 'EUR', byDeductionType };
}
