/**
 * TypeScript declarations for ./recurrence.js — the canonical recurrence
 * vocabularies. Each union derives from its const tuple so the type and the
 * runtime array cannot drift apart.
 *
 * There are two tuples for one concept because the two subsystems disagree on
 * the hyphen in "bi-weekly" and both spellings are persisted; recurrence.js
 * carries the full note on why they are not merged and what unifying them would
 * cost.
 */

/**
 * Portfolio recurrence cadences — the HYPHENATED `'bi-weekly'` spelling. Mirrors
 * the `recurrence_interval` PG enum and openapi.yaml's `RecurrenceInterval`.
 */
export declare const PORTFOLIO_RECURRENCE_INTERVALS: readonly [
  'daily', 'weekly', 'bi-weekly', 'monthly', 'quarterly', 'yearly',
];

export type RecurrenceInterval = (typeof PORTFOLIO_RECURRENCE_INTERVALS)[number];

/**
 * Planned-transaction recurrence cadences — the UNHYPHENATED `'biweekly'`
 * spelling. Mirrors `planned_transactions.recurrence_pattern`. The backend
 * grammar also accepts a custom `every N days` form that is not in this tuple.
 */
export declare const PLANNED_RECURRENCE_PATTERNS: readonly [
  'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly',
];

export type PlannedRecurrencePattern = (typeof PLANNED_RECURRENCE_PATTERNS)[number];
