/**
 * Determines whether an investment's `current_price` is stale.
 *
 * Default threshold: 24 hours since last successful price update.
 * Manual-provider investments (no live source) are never considered stale.
 */

const DEFAULT_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

interface InvestmentLike {
    price_provider?: string;
    price_updated_at?: string | null;
    is_active?: boolean;
}

export type AggregatePriceFreshness =
    | { state: "none" }
    | { state: "not-fetched" }
    | { state: "as-of"; updatedAt: string };

/**
 * Truthful lower-bound freshness for a total built from multiple holdings.
 * Manual holdings do not depend on a remote quote. A missing timestamp on any
 * live holding prevents an aggregate timestamp claim; otherwise the oldest
 * live quote is the limiting "as of" instant.
 */
export function getAggregatePriceFreshness(
    investments: ReadonlyArray<InvestmentLike>,
): AggregatePriceFreshness {
    const live = investments.filter(
        (investment) =>
            investment.is_active !== false &&
            (investment.price_provider || "manual") !== "manual",
    );
    if (live.length === 0) return { state: "none" };

    let oldest = Number.POSITIVE_INFINITY;
    for (const investment of live) {
        if (!investment.price_updated_at) return { state: "not-fetched" };
        const timestamp = Date.parse(investment.price_updated_at);
        if (!Number.isFinite(timestamp)) return { state: "not-fetched" };
        oldest = Math.min(oldest, timestamp);
    }

    return { state: "as-of", updatedAt: new Date(oldest).toISOString() };
}

export function isPriceStale(
    inv: InvestmentLike,
    thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
    now: number = Date.now(),
): boolean {
    const provider = inv.price_provider || "manual";
    if (provider === "manual") return false;
    if (!inv.price_updated_at) return true;
    const updatedAt = Date.parse(inv.price_updated_at);
    if (!Number.isFinite(updatedAt)) return true;
    return now - updatedAt > thresholdMs;
}

export function countStalePrices(
    investments: ReadonlyArray<InvestmentLike>,
    thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
    now: number = Date.now(),
): number {
    return investments.reduce(
        (count, inv) => count + (isPriceStale(inv, thresholdMs, now) ? 1 : 0),
        0,
    );
}

export const STALE_PRICE_THRESHOLD_MS = DEFAULT_STALE_THRESHOLD_MS;
