import type { PortfolioTransaction } from "@/types/api";

/** Local summaries have current FX only, so they cannot reconstruct quote-currency basis. */
export function hasForeignCurrencyAmounts(
    transactions: PortfolioTransaction[],
    quoteCurrency: string,
): boolean {
    const quote = quoteCurrency.toUpperCase();
    return transactions.some(
        (txn) =>
            (txn.currency || quote).toUpperCase() !== quote &&
            [txn.amount, txn.fees, txn.taxes].some(
                (amount) => Number(amount ?? 0) !== 0,
            ),
    );
}
