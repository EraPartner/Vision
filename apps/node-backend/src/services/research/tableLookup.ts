/**
 * Index a fixed table with a key that only arrives as a runtime string (a
 * request parameter, a provider field). Typed tables claim every key is
 * present; this reads them honestly, so a key outside the table is undefined.
 */
export function lookup<T>(
  table: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return table[key];
}
