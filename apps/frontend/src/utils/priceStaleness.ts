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
}

export function isPriceStale(
  inv: InvestmentLike,
  thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
  now: number = Date.now(),
): boolean {
  const provider = inv.price_provider || 'manual';
  if (provider === 'manual') return false;
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
