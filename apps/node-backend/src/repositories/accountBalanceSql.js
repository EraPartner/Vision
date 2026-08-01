/**
 * Shared SQL for an account's computed balance (ADR-094).
 *
 * `COMPUTED_BALANCE_LATERAL` is the canonical *current*-balance definition;
 * `computedBalanceByCurrencyLateral` and `computedBalanceSeriesCtes` below are
 * the two derived forms (per-currency, and the same figure as a daily series)
 * that the balance-history charts need in order to agree with it.
 *
 * The naive "latest active transaction with a non-null balance" lateral froze
 * at the last *imported* statement balance: `transactions.balance` is only
 * stamped by bank-CSV adapters, so manual entries, trade cash legs, and
 * brokerage cash fan-out (which leave it NULL) never advanced the figure. That
 * stale balance then poisoned the accounts hub, the drift badge
 * (statement_balance − computed_balance), per-account net worth, and the
 * rebalance available-cash input.
 *
 * Switching wholesale to a plain Σ(amount) would instead drop the opening
 * balance, because the bank's stamped balance embeds all activity prior to the
 * first imported row while Σ(amount) only sums the rows we actually hold. (This
 * is exactly why the old all-time-Σ `mv_bank_balances` view was ADR-094-wrong
 * and has since been dropped.)
 *
 * This reconciles both: anchor on the most recent stamped bank balance (which
 * embeds the opening balance), then add the amounts of every active row posted
 * strictly after that anchor (the unstamped trade/manual/brokerage activity).
 * When nothing is stamped at all, it falls back to the full Σ(amount).
 *
 * The lateral always returns exactly one row (so a LEFT JOIN never drops the
 * account) exposing three columns. The account must be aliased `a`:
 *   - `balance`           — the anchored running balance described above.
 *   - `anchor_date`       — the stamped anchor row's date as a 'YYYY-MM-DD'
 *                           string (to_char, so pg never hands back a
 *                           local-midnight JS Date), SQL NULL when nothing is
 *                           stamped. Provenance for "as of {date} bank
 *                           statement + {n} entries since" (WP-A1).
 *   - `post_anchor_count` — count of active rows strictly after the anchor;
 *                           with no stamp it is the total active-row count
 *                           (the "sum of {n} entries" case).
 */
export const COMPUTED_BALANCE_LATERAL = `
  LEFT JOIN LATERAL (
    WITH anchor AS (
      SELECT t.balance, t.date, t.id
      FROM transactions t
      WHERE t.account_id = a.id AND t.is_active = true AND t.balance IS NOT NULL
      ORDER BY t.date DESC, t.id DESC
      LIMIT 1
    ),
    delta AS (
      SELECT COALESCE(SUM(t2.amount), 0) AS amount,
             COUNT(*) AS post_anchor_count
      FROM transactions t2
      WHERE t2.account_id = a.id AND t2.is_active = true
        AND (
          NOT EXISTS (SELECT 1 FROM anchor)
          OR (t2.date, t2.id) > (SELECT date, id FROM anchor)
        )
    )
    SELECT COALESCE((SELECT balance FROM anchor), 0)
         + (SELECT amount FROM delta) AS balance,
           (SELECT to_char(date, 'YYYY-MM-DD') FROM anchor) AS anchor_date,
           (SELECT post_anchor_count FROM delta) AS post_anchor_count
  ) lb ON true
`;

