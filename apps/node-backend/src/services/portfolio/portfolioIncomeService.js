/**
 * Portfolio income & FIRE coverage (ADR-096) — descriptive statistics only.
 *
 * Pure aggregations over the per-investment summaries the portfolio service
 * already produces (ADR-044 / ADR-073). These READ budgeting's spending number
 * but must NEVER feed Planned Transactions or the cash-flow forecast.
 */

import { toDecimal, toNumber, roundToCents } from '../../lib/money.js';

/**
 * Aggregate income across per-investment summaries.
 *   realized          = Σ totalIncome (dividends + interest + rent for the period)
 *   projectedAnnual   = Σ projectedAnnualInterest (fixed-income declared yield).
 *                       Unit-based dividend projection needs a per-holding yield;
 *                       absent one it contributes 0 (realized is still counted).
 *
 * @param {Array<{ totalIncome?: number|string, projectedAnnualInterest?: number|string }>} summaries
 * @returns {{ realizedIncome: number, projectedAnnualIncome: number }}
 */
 function aggregateIncome(summaries) {
  let realized = toDecimal(0);
  let projected = toDecimal(0);
  for (const s of summaries ?? []) {
    realized = realized.plus(toDecimal(s.totalIncome ?? 0));
    projected = projected.plus(toDecimal(s.projectedAnnualInterest ?? 0));
  }
  return {
    realizedIncome: toNumber(roundToCents(realized)),
    projectedAnnualIncome: toNumber(roundToCents(projected)),
  };
}

/**
 * FIRE coverage ratio = annual passive income / annual spending.
 * Returns null when annualSpending is non-positive (ratio undefined).
 *
 * @param {number} annualPassiveIncome
 * @param {number} annualSpending
 * @returns {number|null}
 */
 function coverageRatio(annualPassiveIncome, annualSpending) {
  const spend = toDecimal(annualSpending ?? 0);
  if (spend.lte(0)) return null;
  return toNumber(toDecimal(annualPassiveIncome ?? 0).dividedBy(spend));
}

export { aggregateIncome as __aggregateIncome, coverageRatio as __coverageRatio };
