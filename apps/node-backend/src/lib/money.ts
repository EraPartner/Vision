/**
 * Re-export of the shared money helpers.
 *
 * The implementation now lives in the @vision/shared-utils workspace package so
 * the backend and frontend share one source of truth and can no longer drift
 * (they previously diverged on rounding mode). This module is kept as a stable
 * in-repo import path for the ~30 backend call sites.
 */
export * from '@vision/shared-utils/money';
