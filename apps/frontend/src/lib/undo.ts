/**
 * One-slot undo registry for ⌘Z + toast-action undo (Apple-style
 * forgiveness for destructive actions). Deliberately single-entry with a
 * short TTL: this is "oops, put it back", not an editor undo stack.
 */

interface UndoEntry {
    run: () => void | Promise<void>;
    expiresAt: number;
}

let current: UndoEntry | null = null;

const DEFAULT_TTL_MS = 8_000;

export function registerUndo(run: () => void | Promise<void>, ttlMs = DEFAULT_TTL_MS): void {
    current = { run, expiresAt: Date.now() + ttlMs };
}

/** Runs and clears the pending undo. Returns false when nothing (valid) is pending. */
export function consumeUndo(): boolean {
    if (!current || Date.now() > current.expiresAt) {
        current = null;
        return false;
    }
    const entry = current;
    current = null;
    void entry.run();
    return true;
}
