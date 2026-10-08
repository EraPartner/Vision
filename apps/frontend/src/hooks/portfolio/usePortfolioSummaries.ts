/**
 * Composes investment queries + shared calculations into InvestmentSummary[].
 * Provides totals and byAssetClass() filtered view.
 *
 * Active production holdings use canonical backend summaries, which include
 * custody and asset adjustments. Ordinary CRUD transactions stay attached for
 * dialogs. Archived holdings retain their existing local history calculation.
 */

import { useCallback, useMemo } from "react";
import type { AssetClass, Investment, PortfolioTransaction } from "@/types/api";
import type { InvestmentSummary } from "@/types/portfolio";
import type { PortfolioSummaryItem } from "@/lib/api/info";
import {
    buildInvestmentSummaryCorePartitioned,
    type CostBasisMethod,
} from "@vision/shared-utils/portfolio";
import { todayYmd } from "@/lib/timezone";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useExchangeRates } from "@/hooks/useExchangeRates";
import { toNumber, multiply, addAll } from "@vision/shared-utils/money";

interface BuildSummaryOpts {
    costBasisMethod: CostBasisMethod;
    targetCurrency: string;
    /** Multiplier converting the investment's native currency → targetCurrency. */
    multiplier: number;
    today: string;
}

function buildSummary(
    inv: Investment,
    txns: PortfolioTransaction[],
    { costBasisMethod, targetCurrency, multiplier, today }: BuildSummaryOpts,
): InvestmentSummary {
    const { core, fullyAssigned } = buildInvestmentSummaryCorePartitioned(
        inv,
        txns,
        {
            costBasisMethod,
            todayYmd: today,
        },
    );

    const conv = (v: Parameters<typeof multiply>[0]) =>
        toNumber(multiply(v, multiplier));

    return {
        ...inv,
        // All monetary fields below are converted to the app's display currency;
        // the native currency stays available for labelling (mirrors the backend
        // summary response shape).
        currency: targetCurrency,
        originalCurrency: (inv.currency || "EUR").toUpperCase(),
        assetClass: inv.asset_class,
        totalUnits: toNumber(core.totalUnits),
        totalInvested: conv(core.totalInvested),
        totalFees: conv(core.totalFees),
        totalTaxes: conv(core.totalTaxes),
        feeTransactions: conv(core.feeTxnAmount),
        taxTransactions: conv(core.taxTxnAmount),
        totalDividends: conv(core.totalDividends),
        totalIncome: conv(core.totalIncome),
        totalInKindIncome: localInKindIncome(
            txns,
            inv.currency || "EUR",
            targetCurrency,
        ),
        currentValue: conv(core.currentValue),
        currentPrice: Number(inv.current_price)
            ? conv(Number(inv.current_price))
            : undefined,
        interestRate: Number(inv.interest_rate) || undefined,
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
        summarySource: "local",
        transactions: txns,
    } as InvestmentSummary;
}

// Never apply the investment's currency or today's rate to literal income paid
// in another currency. Same-currency amounts need no rate; foreign subtotals
// wait for the canonical dated projection.
function localInKindIncome(
    txns: PortfolioTransaction[],
    nativeCurrency: string,
    targetCurrency: string,
): number | undefined {
    const income = txns.filter(
        (tx) => tx.income_recognition_role === "included_in_units",
    );
    if (
        income.some(
            (tx) =>
                (tx.currency || nativeCurrency).toUpperCase() !==
                targetCurrency,
        )
    )
        return undefined;
    return toNumber(addAll(income.map((tx) => tx.amount)));
}

interface UsePortfolioSummariesInput {
    investments: Investment[];
    transactions: PortfolioTransaction[];
    canonicalSummaries?: PortfolioSummaryItem[];
    canonicalArchivedInKindIncome?: Array<{
        id: number;
        totalInKindIncome: number;
    }>;
    /** Hide active ordinary-only calculations while canonical data is unavailable. */
    requireCanonical?: boolean;
}

// Stable empty result so a single-class lookup with no matches keeps its
// identity across renders.
const EMPTY_SUMMARIES: InvestmentSummary[] = [];

