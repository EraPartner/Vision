/**
 * Central humanizer for errors surfaced by the API layer.
 *
 * Everything thrown out of `lib/api/*` eventually lands in an `onError` toast.
 * Before this module existed those toasts printed `error.message` verbatim,
 * which meant users read transport noise: "Failed to fetch" (Chrome), "Load
 * failed" (Safari), "Request timed out", "Request failed (status 500)",
 * "Server returned 503", or a raw FastAPI 422 join such as
 * "Validation error: body.ids.0: field required".
 *
 * `apiErrorToMessage` maps those onto localized copy, keyed off the machine
 * `ApiClientError.code` (see docs/adr/026-unified-api-response-envelope.md)
 * with shape checks for the raw browser/transport errors that never become an
 * `ApiClientError`.
 *
 * Backend-authored 4xx text is deliberately preserved: the backend error
 * handler echoes 4xx messages verbatim by policy, and a message like
 * "statement_balance_date is required when a statement balance is set" is far
 * more useful than generic validation copy. Only the machine-generated shapes
 * listed in `MACHINE_MESSAGE_PATTERNS` are swallowed.
 *
 * Raw `.message` stays untouched for logs and devtools — this is a
 * presentation-layer helper only.
 */

import { ApiErrorCode } from '@vision/types';

import { ApiClientError } from '@/lib/api/client';

/** The `t` from `useLanguage()`. Kept structural so this module stays React-free. */
export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

/** i18n keys this module can return. Exported so tests assert on keys, not copy. */
export const API_ERROR_KEYS = {
    network: 'apiError.network',
    timeout: 'apiError.timeout',
    cancelled: 'apiError.cancelled',
    server: 'apiError.server',
    rateLimited: 'apiError.rateLimited',
    rateLimitedIn: 'apiError.rateLimitedIn',
    validation: 'apiError.validation',
    notFound: 'apiError.notFound',
    conflict: 'apiError.conflict',
    unauthorized: 'apiError.unauthorized',
    forbidden: 'apiError.forbidden',
    unknown: 'apiError.unknown',
} as const;

/**
 * Message shapes minted by the transport itself (`lib/api/client.ts`) or by the
 * browser's `fetch`. None of these were written for a human to read, so they are
 * never passed through — the matching bucket copy is shown instead.
 */
const MACHINE_MESSAGE_PATTERNS: RegExp[] = [
    /^Validation error:/i, // client.ts raw FastAPI 422 loc-path join
    /\(status \d{3}\)$/, // client.ts status-only envelope fallback
    /^Server returned \d{3}$/i, // client.ts retry-exhaustion sentinel
    /^Request failed$/i, // client.ts generic fallback
    /^Request timed out$/i, // client.ts timeout sentinel
    /^Failed to fetch$/i, // Chrome network failure
    /^Load failed$/i, // Safari network failure
    /^NetworkError/i, // Firefox network failure
    /^Network request failed$/i,
    /^The user aborted a request/i,
    /^signal is aborted/i,
    /^Too many requests\./i, // client.ts 429 fallback (hardcoded English)
];

const TIMEOUT_PATTERN = /^Request timed out$/i;
const ABORT_PATTERN = /^signal is aborted|^The user aborted a request/i;
const NETWORK_PATTERN = /^Failed to fetch$|^Load failed$|^NetworkError|^Network request failed$/i;
const RETRY_EXHAUSTED_PATTERN = /^Server returned (\d{3})$/i;

const CODE_TO_KEY: Partial<Record<string, string>> = {
    [ApiErrorCode.RATE_LIMITED]: API_ERROR_KEYS.rateLimited,
    [ApiErrorCode.INTERNAL_SERVER_ERROR]: API_ERROR_KEYS.server,
    [ApiErrorCode.BAD_GATEWAY]: API_ERROR_KEYS.server,
    [ApiErrorCode.SERVICE_UNAVAILABLE]: API_ERROR_KEYS.server,
    [ApiErrorCode.VALIDATION_ERROR]: API_ERROR_KEYS.validation,
    [ApiErrorCode.NOT_FOUND]: API_ERROR_KEYS.notFound,
    [ApiErrorCode.CONFLICT]: API_ERROR_KEYS.conflict,
    [ApiErrorCode.UNAUTHORIZED]: API_ERROR_KEYS.unauthorized,
    [ApiErrorCode.FORBIDDEN]: API_ERROR_KEYS.forbidden,
    [ApiErrorCode.APP_ERROR]: API_ERROR_KEYS.unknown,
};

