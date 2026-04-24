/**
 * Dev-mode invariant assertions for aggregation calc modules (Phase 8).
 *
 * These run only in non-production environments. When an invariant fails the
 * function logs a warning — it never throws, since these are observational
 * sanity checks, not hard validation gates.
 *
 * Usage: import { assertNaN, assertMonthlyInvariants } from './_invariants.js';
 */

import settings from '../../../config/config.js';
import { logger } from '../../../config/logger.js';

const ENABLED = !settings.isProduction();

/**
 * Recursively walk a value and collect dotted paths where a number is NaN or
 * non-finite. Returns an empty array when all numerics are valid.
 *
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} out
 */
function collectBadNumerics(value, path, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}=${value}`);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) collectBadNumerics(value[i], `${path}[${i}]`, out);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      collectBadNumerics(v, path ? `${path}.${k}` : k, out);
    }
  }
}

/**
 * Assert that no numeric leaf in `data` is NaN or non-finite.
 *
 * @param {unknown} data
 * @param {string} context  e.g. 'computeMonthlySummary'
 */
export function assertNoNaN(data, context) {
  if (!ENABLED) return;
  const bad = [];
  collectBadNumerics(data, '', bad);
  if (bad.length > 0) {
    logger.warn(`[invariant] ${context}: non-finite numeric(s) detected`, { paths: bad });
  }
}

/**
 * Assert monthly-specific invariant: for each month,
 * |net_amount - (total_income + total_spending)| < 0.01.
 *
 * net_amount is stored as income + spending (spending is negative), so this
 * catches any rounding drift in the accumulation loop.
 *
 * @param {Array<{ month: number, year: number, total_income: number, total_spending: number, net_amount: number }>} months
 */
export function assertMonthlyInvariants(months) {
  if (!ENABLED || !Array.isArray(months)) return;
  for (const m of months) {
    const expected = (m.total_income ?? 0) + (m.total_spending ?? 0);
    const delta = Math.abs((m.net_amount ?? 0) - expected);
    if (delta > 0.01) {
      logger.warn('[invariant] computeMonthlySummary: net_amount drift', {
        year: m.year, month: m.month, net_amount: m.net_amount, expected, delta,
      });
    }
  }
}

/**
 * Assert category-specific invariant: each category total is finite and
 * there are no duplicate category ids.
 *
 * @param {Array<{ id: number|null, name: string, count: number, total: number }>} categories
 */
export function assertCategoryInvariants(categories) {
  if (!ENABLED || !Array.isArray(categories)) return;
  const seen = new Set();
  for (const cat of categories) {
    if (!Number.isFinite(cat.total)) {
      logger.warn('[invariant] computeCategoryBreakdown: non-finite total', { id: cat.id, name: cat.name, total: cat.total });
    }
    const key = cat.id ?? 'null';
    if (seen.has(key)) {
      logger.warn('[invariant] computeCategoryBreakdown: duplicate category id', { id: cat.id });
    }
    seen.add(key);
  }
}
