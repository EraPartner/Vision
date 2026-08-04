/**
 * Humanizer for errors surfaced by the Electron IPC bridges.
 *
 * The sibling `apiErrorToMessage` deliberately does not cover these: nothing
 * here is HTTP, and blanket generic copy would throw away main-process detail
 * that is genuinely useful ("Shell update not available in embedded mode — use
 * Docker image update instead."). What the toasts leaked instead was the
 * machine wrapper around that detail, in two shapes:
 *
 *   1. A rejected `ipcRenderer.invoke` arrives as
 *      `Error: Error invoking remote method 'backup:run': <real message>` —
 *      the channel name and Electron's own boilerplate, in front of the part a
 *      user can act on.
 *   2. Handlers that return `{ success: false, error: String(err) }` hand back a
 *      stringified Node error, so a failed backup showed a raw `ENOENT` line
 *      including the absolute filesystem path it tried to open.
 *
 * So this unwraps rather than replaces: strip the wrapper, map the recognizable
 * machine shapes onto localized copy, and pass through anything that reads like
 * a message a human wrote.
 */

/** The `t` from `useLanguage()`. Structural so this module stays React-free. */
export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

/** i18n keys this module can return. Exported so tests assert on keys, not copy. */
export const ELECTRON_ERROR_KEYS = {
    notFound: 'electronError.notFound',
    permission: 'electronError.permission',
    diskFull: 'electronError.diskFull',
    notReady: 'electronError.notReady',
    unknown: 'electronError.unknown',
} as const;

/** `Error invoking remote method 'channel': rest` → `rest`. */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
/** One or more leading `Error: ` prefixes left by String(err) round-trips. */
const ERROR_PREFIX = /^(?:Error:\s*)+/;

/**
 * Machine shapes that must never reach a toast. Node errno strings carry
 * absolute paths; the rest are internal sentinels from packaging/electron.
 */
const MACHINE_PATTERNS: { pattern: RegExp; key: string }[] = [
    { pattern: /\bENOENT\b/, key: ELECTRON_ERROR_KEYS.notFound },
    { pattern: /\b(EACCES|EPERM)\b/, key: ELECTRON_ERROR_KEYS.permission },
    { pattern: /\b(ENOSPC|EDQUOT)\b/, key: ELECTRON_ERROR_KEYS.diskFull },
    { pattern: /^workDir not set$/i, key: ELECTRON_ERROR_KEYS.notReady },
    { pattern: /^Unauthorized sender/i, key: ELECTRON_ERROR_KEYS.unknown },
];

/** Pull a string message out of an unknown throwable or an IPC result field. */
function readRaw(err: unknown): string {
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
        const message = (err as Record<string, unknown>).message;
        if (typeof message === 'string') return message;
    }
    return '';
}

/**
 * Turn anything an Electron bridge throws or returns in `.error` into copy that
 * is safe to show in a toast description.
 *
 * @param err the caught value, or the `error` string off an IPC result
 * @param t translate function
 */
export function electronErrorToMessage(err: unknown, t: TranslateFn): string {
    const unwrapped = readRaw(err)
        .replace(ERROR_PREFIX, '')
        .replace(IPC_WRAPPER, '')
        .replace(ERROR_PREFIX, '')
        .trim();

    if (!unwrapped) return t(ELECTRON_ERROR_KEYS.unknown);

    for (const { pattern, key } of MACHINE_PATTERNS) {
        if (pattern.test(unwrapped)) return t(key);
    }

    // Main-process messages are overwhelmingly authored by us and are the
    // useful part — keep them.
    return unwrapped;
}
