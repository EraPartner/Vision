/**
 * parseDecimal — safe monetary value parser.
 *
 * Strictly follows the caller's app number format, plus null/undefined/empty
 * and non-finite results with a fallback.
 */
import { parseLocaleNumber } from "../utils/currency";
import type { NumberFormat } from "../utils/currency";

/**
 * Largest value the backend's NUMERIC(18,6) money/price columns can hold
 * (12 integer digits). Inputs above this overflow at the DB and surface
 * as a 500 — validate against it client-side.
 */
export const MAX_NUMERIC_18_6 = 999_999_999_999;

export function parseDecimal(
    value: string | number | null | undefined,
    numberFormat: NumberFormat,
    fallback = 0,
): number {
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value === "number")
        return Number.isFinite(value) ? value : fallback;
    const n = parseLocaleNumber(value, numberFormat);
    return Number.isFinite(n) ? n : fallback;
}
