/**
 * TypeScript declarations for ./recurrence.js — the canonical recurrence
 * vocabularies. Each union derives from its const tuple so the type and the
 * runtime array cannot drift apart.
 *
 * Both persisted subsystems use the same unhyphenated `biweekly` spelling.
 */

/**
 * Portfolio recurrence cadences. The API boundary accepts only these values.
 */
export declare const PORTFOLIO_RECURRENCE_INTERVALS: readonly [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
];

export type RecurrenceInterval =
  (typeof PORTFOLIO_RECURRENCE_INTERVALS)[number];

/**
 * Planned-transaction recurrence cadences — the UNHYPHENATED `'biweekly'`
 * spelling. Mirrors `planned_transactions.recurrence_pattern`. The backend
 * grammar also accepts a custom `every N days` form that is not in this tuple.
 */
export declare const PLANNED_RECURRENCE_PATTERNS: readonly [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
];

export type PlannedRecurrencePattern =
  (typeof PLANNED_RECURRENCE_PATTERNS)[number];
