/** Small helpers shared by the transition modules. */

/** Element `i` of an array, string or regex match that the caller knows exists. */
export function at<T>(items: ArrayLike<T>, i: number): T {
  const item = items[i];
  if (item === undefined) throw new RangeError(`index ${i} out of range (length ${items.length})`);
  return item;
}

/** Code-unit order (what SQLite's BINARY collation gives for ASCII keys). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
