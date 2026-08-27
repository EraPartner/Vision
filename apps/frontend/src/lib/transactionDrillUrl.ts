import { getDaysInMonth } from "date-fns";

export type TransactionDrillValueMode =
    "absolute" | "income" | "expense" | "net";

export interface TransactionDrillParams {
    categoryId?: number;
    categoryIds?: number[];
    period?: string;
    valueMode?: TransactionDrillValueMode;
    label?: string;
    uncategorised?: boolean;
}

function lastDayOfMonth(period: string): string {
    const [year, month] = period.split("-").map(Number);
    const day = getDaysInMonth(new Date(year, month - 1));
    return `${period}-${String(day).padStart(2, "0")}`;
}

/** Canonical href for links from dashboard/statistics into Transactions. */
export function buildTransactionDrillUrl({
    categoryId,
    categoryIds,
    period,
    valueMode = "absolute",
    label,
    uncategorised,
}: TransactionDrillParams): string {
    const params = new URLSearchParams();

    if (categoryId != null) params.set("category_id", String(categoryId));
    else if (categoryIds?.length)
        params.set("category_ids", categoryIds.join(","));
    if (uncategorised) params.set("uncategorised", "true");

    if (period) {
        params.set("start_date", `${period}-01`);
        params.set("end_date", lastDayOfMonth(period));
    }
    if (valueMode === "income") params.set("transaction_type", "income");
    else if (valueMode === "expense") params.set("transaction_type", "expense");
    if (label) params.set("filter_label", label);

    const query = params.toString();
    return query ? `/transactions?${query}` : "/transactions";
}
