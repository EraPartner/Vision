/**
 * Canonical recurrence vocabularies — the single place either list is edited.
 *
 * Both portfolio and planned transactions use the unhyphenated `biweekly`
 * spelling. Migration 0099 rewrites the legacy portfolio `bi-weekly` value.
 * API writers retain a one-release compatibility mapper for that legacy input,
 * but it is never emitted or persisted by current code.
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
