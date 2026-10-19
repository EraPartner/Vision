import type { InvestmentSummary } from "@/types/portfolio";

export interface FxAwarePnl {
    realizedTarget: number;
    unrealizedTarget: number;
    unrealizedPercent: number;
}

/**
 * Realized/unrealized P&L of a holding in the target currency. Server summaries
 * already carry these figures with historical FX, the configured lot selection,
 * custody fees and adjustments, so this only derives the unrealized percentage
 * against the cost of the units still held.
 */
export function holdingPnl(holding: InvestmentSummary): FxAwarePnl {
    const heldCost = holding.avgCostBasis * holding.totalUnits;
    return {
        realizedTarget: holding.realizedGain,
        unrealizedTarget: holding.unrealizedGain,
        unrealizedPercent:
            heldCost > 0 ? (holding.unrealizedGain / heldCost) * 100 : 0,
    };
}
