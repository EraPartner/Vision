/** Shared React Query freshness policies. Values preserve the established cache cadence. */
export const QUERY_STALE_TIME_MS = {
    DEFAULT: 30_000,
    FREQUENT: 30_000,
    STANDARD: 60_000,
} as const;
