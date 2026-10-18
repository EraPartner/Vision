import type { InvestmentSummary } from "@/types/portfolio";

/** Latest rent remains a transaction amount in its booking currency. */
export function monthlyRentInTarget(
    property: InvestmentSummary,
    convert: (amount: number, currency: string) => number | undefined,
): number | undefined {
    const rent = property.transactions
        .filter((tx) => tx.type === "rent_income")
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)[0];
    if (!rent) return 0;
    return convert(
        rent.amount,
        rent.currency || property.originalCurrency || "EUR",
    );
}