/** Codes whose text is generated (5xx traces, rate-limit boilerplate) — never shown verbatim. */
const NEVER_PASS_THROUGH: ReadonlySet<string> = new Set<string>([
    ApiErrorCode.RATE_LIMITED,
    ApiErrorCode.INTERNAL_SERVER_ERROR,
    ApiErrorCode.BAD_GATEWAY,
    ApiErrorCode.SERVICE_UNAVAILABLE,
]);

/**
 * True when `message` reads like prose a human wrote (a backend `detail`, an
 * app-thrown guard) rather than a transport sentinel.
 */
export function isAuthoredMessage(message: unknown): boolean {
    if (typeof message !== 'string') return false;
    const trimmed = message.trim();
    if (!trimmed) return false;
    return !MACHINE_MESSAGE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Pull a positive `retry_after` (seconds) out of `ApiClientError.details`.
 * Returns null when absent or unusable, so the caller falls back to copy that
 * makes no promise about timing.
 */
function readRetryAfter(details: unknown): number | null {
    if (!details || typeof details !== 'object') return null;
    const raw = (details as Record<string, unknown>).retry_after;
    const seconds = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/** Read a string property off an unknown throwable without narrowing it first. */
function readString(value: unknown, key: 'name' | 'message'): string {
    if (!value || typeof value !== 'object') return '';
    const raw = (value as Record<string, unknown>)[key];
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Resolve the bucket for a transport-level failure that never became an
 * `ApiClientError`. Returns `null` when the error is not transport noise.
 *
 * Works off `name`/`message` rather than `instanceof` alone because a cancelled
 * `fetch` rejects with a `DOMException`, which does not extend `Error`.
 */
function transportKey(err: unknown, name: string, message: string): string | null {
    if (TIMEOUT_PATTERN.test(message)) return API_ERROR_KEYS.timeout;
    if (name === 'AbortError' || ABORT_PATTERN.test(message)) return API_ERROR_KEYS.cancelled;
    // `fetch` rejects with a TypeError when the backend is unreachable; the text
    // differs per browser ("Failed to fetch" / "Load failed" / "NetworkError…").
    if (err instanceof TypeError || NETWORK_PATTERN.test(message)) return API_ERROR_KEYS.network;

    const retryExhausted = RETRY_EXHAUSTED_PATTERN.exec(message);
    if (retryExhausted) {
        const status = Number(retryExhausted[1]);
        if (status === 429) return API_ERROR_KEYS.rateLimited;
        return status >= 500 ? API_ERROR_KEYS.server : API_ERROR_KEYS.unknown;
    }
    if (/^Request failed$/i.test(message)) return API_ERROR_KEYS.unknown;
    return null;
}

/**
 * Turn any thrown value into copy that is safe to show in a toast description.
 *
 * Resolution order:
 *  1. `ApiClientError` with a 5xx / rate-limit code → generic per-code copy.
 *  2. `ApiClientError` 4xx carrying an authored `detail` → that text verbatim.
 *  3. `ApiClientError` → per-code copy (validation / not-found / conflict / …).
 *  4. Transport sentinel (network / timeout / abort / retry exhaustion) → bucket copy.
 *  5. `Error` with authored text (app-thrown guards) → that text verbatim.
 *  6. Anything else → generic "something went wrong".
 */
export function apiErrorToMessage(err: unknown, t: TranslateFn): string {
    if (err instanceof ApiClientError) {
        // A rate limit that told us how long to wait can say so. The transport's
        // own 429 sentence is hardcoded English and never passes through, so
        // client.ts puts the number in `details` instead.
        const retryAfter = readRetryAfter(err.details);
        if (err.code === ApiErrorCode.RATE_LIMITED && retryAfter !== null) {
            return t(API_ERROR_KEYS.rateLimitedIn, { seconds: retryAfter });
        }
        const passThroughAllowed =
            !NEVER_PASS_THROUGH.has(err.code) && err.status >= 400 && err.status < 500;
        if (passThroughAllowed && isAuthoredMessage(err.message)) return err.message.trim();
        return t(CODE_TO_KEY[err.code] ?? (err.status >= 500 ? API_ERROR_KEYS.server : API_ERROR_KEYS.unknown));
    }

    const name = readString(err, 'name');
    const message = readString(err, 'message');

    const key = transportKey(err, name, message);
    if (key) return t(key);

    // Guards thrown by app code ("Pick at least one account") are real copy.
    if (err instanceof Error && isAuthoredMessage(message)) return message;

    return t(API_ERROR_KEYS.unknown);
}
