import { useCallback } from "react";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import type { InvestmentSummary } from "@/types/portfolio";

export interface FxAwarePnl {
    realizedTarget: number;
    unrealizedTarget: number;
    unrealizedPercent: number;
}

/**
 * Canonical holdings already contain target-currency P&L, including historical
 * FX, configured lot selection, custody fees and adjustments. Return those
 * figures directly. Archived/local callers retain the existing EUR-pool replay.
 */
export function useFxAwarePnl(targetCurrency: string) {
    const { ratesToEur } = useCurrencyConverter(targetCurrency);

    const getRateToEur = useCallback(
        (currency?: string) => {
            const code = (currency || "EUR").toUpperCase();
            return ratesToEur[code] || 1;
        },
        [ratesToEur],
    );

    const convertEurToTarget = useCallback(
        (amountEur: number) => {
            const rateTo = getRateToEur(targetCurrency);
            return rateTo ? amountEur / rateTo : amountEur;
        },
        [getRateToEur, targetCurrency],
    );

    return useCallback(
        (holding: InvestmentSummary): FxAwarePnl => {
            if (holding.summarySource === "canonical") {
                const heldCost = holding.avgCostBasis * holding.totalUnits;
                return {
                    realizedTarget: holding.realizedGain,
                    unrealizedTarget: holding.unrealizedGain,
                    unrealizedPercent:
                        heldCost > 0
                            ? (holding.unrealizedGain / heldCost) * 100
                            : 0,
                };
            }
            const sortedTxns = [...(holding.transactions || [])].sort((a, b) =>
                String(a.date).localeCompare(String(b.date)),
            );
            let poolUnits = 0;
            let poolCostEur = 0;
            let realizedEur = 0;

            for (const txn of sortedTxns) {
                const units = Number(txn.units) || 0;
                const amount = Number(txn.amount) || 0;
                const fees = Number(txn.fees) || 0;
                const taxes = Number(txn.taxes) || 0;
                // Prefer the point-in-time rate stamped on the txn; fall back to the live
                // rate only when it's missing/zero. Like ADR-085's tax-path fallback this
                // is a transient approximation that self-corrects once the historical rate
                // is backfilled — but here it briefly blends a current-rate leg into the
                // EUR cost pool used for gain math, so the fallback is a known accuracy
                // trade-off, not an exact figure.
                const txnRateToEur =
                    Number(txn.fx_rate_to_eur) > 0
                        ? Number(txn.fx_rate_to_eur)
                        : getRateToEur(txn.currency || holding.currency);

                if (txn.type === "buy" || txn.type === "gift") {
                    poolUnits += units;
                    poolCostEur += (amount + fees + taxes) * txnRateToEur;
                } else if (txn.type === "sell" && units > 0 && poolUnits > 0) {
                    const sellUnits = Math.min(units, poolUnits);
                    const sellRatio = units > 0 ? sellUnits / units : 0;
                    const avgCostPerUnitEur = poolCostEur / poolUnits;
                    const costOfSoldEur = avgCostPerUnitEur * sellUnits;
                    const netProceedsEur =
                        (amount - fees - taxes) * sellRatio * txnRateToEur;
                    realizedEur += netProceedsEur - costOfSoldEur;

                    poolUnits -= sellUnits;
                    poolCostEur -= costOfSoldEur;
                } else if (txn.type === "split" && units > 0 && poolUnits > 0) {
                    // units = new TOTAL post-split; EUR cost pool is unchanged (mirrors the
                    // backend). Scaling only the unit count keeps avg-cost-per-unit correct.
                    poolUnits = units;
                } else if (txn.type === "return_of_capital" && poolUnits > 0) {
                    poolCostEur = Math.max(
                        0,
                        poolCostEur - amount * txnRateToEur,
                    );
                }
                // merger/spinoff are cost-basis-neutral — no change to pool.
            }

            poolCostEur = Math.max(0, poolCostEur);

            const currentPrice =
                Number(holding.currentPrice ?? holding.current_price) || 0;
            const currentValueEur =
                (Number(holding.totalUnits) || 0) *
                currentPrice *
                getRateToEur(holding.currency);
            const unrealizedEur = currentValueEur - poolCostEur;

            return {
                realizedTarget: convertEurToTarget(realizedEur),
                unrealizedTarget: convertEurToTarget(unrealizedEur),
                unrealizedPercent:
                    poolCostEur > 0 ? (unrealizedEur / poolCostEur) * 100 : 0,
            };
        },
        [getRateToEur, convertEurToTarget],
    );
}