/**
 * Same anchor+delta definition as {@link COMPUTED_BALANCE_LATERAL}, but emitted
 * **per currency**: one row per currency the account holds.
 *
 * Why it exists: `SUM(t2.amount)` in the unpartitioned lateral adds a EUR
 * amount to a USD amount as bare numbers, and the caller then converts that
 * total at the ONE rate belonging to the most recent row's currency — 100 EUR +
 * 100 USD at rate 0.5 came out as 100 EUR instead of 150. Partitioning the
 * whole anchor+delta computation by currency and converting each partition
 * separately is the only correct reading.
 *
 * Partition semantics (the composition question): a stamped
 * `transactions.balance` is the bank's statement figure **for the currency of
 * the row that carries it** — `transactions.currency` is per row, so there is
 * no other consistent reading. An anchor therefore anchors *only its own
 * currency's* partition; amounts in any other currency are summed from scratch
 * in their own partition (they were never embedded in that statement figure).
 * A statement-anchored EUR balance plus later USD deltas yields
 * `(EUR: anchor + later EUR rows)` and `(USD: Σ USD rows)` — the anchor's
 * partition carries the anchor, and nothing else does.
 *
 * For a single-currency account (the overwhelmingly common case) there is
 * exactly one partition, its anchor is the account's latest stamped row and its
 * delta is every active row after that anchor — i.e. byte-identical to
 * {@link COMPUTED_BALANCE_LATERAL}.
 *
 * Emits ZERO rows for an account with no active rows at all (rather than a
 * synthetic 0); every caller already excludes those accounts.
 *
 * Columns exposed under `alias`:
 *   - `currency` — partition currency (`COALESCE(t.currency, 'EUR')`).
 *   - `balance`  — anchored running balance for that currency. It is a
 *                  *current* balance, so callers convert it at today's rate,
 *                  not at the partition's last-activity date.
 *
 * @param {{ account: string, alias?: string }} opts
 *   `account` is interpolated raw: pass a LITERAL SQL expression from the call
 *   site (`a.id`), never user input.
 * @returns {string}
 */
export function computedBalanceByCurrencyLateral({ account, alias = 'bal' }) {
  return `
  JOIN LATERAL (
    SELECT ccy.currency,
           COALESCE(anch.balance, 0) + dlt.amount AS balance
    FROM (
      SELECT COALESCE(t.currency, 'EUR') AS currency
      FROM transactions t
      WHERE t.account_id = ${account} AND t.is_active = true
      GROUP BY COALESCE(t.currency, 'EUR')
    ) ccy
    LEFT JOIN LATERAL (
      SELECT t.balance, t.date, t.id
      FROM transactions t
      WHERE t.account_id = ${account} AND t.is_active = true
        AND t.balance IS NOT NULL
        AND COALESCE(t.currency, 'EUR') = ccy.currency
      ORDER BY t.date DESC, t.id DESC
      LIMIT 1
    ) anch ON true
    JOIN LATERAL (
      SELECT COALESCE(SUM(t2.amount), 0) AS amount
      FROM transactions t2
      WHERE t2.account_id = ${account} AND t2.is_active = true
        AND COALESCE(t2.currency, 'EUR') = ccy.currency
        AND (anch.date IS NULL OR (t2.date, t2.id) > (anch.date, anch.id))
    ) dlt ON true
  ) ${alias} ON true
`;
}

/**
 * {@link computedBalanceByCurrencyLateral} folded to **one row per account**:
 * the partitions arrive as a single JSON array instead of one SQL row apiece.
 *
 * Why it exists: the row-per-partition form fans an account out across several
 * rows, which is fine for a caller that immediately re-folds them
 * (`getBankBalances`) but wrong for callers whose rows ARE accounts —
 * `accountRepository.getAll` pages with LIMIT/OFFSET (partition-grained rows
 * would slice an account in half), `assembleRebalanceInputs` emits one
 * `cashAccounts` entry per account, and net worth's `.length > 0` guard means
 * "there are in-net-worth accounts". It is also a LEFT join, so an account with
 * no active rows at all keeps its row (with a NULL array) rather than vanishing
 * — every one of those callers lists accounts that legitimately hold no ledger
 * activity (a fresh account, a portfolio account whose activity lives in
 * `portfolio_transactions`).
 *
 * Exposes ONE column under `alias`:
 *   - `balance_parts` — `[{ currency, balance }, …]` ordered by currency, or
 *     SQL NULL when the account has no active rows. `balance` is emitted as a
 *     **string** (`::text`): a JSON number would round-trip a NUMERIC through
 *     an IEEE double before `toDecimal` ever sees it. Feed each entry through
 *     `toDecimal(part.balance)` exactly as you would a NUMERIC column.
 *
 * Conversion is the caller's job and must happen per partition, at today's
 * rate (these are *current* balances) — see
 * {@link computedBalanceByCurrencyLateral} for why summing first is wrong.
 *
 * @param {{ account: string, alias?: string, column?: string }} opts
 *   `account` is interpolated raw: pass a LITERAL SQL expression from the call
 *   site (`a.id`), never user input.
 * @returns {string}
 */
