import { isRecord } from "@/lib/isRecord";

/**
 * True when `err` is a fetch/abort `AbortError`. Checked by name, not
 * `instanceof Error`: an aborted `fetch` rejects with a `DOMException`, which
 * does not extend `Error` in every environment, and anything can be thrown.
 */
export function isAbortError(err: unknown): boolean {
    return isRecord(err) && err.name === "AbortError";
}
