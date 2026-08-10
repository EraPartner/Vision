/**
 * Canonical recurrence vocabularies — the single place either list is edited.
 *
 * TWO lists, ONE concept. Vision spells "every two weeks" two different ways
 * depending on which subsystem stores the value, and both spellings are
 * load-bearing on the wire and in the database:
 *
 *   PORTFOLIO_RECURRENCE_INTERVALS — 'bi-weekly', WITH the hyphen. This is the
 *     `recurrence_interval` PG enum (migration 0001) behind
 *     `portfolio_transactions.recurrence_interval`, the `RecurrenceInterval`
 *     schema in openapi.yaml, and the portfolio transaction dialogs.
 *
 *   PLANNED_RECURRENCE_PATTERNS — 'biweekly', WITHOUT the hyphen. This is the
 *     app-side vocabulary for `planned_transactions.recurrence_pattern`,
 *     enforced by `chk_planned_transactions_recurrence_pattern` (migration
 *     0089) and recognised by the backend recurrence grammar. The grammar
 *     additionally accepts the custom `every N days` form, which is NOT a
 *     member of this list.
 *
 * The hyphen difference is the whole trap: `'bi-weekly'` written into
 * `recurrence_pattern` is rejected by 0089's CHECK, and before that CHECK
 * existed such rows rendered as biweekly in the UI but never advanced in the
 * calculator. Pick the list that matches the column you are writing.
 *
 * The two are deliberately NOT merged here. Unifying the spelling is a
 * BREAKING change and needs all of: a compat mapping on every read path, a data
 * migration rewriting stored rows, an `ALTER TYPE` on the PG enum (whose values
 * cannot be dropped), and an openapi.yaml change plus a `generate:types`
 * regeneration of the frontend's generated.ts. See
 * docs/reference/code-patterns.md ("Recurrence vocabulary") for the standing
 * rule: do not introduce `'bi-weekly'` into any new column.
 *
 * Both lists are append-only — the values are persisted — and share the same
 * canonical display order.
 */
export const PORTFOLIO_RECURRENCE_INTERVALS = [
  'daily', 'weekly', 'bi-weekly', 'monthly', 'quarterly', 'yearly',
];

export const PLANNED_RECURRENCE_PATTERNS = [
  'daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly',
];
