/**
 * Narrow a value that the test knows is present (a household partner, the
 * first element of a fixture list). Fails with a readable message instead of a
 * downstream "cannot read properties of undefined" TypeError.
 */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be present, got ${String(value)}`);
  }
  return value;
}
