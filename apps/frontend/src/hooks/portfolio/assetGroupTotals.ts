import type {
    PortfolioHoldingTotals,
    PortfolioSummaryResponse,
} from "@/lib/api/info";

/** Shown while the summary is loading or holds no matching group. */
export const EMPTY_HOLDING_TOTALS: PortfolioHoldingTotals = {
    holdingCount: 0,
    totalPortfolioValue: 0,
    totalInvested: 0,
    totalGainLoss: 0,
    totalRealizedGain: 0,
    totalUnrealizedGain: 0,
    totalIncome: 0,
    totalDividends: 0,
    totalInKindIncome: 0,
    totalFees: 0,
    totalTaxes: 0,
    totalFeesAndTaxes: 0,
    netReturnExcludingIncome: 0,
    netReturnWithDividends: 0,
    totalAppreciation: 0,
    totalPropertyReturn: 0,
    totalAccruedInterest: 0,
    totalProjectedAnnualInterest: 0,
    valueWeightedInterestRate: 0,
    estimatedMonthlyRent: 0,
    monthlyRentRateMissing: false,
    usedFallbackRate: false,
};

/**
 * The server totals of exactly these asset classes: the asset group with the
 * same classes, or the single class's own entry. Pages read these instead of
 * summing holdings (ADR-216).
 */
export function findHoldingTotals(
    summary: PortfolioSummaryResponse | undefined,
    assetClasses: readonly string[],
): PortfolioHoldingTotals {
    if (!summary) return EMPTY_HOLDING_TOTALS;
    const wanted = new Set(assetClasses);
    const group = (summary.byAssetGroup ?? []).find(
        (entry) =>
            entry.assetClasses.length === wanted.size &&
            entry.assetClasses.every((cls) => wanted.has(cls)),
    );
    if (group) return group;
    if (assetClasses.length === 1) {
        const single = (summary.byAssetClass ?? []).find(
            (entry) => entry.assetClass === assetClasses[0],
        );
        if (single) return single;
    }
    return EMPTY_HOLDING_TOTALS;
}
