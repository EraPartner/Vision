/**
 * Shared "derive the missing one of amount / units / price" math for the
 * portfolio Add/Edit transaction dialogs.
 *
 * Previously copy-pasted verbatim in AddPortfolioTxnDialog and
 * EditPortfolioTxnDialog (same precisions + tolerance); drift between the two
 * meant Add and Edit could silently accept/reject different inputs. One pure,
 * unit-tested helper keeps them in lock-step.
 */

import { parseDecimal } from "@/lib/decimal";
import type { NumberFormat } from "@/utils/currency";

/**
 * Parse a form-field string as a strictly positive number.
 * Empty, unparseable, zero, and negative inputs all map to undefined so the
 * caller can treat "not usable" uniformly (the backend rejects non-positive
 * amount/units/price on buy/sell anyway).
 */
export function parsePositive(
    value: string,
    numberFormat: NumberFormat,
): number | undefined {
    if (!value.trim()) return undefined;
    const n = parseDecimal(value, numberFormat, NaN);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n;
}

export * from "@vision/shared-utils/research/unitMath";
