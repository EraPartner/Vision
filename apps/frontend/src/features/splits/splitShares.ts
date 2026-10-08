import { roundMoney, toDecimal } from "@vision/shared-utils/money";

/**
 * Split `total` into `parts` cent-exact shares that add up to `total` exactly:
 * every share is the floor of the even share, and the remaining cents go to
 * the first shares one by one. Used by the dialog's "Others pay all" (0/100)
 * preset, where the shares MUST cover the whole amount — a rounded even share
 * can land a cent over the transaction (and trip the over-allocation gate)
 * or a cent under it.
 *
 * `allocateEvenly(10, 3)` → `[3.34, 3.33, 3.33]`.
 */
export function allocateEvenly(total: number, parts: number): number[] {
    if (!Number.isInteger(parts) || parts <= 0) return [];
    const cents = toDecimal(total).times(100).round();
    const base = cents.dividedToIntegerBy(parts);
    const remainder = cents.minus(base.times(parts)).toNumber();
    return Array.from({ length: parts }, (_, index) =>
        roundMoney(base.plus(index < remainder ? 1 : 0).div(100)),
    );
}
