import { addAll, toNumber } from "@/lib/money";
import type {
    PortfolioSummaryByAccountItem,
    PortfolioSummaryResponse,
} from "@/lib/api/info";

export interface BrokerAccountMetrics {
    holdingsValue: number;
    gainLoss: number;
    oversold: boolean;
    hasPosition: boolean;
}

export function getBrokerAccountMetrics(
    summary: PortfolioSummaryResponse | undefined,
    accountId: number,
): BrokerAccountMetrics | undefined {
    if (!summary) return undefined;
    const rows = summary.byAccount.filter(
        (row) => row.account_id === accountId,
    );
    const positions = rows.filter(
        (row) => row.contribution_kind === "position",
    );
    const sum = (
        values: PortfolioSummaryByAccountItem[],
        field: "currentValue" | "gainLoss",
    ) => toNumber(addAll(values.map((row) => row[field])));
    return {
        holdingsValue: sum(positions, "currentValue"),
        gainLoss: sum(rows, "gainLoss"),
        oversold: rows.some((row) => row.oversold),
        hasPosition: positions.length > 0,
    };
}
