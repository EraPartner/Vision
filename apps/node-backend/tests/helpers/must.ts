/**
 * Narrow a value that the test knows is present (a query result row, the
 * first element of a fixture list, a mock call). Fails with a readable message
 * instead of a downstream "cannot read properties of undefined" TypeError.
 */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be present, got ${String(value)}`);
  }
  return value;
}

/** The first row of a query result the test knows is non-empty. */
export function firstRow<T>(
  result: { rows: readonly T[] },
  what = "first row",
): T {
  return must(result.rows[0], what);
}
