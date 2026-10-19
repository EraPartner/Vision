import type { PortfolioSummaryResponse } from "@/lib/api/info";

export interface BrokerAccountMetrics {
    holdingsValue: number;
    gainLoss: number;
    oversold: boolean;
    hasPosition: boolean;
}

/**
 * A broker account's figures, read from the server totals (ADR-216): the
 * position row of `byAccount` carries the holdings value and `accountTotals`
 * the profit and loss of every contribution kind.
 */
export function getBrokerAccountMetrics(
    summary: PortfolioSummaryResponse | undefined,
    accountId: number,
): BrokerAccountMetrics | undefined {
    if (!summary) return undefined;
    const position = summary.byAccount.find(
        (row) =>
            row.account_id === accountId &&
            row.contribution_kind === "position",
    );
    const totals = summary.accountTotals?.find(
        (row) => row.account_id === accountId,
    );
    return {
        holdingsValue: position?.currentValue ?? 0,
        gainLoss: totals?.gainLoss ?? 0,
        oversold: totals?.oversold ?? false,
        hasPosition: position !== undefined,
    };
}
