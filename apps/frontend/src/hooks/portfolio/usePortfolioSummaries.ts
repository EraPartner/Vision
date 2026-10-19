/**
 * Composes investment queries + backend summaries into InvestmentSummary[].
 * Provides totals and byAssetClass() filtered view.
 *
 * Every figure comes from the backend portfolio summary (dated FX, configured
 * cost-basis method, custody and asset adjustments): active holdings from the
 * default summary, archived ones from the all-holdings summary. Ordinary CRUD
 * transactions stay attached for dialogs.
 */

import { useCallback, useMemo } from "react";
import type { AssetClass, Investment, PortfolioTransaction } from "@/types/api";
import type { InvestmentSummary } from "@/types/portfolio";
import type { PortfolioSummaryItem } from "@/lib/api/info";
import { toNumber, addAll } from "@vision/shared-utils/money";

interface UsePortfolioSummariesInput {
    investments: Investment[];
    transactions: PortfolioTransaction[];
    /** Server summaries of active holdings. */
    canonicalSummaries?: PortfolioSummaryItem[] | undefined;
    /** Server summaries that include archived holdings (`active=false`). */
    canonicalArchivedSummaries?: PortfolioSummaryItem[] | undefined;
}

// Stable empty result so a single-class lookup with no matches keeps its
// identity across renders.
const EMPTY_SUMMARIES: InvestmentSummary[] = [];

export function usePortfolioSummaries({
    investments,
    transactions,
    canonicalSummaries,
    canonicalArchivedSummaries,
}: UsePortfolioSummariesInput) {
    const allSummaries: InvestmentSummary[] = useMemo(() => {
        const txnsByInvestment = new Map<number, PortfolioTransaction[]>();
        for (const txn of transactions) {
            const bucket = txnsByInvestment.get(txn.investment_id);
            if (bucket) bucket.push(txn);
            else txnsByInvestment.set(txn.investment_id, [txn]);
        }

        const activeById = new Map(
            (canonicalSummaries ?? []).map((summary) => [summary.id, summary]),
        );
        const archivedById = new Map(
            (canonicalArchivedSummaries ?? []).map((summary) => [
                summary.id,
                summary,
            ]),
        );
        return investments.flatMap((inv) => {
            // A holding without its server summary is still loading.
            const canonical = (inv.is_active ? activeById : archivedById).get(
                inv.id,
            );
            if (!canonical) return [];
            return [
                {
                    ...inv,
                    ...canonical,
                    // The summary passes `SELECT i.*` through untyped: NUMERIC
                    // columns arrive as strings and maturity_date as a
                    // serialized local-midnight Date (the previous UTC day east
                    // of UTC). The investment row carries them correctly.
                    is_active: inv.is_active,
                    cadastral_income: inv.cadastral_income,
                    municipality_tax_rate: inv.municipality_tax_rate,
                    maturity_date: inv.maturity_date,
                    maturityDate: inv.maturity_date,
                    totalInKindIncome: canonical.totalInKindIncome ?? 0,
                    assetClass: inv.asset_class,
                    asset_class: inv.asset_class,
                    price_provider: inv.price_provider,
                    current_price: inv.current_price,
                    summarySource: "canonical" as const,
                    transactions: txnsByInvestment.get(inv.id) ?? [],
                },
            ];
        });
    }, [investments, transactions, canonicalSummaries, canonicalArchivedSummaries]);

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
            const cls = s.assetClass;
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
