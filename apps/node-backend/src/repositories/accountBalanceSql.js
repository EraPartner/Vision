/**
 * Shared SQL for an account's *current* computed balance (ADR-094).
 *
 * The naive "latest active transaction with a non-null balance" lateral froze
 * at the last *imported* statement balance: `transactions.balance` is only
 * stamped by bank-CSV adapters, so manual entries, trade cash legs, and
 * brokerage cash fan-out (which leave it NULL) never advanced the figure. That
 * stale balance then poisoned the accounts hub, the drift badge
 * (statement_balance − computed_balance), per-account net worth, and the
 * rebalance available-cash input.
 *
 * Switching wholesale to Σ(amount) (as `mv_bank_balances` does) would instead
 * drop the opening balance, because the bank's stamped balance embeds all
 * activity prior to the first imported row while Σ(amount) only sums the rows
 * we actually hold.
 *
 * This reconciles both: anchor on the most recent stamped bank balance (which
 * embeds the opening balance), then add the amounts of every active row posted
 * strictly after that anchor (the unstamped trade/manual/brokerage activity).
 * When nothing is stamped at all, it falls back to the full Σ(amount), matching
 * `mv_bank_balances`.
 *
 * The lateral always returns exactly one row (so a LEFT JOIN never drops the
 * account) exposing a single `balance` column. The account must be aliased `a`.
 */
export const COMPUTED_BALANCE_LATERAL = `
  LEFT JOIN LATERAL (
    WITH anchor AS (
      SELECT t.balance, t.date, t.id
      FROM transactions t
      WHERE t.account_id = a.id AND t.is_active = true AND t.balance IS NOT NULL
      ORDER BY t.date DESC, t.id DESC
      LIMIT 1
    )
    SELECT COALESCE((SELECT balance FROM anchor), 0)
         + COALESCE((
             SELECT SUM(t2.amount)
             FROM transactions t2
             WHERE t2.account_id = a.id AND t2.is_active = true
               AND (
                 NOT EXISTS (SELECT 1 FROM anchor)
                 OR (t2.date, t2.id) > (SELECT date, id FROM anchor)
               )
           ), 0) AS balance
  ) lb ON true
`;

export default { COMPUTED_BALANCE_LATERAL };
