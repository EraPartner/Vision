/**
 * Financial data fetcher for PDF report generation.
 *
 * Fetches all data sources in parallel using Promise.allSettled so a single
 * failing source does not abort the entire report. Each source returns null
 * on failure; section renderers handle null gracefully.
 */

import { computeMonthlySummary } from '../calculations/aggregation/monthly.js';
import { computeCategoryBreakdown } from '../calculations/aggregation/category.js';
import { computeRecipientInsights } from '../calculations/aggregation/recipient.js';
import { computeBankBalances } from '../calculations/aggregation/bankBalances.js';
import { computeAverageVsCurrent } from '../calculations/aggregation/averageVsCurrent.js';
import infoRepository from '../../repositories/infoRepository.js';
import { logger } from '../../config/logger.js';

/**
 * @typedef {{ kind: 'ytd' }
 *   | { kind: 'rolling'; months: number }
 *   | { kind: 'custom'; from: string; to: string }
 *   | { kind: 'year'; year: number }
 * } Period
 */

/**
 * Unwrap a settled Promise result; log and return null on rejection.
 *
 * @template T
 * @param {PromiseSettledResult<T>} result
 * @param {string} label
 * @returns {T | null}
 */
function unwrap(result, label) {
  if (result.status === 'fulfilled') return result.value;
  logger.warn(`[dataFetcher] ${label} failed — section will be skipped`, { reason: result.reason?.message });
  return null;
}

/**
 * Fetch all data required for a financial PDF report in parallel.
 *
 * @param {string} currency  Target currency (e.g. "EUR")
 * @returns {Promise<{
 *   monthly: { months: object[]; summary: object } | null;
 *   categories: { categories: object[] } | null;
 *   recipients: { topMerchants: object[]; monthOverMonth: object[] } | null;
 *   banks: { accounts: object[]; total_net_position: number; history: object; total_history: object[] } | null;
 *   averages: { past_6_months: object; current_month: object; comparison: object } | null;
 *   planned: { summary: object; daily_data: object[] } | null;
 * }>}
 */
export async function fetchFinancialData(currency) {
  const [monthly, categories, recipients, banks, averages, planned] = await Promise.allSettled([
    computeMonthlySummary({ targetCurrency: currency, allTime: true }),
    computeCategoryBreakdown({ targetCurrency: currency }),
    computeRecipientInsights({ targetCurrency: currency }),
    computeBankBalances({ targetCurrency: currency }),
    computeAverageVsCurrent({ targetCurrency: currency }),
    infoRepository.getPlannedExpensesNextMonth(currency),
  ]);

  return {
    // Aggregation wrappers return { data, meta } — unwrap .data
    monthly: unwrap(monthly, 'computeMonthlySummary')?.data ?? null,
    categories: unwrap(categories, 'computeCategoryBreakdown')?.data ?? null,
    recipients: unwrap(recipients, 'computeRecipientInsights')?.data ?? null,
    banks: unwrap(banks, 'computeBankBalances')?.data ?? null,
    averages: unwrap(averages, 'computeAverageVsCurrent')?.data ?? null,
    // plannedRepository returns raw data (no envelope)
    planned: unwrap(planned, 'getPlannedExpensesNextMonth'),
  };
}

/**
 * Filter a months array to the rows that fall within a given period.
 * Each month entry must have `year` (number) and `month` (1-based number) fields.
 *
 * @param {object[]} months
 * @param {Period} period
 * @returns {object[]}
 */
export function filterMonthsByPeriod(months, period) {
  if (!months?.length) return [];
  const now = new Date();

  switch (period.kind) {
    case 'ytd':
      return months.filter(m => m.year === now.getFullYear());

    case 'rolling': {
      const cutoff = new Date(now.getFullYear(), now.getMonth() - period.months + 1, 1);
      return months.filter(m => new Date(m.year, m.month - 1, 1) >= cutoff);
    }

    case 'custom': {
      const from = new Date(period.from);
      const to = new Date(period.to);
      return months.filter(m => {
        const mStart = new Date(m.year, m.month - 1, 1);
        const mEnd = new Date(m.year, m.month, 0);
        return mEnd >= from && mStart <= to;
      });
    }

    case 'year':
      return months.filter(m => m.year === period.year);

    default:
      return months;
  }
}
