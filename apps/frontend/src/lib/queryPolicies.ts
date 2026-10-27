/** Shared React Query freshness policies. Values preserve the established cache cadence. */
export const QUERY_STALE_TIME_MS = {
    DEFAULT: 30_000,
    FREQUENT: 30_000,
    STANDARD: 60_000,
} as const;

/**
 * How long an unused cache entry stays in memory. Large lists (ledger pages,
 * chat history) go after 2 min instead of the 5 min default, so a long
 * session does not keep every visited page's rows resident (ADR-256).
 */
export const QUERY_GC_TIME_MS = {
    DEFAULT: 5 * 60_000,
    LARGE_LIST: 2 * 60_000,
} as const;
