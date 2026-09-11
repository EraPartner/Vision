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
export const PORTFOLIO_RECURRENCE_INTERVALS = [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
];

export const PLANNED_RECURRENCE_PATTERNS = [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
];