export function computedBalanceByCurrencyAggLateral({
  account,
  alias = 'bp',
  column = 'balance_parts',
}) {
  return `
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object('currency', bal.currency, 'balance', bal.balance::text)
             ORDER BY bal.currency
           ) AS ${column}
    -- A one-row driver so the shared per-currency lateral (which is written as
    -- a JOIN onto a preceding FROM item) can be spliced in unchanged; the
    -- correlation to ${account} reaches through both nesting levels.
    FROM (SELECT 1) ${alias}_drv
    ${computedBalanceByCurrencyLateral({ account, alias: 'bal' })}
  ) ${alias} ON true
`;
}

/**
 * The partition a **statement figure** belongs to, given an account's
 * `balance_parts` (see {@link computedBalanceByCurrencyAggLateral}).
 *
 * `accounts.statement_balance` is one number carrying one date, and the column
 * next to it is `accounts.currency` — so it can only be read as the bank's
 * figure for the account's OWN currency. Drift is therefore that figure minus
 * that currency's partition, never minus a cross-currency sum (which added a
 * EUR amount to a USD amount as bare numbers) and never minus the FX-converted
 * total (which would make a reconciliation figure move with the daily rate,
 * and would size the reconcile 'adjustment' row by today's rate).
 *
 * One deliberate exception: an account holding exactly ONE currency reconciles
 * against that partition whatever its code, even when it disagrees with
 * `accounts.currency` — a ledger of USD rows under an account still declared
 * EUR is a mislabelled single-currency account, not an account with an empty
 * USD statement. This keeps every single-currency account byte-identical to the
 * pre-partition behaviour.
 *
 * @param {Array<{ currency: string, balance: string }>|null|undefined} parts
 * @param {string|null|undefined} accountCurrency `accounts.currency`.
 * @returns {string} the partition's balance as a numeric string ('0' when the
 *   account holds no partition in its own currency).
 */
export function statementPartitionBalance(parts, accountCurrency) {
  if (!parts || parts.length === 0) return '0';
  if (parts.length === 1) return String(parts[0].balance);
  const want = (accountCurrency || 'EUR').toUpperCase();
  const match = parts.find((p) => (p.currency || 'EUR').toUpperCase() === want);
  return match ? String(match.balance) : '0';
}

/**
 * The same anchor+delta balance as a **daily series**: one row per
 * (account[, currency], day) over a caller-supplied day grid.
 *
 * Evaluating the lateral above once per (account, day) is the obvious
 * formulation and is O(days × rows): every day re-sums the whole post-anchor
 * window, and for a never-stamped account that window is the account's entire
 * history. Measured on a 15k-row / 5-year ledger that form ran ~2.3s against
 * the ~50ms of the stamped-only probe both history queries used before this
 * change (the shipped baseline these numbers are compared against). This
 * computes the identical figures in one pass over the rows plus one over the
 * spans they cover, via the identity
 *
 *     balance(day) = cum(last row ≤ day) + adj(last stamped row ≤ day)
 *     where  cum(r) = Σ amounts up to and including r
 *            adj(r) = r.balance − cum(r)     (0 when nothing is stamped yet)
 *
 * which is just `anchor.balance + Σ(amounts after the anchor)` rearranged:
 * `adj` is the constant that the bank's statement figure adds on top of our own
 * running sum, and it only changes when a newer stamp arrives.
 *
 * Emits CTE definitions (comma-terminated, to splice into a WITH chain AFTER
 * the caller's own) ending in `balance_series(account_id, currency, day,
 * balance, row_currency)`, where `row_currency` is the currency of the latest
 * active row on or before that day — the FX currency for a cross-currency
 * (`byCurrency: false`) series, and redundant with `currency` otherwise. The
 * caller must already define:
 *   - `account_list(account_id, …)` — the accounts in scope.
 *   - `days(day)`                   — the day grid. Only its MIN/MAX are read;
 *                                     the emitted series is dense between them,
 *                                     which for the dense grids both callers
 *                                     generate is the same set of days.
 *
 * Series edges: a day before the account's first active row yields NO row (its
 * first known balance is never carried backwards). Activity that predates the
 * grid is folded onto the grid's first day, so a series that started earlier
 * opens at its true running balance rather than at zero. Rows after the grid's
 * last day are excluded, so a future-dated transaction does not leak backwards.
 *
 * @param {{ byCurrency?: boolean, accountList?: string, days?: string }} [opts]
 *   `byCurrency` partitions the whole computation by `transactions.currency`
 *   (each partition anchored by its own stamps — see
 *   {@link computedBalanceByCurrencyLateral} for why that is the only
 *   consistent reading). With it false the sum is cross-currency, matching
 *   {@link COMPUTED_BALANCE_LATERAL}, and `currency` is a constant the caller
 *   should ignore. Names are interpolated raw: pass LITERAL CTE names.
 * @returns {string}
 */
