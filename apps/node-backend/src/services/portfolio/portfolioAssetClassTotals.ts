/**
 * Per-asset-class and per-asset-group totals of a portfolio summary (ADR-216).
 *
 * The asset pages (Stocks/Crypto/Metals, Real Estate, Savings) and the
 * Portfolio allocation chart read these instead of summing holdings in the
 * browser. Every total is the Decimal sum of the rounded per-investment
 * figures the same response emits, so a page total always equals the sum of
 * the rows it shows.
 */

import {
  addAll,
  divide,
  multiply,
  roundMoney,
  subtract,
  toDecimal,
} from "../../lib/money.ts";
import type { InvestmentSummary } from "./portfolioSummaryService.ts";

const round2 = (value: Parameters<typeof roundMoney>[0]) =>
  roundMoney(value, 2);

/**
 * Asset groups shown as one page or allocation slice. Order is display order;
 * keys are stable identifiers the web app maps to its labels.
 */
export const ASSET_GROUPS = [
  { group: "stocks_etfs", assetClasses: ["stock", "etf"] },
  { group: "crypto", assetClasses: ["crypto"] },
  { group: "metals", assetClasses: ["metals"] },
  { group: "real_estate", assetClasses: ["real_estate"] },
  { group: "savings_bonds", assetClasses: ["savings", "bond"] },
] as const;

/** The per-investment figures the totals read. */
type TotalsInput = Pick<
  InvestmentSummary,
  | "asset_class"
  | "currentValue"
  | "totalBuyCost"
  | "gainLoss"
  | "realizedGain"
  | "unrealizedGain"
  | "totalIncome"
  | "totalDividends"
  | "totalInKindIncome"
  | "totalFees"
  | "totalTaxes"
  | "feesAndTaxes"
  | "totalAppreciation"
  | "propertyReturn"
  | "accruedInterest"
  | "projectedAnnualInterest"
  | "interestRate"
  | "monthlyRent"
  | "usedFallbackRate"
>;

function sum(rows: readonly TotalsInput[], pick: (row: TotalsInput) => number) {
  return round2(addAll(rows.map(pick)));
}

/** Totals of one set of investment summaries, all in the response currency. */
export function buildHoldingTotals(rows: readonly TotalsInput[]) {
  const value = addAll(rows.map((row) => row.currentValue));
  const weightedRate = value.gt(0)
    ? divide(
        addAll(rows.map((row) => multiply(row.interestRate, row.currentValue))),
        value,
      )
    : toDecimal(0);
  return {
    holdingCount: rows.length,
    totalPortfolioValue: round2(value),
    /** Gross buy cost, as `totals.totalInvested`. */
    totalInvested: sum(rows, (row) => row.totalBuyCost),
    totalGainLoss: sum(rows, (row) => row.gainLoss),
    totalRealizedGain: sum(rows, (row) => row.realizedGain),
    totalUnrealizedGain: sum(rows, (row) => row.unrealizedGain),
    totalIncome: sum(rows, (row) => row.totalIncome),
    totalDividends: sum(rows, (row) => row.totalDividends),
    totalInKindIncome: sum(rows, (row) => row.totalInKindIncome),
    totalFees: sum(rows, (row) => row.totalFees),
    totalTaxes: sum(rows, (row) => row.totalTaxes),
    totalFeesAndTaxes: sum(rows, (row) => row.feesAndTaxes),
    /** Σ (gainLoss − totalIncome): the unit-asset return without any income. */
    netReturnExcludingIncome: round2(
      addAll(rows.map((row) => subtract(row.gainLoss, row.totalIncome))),
    ),
    /** Σ (gainLoss − totalIncome + totalDividends): the return with dividends only. */
    netReturnWithDividends: round2(
      addAll(
        rows.map((row) =>
          addAll([subtract(row.gainLoss, row.totalIncome), row.totalDividends]),
        ),
      ),
    ),
    totalAppreciation: sum(rows, (row) => row.totalAppreciation),
    totalPropertyReturn: sum(rows, (row) => row.propertyReturn),
    totalAccruedInterest: sum(rows, (row) => row.accruedInterest),
    totalProjectedAnnualInterest: sum(
      rows,
      (row) => row.projectedAnnualInterest,
    ),
    /** Σ interestRate × currentValue / Σ currentValue; 0 without value. */
    valueWeightedInterestRate: roundMoney(weightedRate, 8),
    /** Σ of the rents that have a rate; see monthlyRentRateMissing. */
    estimatedMonthlyRent: sum(rows, (row) => row.monthlyRent ?? 0),
    monthlyRentRateMissing: rows.some((row) => row.monthlyRent === null),
    usedFallbackRate: rows.some((row) => row.usedFallbackRate === true),
  };
}
/** One entry per asset class present in `summaries`, in canonical class order. */
export function buildAssetClassTotals(summaries: readonly TotalsInput[]) {
  const byClass = new Map<string, TotalsInput[]>();
  for (const summary of summaries) {
    const rows = byClass.get(summary.asset_class);
    if (rows) rows.push(summary);
    else byClass.set(summary.asset_class, [summary]);
  }
  const order: string[] = ASSET_GROUPS.flatMap(
    (group) => group.assetClasses as readonly string[],
  );
  return [...byClass.entries()]
    .sort(([a], [b]) => rank(order, a) - rank(order, b) || a.localeCompare(b))
    .map(([assetClass, rows]) => ({ assetClass, ...buildHoldingTotals(rows) }));
}

/** Every asset group, zero totals included, in display order. */
export function buildAssetGroupTotals(summaries: readonly TotalsInput[]) {
  return ASSET_GROUPS.map(({ group, assetClasses }) => {
    const classes = new Set<string>(assetClasses);
    return {
      group,
      assetClasses: [...assetClasses],
      ...buildHoldingTotals(
        summaries.filter((summary) => classes.has(summary.asset_class)),
      ),
    };
  });
}

function rank(order: readonly string[], assetClass: string) {
  const index = order.indexOf(assetClass);
  return index === -1 ? order.length : index;
}
