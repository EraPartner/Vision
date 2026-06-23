/**
 * Frontend money helpers — re-export of the shared @vision/shared-utils package.
 *
 * The implementation is shared with the backend so the two can no longer drift
 * (the frontend previously rounded HALF_UP while the backend used HALF_EVEN).
 */
export * from '@vision/shared-utils/money';