export function usePortfolioSummaries({
    investments,
    transactions,
    canonicalSummaries,
    canonicalArchivedInKindIncome,
    requireCanonical = false,
}: UsePortfolioSummariesInput) {
    const { appSettings } = useAppSettings();
    const { multiplierFor } = useExchangeRates();
    const costBasisMethod: CostBasisMethod =
        appSettings.costBasisMethod ?? "weighted_avg";
    const targetCurrency = (appSettings.defaultCurrency || "EUR").toUpperCase();

    const allSummaries: InvestmentSummary[] = useMemo(() => {
        const txnsByInvestment = new Map<number, PortfolioTransaction[]>();
        for (const txn of transactions) {
            const bucket = txnsByInvestment.get(txn.investment_id);
            if (bucket) bucket.push(txn);
            else txnsByInvestment.set(txn.investment_id, [txn]);
        }

        const today = todayYmd();
        const canonicalById = new Map(
            (canonicalSummaries ?? []).map((summary) => [summary.id, summary]),
        );
        const archivedIncomeById =
            canonicalArchivedInKindIncome === undefined
                ? undefined
                : new Map(
                      canonicalArchivedInKindIncome.map((item) => [
                          item.id,
                          item.totalInKindIncome,
                      ]),
                  );
        return investments.flatMap((inv) => {
            const txns = txnsByInvestment.get(inv.id) ?? [];
            if (inv.is_active && (requireCanonical || canonicalSummaries)) {
                const canonical = canonicalById.get(inv.id);
                if (!canonical) return [];
                return [
                    {
                        ...inv,
                        ...canonical,
                        totalInKindIncome: canonical.totalInKindIncome ?? 0,
                        assetClass: inv.asset_class,
                        asset_class: inv.asset_class,
                        price_provider: inv.price_provider,
                        current_price: inv.current_price,
                        summarySource: "canonical" as const,
                        transactions: txns,
                    },
                ];
            }
            const local = buildSummary(inv, txns, {
                costBasisMethod,
                targetCurrency,
                multiplier: multiplierFor(
                    inv.currency || "EUR",
                    targetCurrency,
                ),
                today,
            });
            if (!inv.is_active) {
                local.totalInKindIncome = archivedIncomeById
                    ? (archivedIncomeById.get(inv.id) ?? 0)
                    : (canonicalById.get(inv.id)?.totalInKindIncome ??
                      local.totalInKindIncome);
            }
            return [local];
        });
    }, [
        investments,
        transactions,
        costBasisMethod,
        targetCurrency,
        multiplierFor,
        canonicalSummaries,
        canonicalArchivedInKindIncome,
        requireCanonical,
    ]);

    const summaries = useMemo(
        () => allSummaries.filter((summary) => summary.is_active),
        [allSummaries],
    );
    const inactiveSummaries = useMemo(
        () => allSummaries.filter((summary) => !summary.is_active),
        [allSummaries],
    );

    const totals = useMemo(
        () => ({
            totalPortfolioValue: toNumber(
                addAll(summaries.map((s) => s.currentValue)),
            ),
            totalGainLoss: toNumber(addAll(summaries.map((s) => s.gainLoss))),
            totalRealizedGain: toNumber(
                addAll(summaries.map((s) => s.realizedGain)),
            ),
            totalUnrealizedGain: toNumber(
                addAll(summaries.map((s) => s.unrealizedGain)),
            ),
        }),
        [summaries],
    );

    // Pre-group once per summaries change. A single-class lookup then returns the
    // grouped array directly with a stable identity — previously every render
    // produced a fresh `.filter()` result, so the Stocks/Crypto/Metals pages
    // re-rendered even when nothing changed.
    const groupedByClass = useMemo(() => {
        const map = new Map<AssetClass, InvestmentSummary[]>();
        for (const s of summaries) {
            const cls = s.assetClass as AssetClass;
            const list = map.get(cls);
            if (list) list.push(s);
            else map.set(cls, [s]);
        }
        return map;
    }, [summaries]);

    const byAssetClass = useCallback(
        (cls: AssetClass | AssetClass[]): InvestmentSummary[] => {
            if (!Array.isArray(cls))
                return groupedByClass.get(cls) ?? EMPTY_SUMMARIES;
            return cls.flatMap((c) => groupedByClass.get(c) ?? []);
        },
        [groupedByClass],
    );

    return {
        summaries,
        allSummaries,
        inactiveSummaries,
        totals,
        byAssetClass,
    };
}
