/**
 * Narrow a value an invariant guarantees to be present (a map entry written a
 * few lines earlier, a regex group the pattern makes mandatory, an index inside
 * a length check). The throw names the broken invariant instead of surfacing as
 * a later `undefined` property access.
 */
export function requiredValue<T>(
  value: T | null | undefined,
  invariant: string,
): T {
  if (value === null || value === undefined) {
    throw new Error(`Invariant violated: ${invariant}`);
  }
  return value;
}
