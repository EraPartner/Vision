/**
 * Canonical recurrence vocabularies — the single place either list is edited.
 *
 * Both portfolio and planned transactions use the unhyphenated `biweekly`
 * spelling. Migration 0099 rewrites the legacy portfolio `bi-weekly` value.
 * Current API writers accept only the canonical spelling.
 *
 * Both lists are append-only — the values are persisted — and share the same
 * canonical display order.
 */
/** Portfolio recurrence cadences. The API boundary accepts only these values. */
export const PORTFOLIO_RECURRENCE_INTERVALS = [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;

export type RecurrenceInterval =
  (typeof PORTFOLIO_RECURRENCE_INTERVALS)[number];

/**
 * Planned-transaction recurrence cadences. Mirrors
 * `planned_transactions.recurrence_pattern`. The backend grammar also accepts a
 * custom `every N days` form that is not in this tuple.
 */
export const PLANNED_RECURRENCE_PATTERNS = [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;

export type PlannedRecurrencePattern =
  (typeof PLANNED_RECURRENCE_PATTERNS)[number];
