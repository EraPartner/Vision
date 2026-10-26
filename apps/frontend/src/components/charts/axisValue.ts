/**
 * Narrowing for axis tick values. visx hands `tickFormat` an `unknown` tick
 * (the scale's domain type), and the date-axis charts hand their own
 * formatter a `Date | number`. These read the value instead of casting it:
 * a value of the expected kind passes through unchanged.
 */

/** A tick on a linear scale. */
export function axisNumber(value: unknown): number {
    return typeof value === "number" ? value : Number(value);
}

/** A tick on a scale that is either time or linear. */
export function axisDateOrNumber(value: unknown): Date | number {
    return value instanceof Date ? value : axisNumber(value);
}

/** A tick on a time scale. */
export function axisDate(value: unknown): Date {
    return value instanceof Date ? value : new Date(axisNumber(value));
}
