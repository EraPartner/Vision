/** Return `value`, or throw when an invariant promised it to be present. */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be present`);
  }
  return value;
}

/** JavaScript truthiness of an untyped (possibly stored or user-supplied) value. */
export function isTruthy(value: unknown): boolean {
  return Boolean(value);
}
