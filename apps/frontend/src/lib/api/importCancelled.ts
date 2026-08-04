/**
 * A real cancellation signal for import streams.
 *
 * Both import clients turn a `fetch` AbortError into a thrown error so callers
 * can tell "the user pressed Cancel" apart from "the import failed". That
 * distinction used to travel as the literal message `"Import cancelled"`, which
 * consumers matched with `message === "Import cancelled"` — a sentinel that
 * breaks silently the moment the string is reworded, localized, or wrapped, and
 * fails in exactly the wrong direction: a cancelled import would start
 * reporting itself as a server error.
 *
 * The class carries the signal instead. `isImportCancelled` is the predicate to
 * use at call sites — it checks the prototype rather than the text, and also
 * accepts a bare `AbortError`, so an abort raised somewhere that has not been
 * wrapped is still recognized.
 */
export class ImportCancelledError extends Error {
    constructor(options?: { cause?: unknown }) {
        super('Import cancelled', options);
        this.name = 'ImportCancelledError';
    }
}

/** True when `err` represents a user-initiated cancellation of an import. */
export function isImportCancelled(err: unknown): boolean {
    if (err instanceof ImportCancelledError) return true;
    // A DOMException from an aborted fetch does not extend Error, so check the
    // name structurally rather than relying on instanceof.
    return Boolean(err) && typeof err === 'object'
        && (err as { name?: unknown }).name === 'AbortError';
}
