/**
 * One-slot handoff for a CSV dropped anywhere on the window (or opened via
 * Finder/dock in Electron). The drop site registers the File and navigates to
 * /import; TransactionImportCard consumes it on mount. Same single-entry +
 * TTL shape as lib/undo.ts — this is a navigation handoff, not a queue.
 */

interface HandoffEntry {
    file: File;
    expiresAt: number;
}

let current: HandoffEntry | null = null;

const DEFAULT_TTL_MS = 30_000;

export function registerPendingImportFile(file: File, ttlMs = DEFAULT_TTL_MS): void {
    current = { file, expiresAt: Date.now() + ttlMs };
}

/** Returns and clears the pending file, or null when nothing (valid) is pending. */
export function consumePendingImportFile(): File | null {
    if (!current || Date.now() > current.expiresAt) {
        current = null;
        return null;
    }
    const { file } = current;
    current = null;
    return file;
}