export function computedBalanceSeriesCtes({
  byCurrency = false,
  accountList = 'account_list',
  days = 'days',
} = {}) {
  const currencyExpr = byCurrency ? `COALESCE(t.currency, 'EUR')` : `''::text`;
  // Only the per-currency form confines a partition to one currency; the
  // cross-currency form has a single partition per account.
  const samePartition = byCurrency ? `AND COALESCE(t.currency, 'EUR') = p.currency` : '';
  // The window partition drops the currency column entirely in cross-currency
  // mode: carrying a constant in the PARTITION BY only lengthens every sort key.
  const partitionBy = byCurrency ? 'account_id, currency' : 'account_id';
  return `
  bs_span AS (
    SELECT MIN(day) AS first_day, MAX(day) AS last_day FROM ${days}
  ),
  bs_opening AS (
    -- Everything that happened BEFORE the grid, collapsed into one synthetic row
    -- per (account[, currency]): a 12-month chart over a 5-year ledger otherwise
    -- drags all five years through the window pass below just to know where the
    -- window opens. The row is dated the day before the grid and carries the
    -- anchor+delta balance as of then, in the balance column — i.e. it enters
    -- the machinery below as a *stamp*, which is exactly what a carried-in
    -- balance is (it embeds all prior activity, so its own amount is 0).
    -- Empty when the grid starts at or before the account's first row, which is
    -- the net-worth case.
    SELECT p.account_id,
           p.currency,
           ${byCurrency ? 'p.currency' : 'rc.row_currency'} AS row_currency,
           (SELECT first_day FROM bs_span) - 1 AS date,
           -1 AS id,
           COALESCE(anch.balance, 0) + dlt.amount AS balance,
           0::numeric AS amount
    FROM (
      SELECT DISTINCT t.account_id, ${currencyExpr} AS currency
      FROM transactions t
      JOIN ${accountList} bs_al ON bs_al.account_id = t.account_id
      WHERE t.is_active = true AND t.date < (SELECT first_day FROM bs_span)
    ) p
    LEFT JOIN LATERAL (
      SELECT t.balance, t.date, t.id
      FROM transactions t
      WHERE t.account_id = p.account_id AND t.is_active = true
        AND t.balance IS NOT NULL
        AND t.date < (SELECT first_day FROM bs_span)
        ${samePartition}
      ORDER BY t.date DESC, t.id DESC
      LIMIT 1
    ) anch ON true
    JOIN LATERAL (
      SELECT COALESCE(SUM(t.amount), 0) AS amount
      FROM transactions t
      WHERE t.account_id = p.account_id AND t.is_active = true
        AND t.date < (SELECT first_day FROM bs_span)
        ${samePartition}
        AND (anch.date IS NULL OR (t.date, t.id) > (anch.date, anch.id))
    ) dlt ON true
    ${byCurrency ? '' : `LEFT JOIN LATERAL (
      SELECT COALESCE(t.currency, 'EUR') AS row_currency
      FROM transactions t
      WHERE t.account_id = p.account_id AND t.is_active = true
        AND t.date < (SELECT first_day FROM bs_span)
      ORDER BY t.date DESC, t.id DESC
      LIMIT 1
    ) rc ON true`}
  ),
  bs_src AS (
    SELECT account_id, currency, row_currency, date, id, balance, amount
    FROM bs_opening
    UNION ALL
    SELECT t.account_id,
           ${currencyExpr},
           COALESCE(t.currency, 'EUR'),
           t.date, t.id, t.balance, t.amount
    FROM transactions t
    JOIN ${accountList} bs_al ON bs_al.account_id = t.account_id
    WHERE t.is_active = true
      AND t.date >= (SELECT first_day FROM bs_span)
      AND t.date <= (SELECT last_day FROM bs_span)
  ),
  bs_rows AS (
    -- Everything that can share ONE ordering of the rows is computed here, in a
    -- single window pass: the running sum, and (via LEAD) the flag marking the
    -- last row of each day. Splitting these across CTEs with different window
    -- partitions costs a full re-sort of the ledger apiece.
    -- The day column clamps the opening row onto the grid's first day; because
    -- it is monotonic along the window order, "last row of the day" is simply
    -- "the next row belongs to another day".
    SELECT account_id,
           currency,
           row_currency,
           date,
           id,
           balance,
           GREATEST(date, (SELECT first_day FROM bs_span)) AS day,
           LEAD(GREATEST(date, (SELECT first_day FROM bs_span))) OVER bs_w AS next_day,
           SUM(amount) OVER bs_w AS cum
    FROM bs_src
    WINDOW bs_w AS (PARTITION BY ${partitionBy} ORDER BY date, id)
  ),
  bs_carry AS (
    -- Carry the latest stamp's adj (balance − cum) forward. MAX over the packed
    -- [date, id, adj] array IS that carry-forward: the array compares
    -- element-wise, (date, id) is unique, and the frame is everything up to the
    -- current row — so the maximum is the newest stamp at or before it, and
    -- element 3 is its adj. Written this way to reuse bs_rows' ordering; the
    -- readable alternative (FIRST_VALUE over a COUNT(balance) grouping) needs a
    -- different partition and therefore a second sort of the whole ledger.
    SELECT account_id, currency, row_currency, day, next_day, cum,
           MAX(CASE WHEN balance IS NOT NULL
                    THEN ARRAY[(date - DATE '2000-01-01')::numeric, id::numeric, balance - cum]
               END) OVER (PARTITION BY ${partitionBy} ORDER BY date, id) AS stamp
    FROM bs_rows
  ),
  bs_day_end AS (
    -- End-of-day balance per (account[, currency], day). No stamp yet → the
    -- carry is NULL and the balance is the plain running sum.
    SELECT account_id, currency, row_currency, day,
           cum + COALESCE(stamp[3], 0) AS balance
    FROM bs_carry
    WHERE next_day IS DISTINCT FROM day
  ),
  bs_spans AS (
    -- Each day-end balance holds until the day before the next one (or the end
    -- of the grid). Expanding these spans is what fills the quiet days.
    SELECT account_id, currency, balance, row_currency,
           day AS from_day,
           COALESCE(
             LEAD(day) OVER (PARTITION BY ${partitionBy} ORDER BY day) - 1,
             (SELECT last_day FROM bs_span)
           ) AS thru_day
    FROM bs_day_end
  ),
  balance_series AS (
    -- Expand rather than join: forward-filling by LEFT JOINing a dense grid
    -- against a statistics-less CTE let the planner demote the day column from
    -- the merge key to a join filter, making the fill O(days²) per account —
    -- measured 27× slower end-to-end than the stamped probe this replaced.
    -- generate_series emits each span's days directly, so the fill costs one
    -- row per output row and no join at all.
    SELECT s.account_id, s.currency, g.day::date AS day, s.balance, s.row_currency
    FROM bs_spans s
    CROSS JOIN LATERAL generate_series(s.from_day, s.thru_day, interval '1 day') AS g(day)
  )`;
}

export default {
  COMPUTED_BALANCE_LATERAL,
  computedBalanceByCurrencyLateral,
  computedBalanceByCurrencyAggLateral,
  statementPartitionBalance,
  computedBalanceSeriesCtes,
};
