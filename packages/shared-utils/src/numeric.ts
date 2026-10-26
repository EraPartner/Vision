/**
 * Explicit forms of JavaScript number truthiness. `value || 0` and `if (value)`
 * treat undefined, null, 0, -0 and NaN alike; these helpers keep exactly that
 * behaviour where the strict-boolean lint rule forbids the implicit form.
 */

/** True when `value` would be truthy as a number: present, not 0 and not NaN. */
export function isNonZeroNumber(value: number | null | undefined): boolean {
  return (
    value !== null && value !== undefined && value !== 0 && !Number.isNaN(value)
  );
}

/** `value || 0` for numbers: undefined, null, NaN and -0 become 0. */
export function orZero(value: number | null | undefined): number {
  return value === null ||
    value === undefined ||
    value === 0 ||
    Number.isNaN(value)
    ? 0
    : value;
}

/** `Number.isFinite` as a type guard: `Number.isFinite(value)` itself leaves the type as it was. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `Number(value) || 0`: numeric text, decimals and junk (NaN) all collapse to 0. */
export function numberOrZero(value: unknown): number {
  return orZero(Number(value));
}
