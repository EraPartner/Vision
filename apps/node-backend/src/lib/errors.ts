/**
 * Readers for caught values. `catch` clauses and promise rejections are
 * `unknown`: anything can be thrown, so these helpers inspect the value
 * instead of asserting it is an `Error` (or a driver error with a `code`).
 */

/**
 * Message of a caught value. Objects that carry a string `message` (including
 * errors from other realms) report it; everything else is stringified.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof err.message === "string"
  ) {
    return err.message;
  }
  return String(err);
}

/**
 * `code` property of a caught value (pg SQLSTATE, Node `errno` code, repository
 * `VALIDATION_ERROR`, ...); `undefined` when the value has none.
 */
export function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err
    ? err.code
    : undefined;
}

/** Whether a caught value is a fetch/stream abort (`name === "AbortError"`). */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    err.name === "AbortError"
  );
}
