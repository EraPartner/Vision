import {
  buildInvestmentSummaryCorePartitioned,
  type CostBasisMethod,
} from "@vision/shared-utils/portfolio";
import { multiply, divide, toNumber } from "../../lib/money.ts";
import type { DecimalInput } from "../../lib/money.ts";
import type {
  AnnotatedTxRow,
  InvestmentSummary,
  RawInvestmentRow,
} from "./portfolioSummaryService.ts";
import { asPartitionedTxns } from "./portfolioTransactionRules.ts";

/** Existing usePortfolioSummaries archive presentation. Ordinary history uses the latest stored
 * quote FX (a currency without a stored rate stays unconverted and sets usedFallbackRate),
 * while in-kind descriptive income keeps the canonical dated figure. Do not replace this with
 * canonical P&L during the frontend migration. */
export function buildArchivedPortfolioPresentation(
  investments: RawInvestmentRow[],
  transactions: AnnotatedTxRow[],
  canonical: InvestmentSummary[],
  multipliers: Map<string, number>,
  currenciesWithoutRate: ReadonlySet<string>,
  costBasisMethod: CostBasisMethod,
  todayYmd: string,
) {
  const canonicalById = new Map(canonical.map((s) => [s.id, s]));
  return investments
    .filter((inv) => !inv.is_active)
    .map((inv) => {
      const txns = transactions
        .filter((t) => Number(t.investment_id) === Number(inv.id))
        .sort(
          (a, b) =>
            String(b.date).localeCompare(String(a.date)) ||
            Number(b.id) - Number(a.id),
        )
        .slice(0, 1000);
      const { core, fullyAssigned } = buildInvestmentSummaryCorePartitioned(
        inv,
        asPartitionedTxns(txns),
        { costBasisMethod, todayYmd },
      );
      const current = canonicalById.get(Number(inv.id))!;
      const invCurrency = (inv.currency || "EUR").toUpperCase();
      const conv = (value: DecimalInput) =>
        toNumber(multiply(value, multipliers.get(invCurrency) ?? 1));
      return {
        ...current,
        totalUnits: toNumber(core.totalUnits),
        totalInvested: conv(core.totalInvested),
        totalFees: conv(core.totalFees),
        totalTaxes: conv(core.totalTaxes),
        feeTransactions: conv(core.feeTxnAmount),
        taxTransactions: conv(core.taxTxnAmount),
        totalDividends: conv(core.totalDividends),
        totalIncome: conv(core.totalIncome),
        currentValue: conv(core.currentValue),
        currentPrice: conv(Number(inv.current_price) || 0),
        current_price: Number(inv.current_price) || 0,
        nativeCurrentPrice: Number(inv.current_price) || 0,
        nativeAvgCostBasis: toNumber(core.avgCostBasis),
        unrealizedGainPercent: multiply(core.avgCostBasis, core.totalUnits).gt(
          0,
        )
          ? divide(
              core.unrealizedGain,
              multiply(core.avgCostBasis, core.totalUnits),
            )
              .times(100)
              .toNumber()
          : 0,
        estimatedMonthlyRent:
          Number(txns.find((t) => t.type === "rent_income")?.amount) || 0,
        avgCostBasis: conv(core.avgCostBasis),
        realizedGain: conv(core.realizedGain),
        unrealizedGain: conv(core.unrealizedGain),
        totalGain: conv(core.totalGain),
        gainLoss: conv(core.gainLoss),
        gainLossPercent: toNumber(core.gainLossPercent),
        accruedInterest: conv(core.accruedInterest),
        projectedAnnualInterest: conv(core.projectedAnnualInterest),
        totalAppreciation: conv(core.totalAppreciation),
        totalBuyCost: conv(core.totalBuyCost),
        totalSellProceeds: conv(core.totalSellProceeds),
        fullyAssigned,
        oversold: core.oversold,
        summarySource: "local" as const,
        assetGain: undefined,
        fxGain: undefined,
        nativeCurrentValue: undefined,
        usedFallbackRate: currenciesWithoutRate.has(invCurrency)
          ? true
          : undefined,
        transactionCount: txns.length,
        // byAccount retains the separate canonical broker snapshot, just as detail API reads do.
        totalInKindIncome: current.totalInKindIncome,
      };
    });
}
