/** Shared narrowing helpers for the Electron tests. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((item) => typeof item === "string")
  );
}

/** `JSON.parse` whose result is `unknown`, so callers must narrow it. */
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** Parses JSON text and fails the test when it is not shaped like `T`. */
export function parseJsonAs<T>(
  text: string,
  guard: (value: unknown) => value is T,
  what: string,
): T {
  const parsed = parseJson(text);
  if (!guard(parsed)) throw new TypeError(`${what} has an unexpected shape`);
  return parsed;
}

/** Narrows a value that the test setup guarantees, failing with a clear message. */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be set`);
  }
  return value;
}
