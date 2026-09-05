import { roundToCents } from "../lib/money.js";

/**
 * Shared SQL for an account's computed balance (ADR-094).
 *
 * The anchor+delta rule described below is the canonical *current*-balance
 * definition; `computedBalanceByCurrencyLateral` and `computedBalanceSeriesCtes`
 * below are the two forms that emit a figure from it (per-currency, and the same
 * figure as a daily series) and that the balance-history charts need in order to
 * agree with each other. `BALANCE_PROVENANCE_LATERAL` carries the provenance half
 * of the same rule.
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
 * account) exposing two columns. The account must be aliased `a`:
 *   - `anchor_date`       — the stamped anchor row's date as a 'YYYY-MM-DD'
 *                           string (to_char, so pg never hands back a
 *                           local-midnight JS Date), SQL NULL when nothing is
 *                           stamped. Provenance for "as of {date} bank
 *                           statement + {n} entries since" (WP-A1).
 *   - `post_anchor_count` — count of active rows strictly after the anchor;
 *                           with no stamp it is the total active-row count
 *                           (the "sum of {n} entries" case).
 *
 * It deliberately emits NO `balance`: at account level the delta sums
 * `transactions.amount` across currencies as bare numbers (100 EUR + 100 USD =
 * 200), which is why every consumer moved to the per-currency forms for the
 * figure and reads this lateral for the provenance fields only. The FX-blind
 * column — and the anchor/Σ terms that existed solely to produce it — are
 * stripped rather than left dangling, so no future consumer can pick it up.
 */
export function balanceProvenanceLateral({ asOfDate = "CURRENT_DATE" } = {}) {
  return `
  LEFT JOIN LATERAL (
    WITH anchor AS (
      SELECT t.date, t.id
      FROM transactions t
      WHERE t.account_id = a.id AND t.is_active = true
        AND t.date <= ${asOfDate}
        AND t.balance IS NOT NULL
      ORDER BY t.date DESC, t.id DESC
      LIMIT 1
    ),
    delta AS (
      SELECT COUNT(*) AS post_anchor_count
      FROM transactions t2
      WHERE t2.account_id = a.id AND t2.is_active = true
        AND t2.date <= ${asOfDate}
        AND (
          NOT EXISTS (SELECT 1 FROM anchor)
          OR (t2.date, t2.id) > (SELECT date, id FROM anchor)
        )
    )
    SELECT (SELECT to_char(date, 'YYYY-MM-DD') FROM anchor) AS anchor_date,
           (SELECT post_anchor_count FROM delta) AS post_anchor_count
  ) lb ON true
`;
}

const BALANCE_PROVENANCE_LATERAL = balanceProvenanceLateral();

/**
 * Same anchor+delta definition as {@link BALANCE_PROVENANCE_LATERAL}, but emitted
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
 * {@link BALANCE_PROVENANCE_LATERAL}.
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
 * @param {{ account: string, alias?: string, asOfDate?: string }} opts
 *   `account` is interpolated raw: pass a LITERAL SQL expression from the call
 *   site (`a.id`), never user input. `asOfDate` is likewise a literal SQL date
 *   expression; it defaults to `CURRENT_DATE` for current-balance callers.
 * @returns {string}
 */
export function computedBalanceByCurrencyLateral({
  account,
  alias = "bal",
  asOfDate = "CURRENT_DATE",
}) {
  return `
  JOIN LATERAL (
    SELECT ccy.currency,
           COALESCE(anch.balance, 0) + dlt.amount AS balance
    FROM (
      SELECT COALESCE(t.currency, 'EUR') AS currency
      FROM transactions t
      WHERE t.account_id = ${account} AND t.is_active = true
        AND t.date <= ${asOfDate}
      GROUP BY COALESCE(t.currency, 'EUR')
    ) ccy
    LEFT JOIN LATERAL (
      SELECT t.balance, t.date, t.id
      FROM transactions t
      WHERE t.account_id = ${account} AND t.is_active = true
        AND t.date <= ${asOfDate}
        AND t.balance IS NOT NULL
        AND COALESCE(t.currency, 'EUR') = ccy.currency
      ORDER BY t.date DESC, t.id DESC
      LIMIT 1
    ) anch ON true
    JOIN LATERAL (
      SELECT COALESCE(SUM(t2.amount), 0) AS amount
      FROM transactions t2
      WHERE t2.account_id = ${account} AND t2.is_active = true
        AND t2.date <= ${asOfDate}
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
 * @param {{ account: string, alias?: string, column?: string, asOfDate?: string }} opts
 *   `account` is interpolated raw: pass a LITERAL SQL expression from the call
 *   site (`a.id`), never user input.
 * @returns {string}
 */
export function computedBalanceByCurrencyAggLateral({
  account,
  alias = "bp",
  column = "balance_parts",
  asOfDate = "CURRENT_DATE",
}) {
  if (
    /[\r\n]/.test(account) ||
    !/^(?:[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*|ANY\(\$\d+::int\[\]\))$/i.test(
      account,
    )
  ) {
    throw new TypeError(
      "account must be a literal qualified column or ANY($n::int[]) expression",
    );
  }
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
    ${computedBalanceByCurrencyLateral({ account, alias: "bal", asOfDate })}
  ) ${alias} ON true
`;
}

/**
 * The partition a **statement figure** reconciles against, given an account's
 * `balance_parts` (see {@link computedBalanceByCurrencyAggLateral}).
 *
 * This is the single definition of the **reconciliation base**: the drift badge
 * (hub + dashboard), the `reconcilable_balance` the reconcile dialog previews
 * against, and what `reconcileService` actually stamps all read it, so the
 * number a user sees is by construction the number the server will write.
 *
 * `accounts.statement_balance` is one number carrying one date, and the column
 * next to it is `accounts.currency` — so it can only be read as the bank's
 * figure for the account's OWN currency. Drift is therefore that figure minus
 * that currency's partition, never minus a cross-currency sum (which added a
 * EUR amount to a USD amount as bare numbers) and never minus the FX-converted
 * total (which would make a reconciliation figure move with the daily rate,
 * and would size the reconcile 'adjustment' row by today's rate).
 *
 * Resolution order:
 *   1. The partition in the account's own currency, **even when it is zero** —
 *      a EUR account spent down to zero alongside some USD holdings has a EUR
 *      statement of 0, and must not silently start reconciling against the USD.
 *   2. Failing that, the ONE remaining partition once zero-sum partitions are
 *      dropped: a ledger of USD rows under an account still declared EUR is a
 *      mislabelled single-currency account, not an account with an empty EUR
 *      statement. Zero-sum partitions are dropped FIRST because they carry no
 *      reconciliation information and would otherwise make this rule
 *      discontinuous on noise — one cancelled/offsetting foreign transfer pair
 *      (net 0) used to flip the base from that lone partition to 0, and the
 *      drift from 0 to the whole balance. "Zero-sum" is judged at cents: a
 *      sub-cent residue (|sum| rounding to 0.00 under `roundToCents`) is the
 *      same noise a true zero is, since every consumer of the base rounds it
 *      to cents before using it.
 *   3. Otherwise zero, in the account's own currency: the statement figure
 *      names a currency this account holds nothing in.
 *
 * The returned `currency` is what the figure is denominated in — normally
 * `accounts.currency`, but the mislabelled-account case (2) returns the
 * partition's own code. Callers must label the base, the statement and the
 * drift with it (they are one native triple, `drift = statement − balance`),
 * and `reconcileService` stamps its adjustment row in it — an adjustment in any
 * other currency would land in a different partition and never clear the drift
 * it was sized against.
 *
 * @param {Array<{ currency: string, balance: string }>|null|undefined} parts
 * @param {string|null|undefined} accountCurrency `accounts.currency`.
 * @returns {{ currency: string, balance: string }} `balance` is a numeric
 *   string (pass it through `toDecimal`, like a NUMERIC column).
 */
export function statementPartition(parts, accountCurrency) {
  const want = (accountCurrency || "EUR").toUpperCase();
  const list = (parts ?? []).map((p) => ({
    currency: (p.currency || "EUR").toUpperCase(),
    balance: String(p.balance),
  }));

  const own = list.find((p) => p.currency === want);
  if (own) return own;

  // "Zero-sum" means "rounds to 0.00": partition sums are 4-dp NUMERIC strings,
  // so an accumulated rounding residue (0.0001) is not reconciliation
  // information any more than a true zero is — every downstream reading of the
  // base already collapses it (reconcileService rounds the base via
  // roundToCents before differencing, and DRIFT_EPSILON = 0.005 calls the
  // resulting drift reconciled). roundToCents is the codebase-canonical 2-dp
  // banker's rounding; money math here is uniformly 2-dp regardless of
  // currency (no per-currency minor-unit table exists), so a fixed cent
  // threshold is the consistent choice.
  const funded = list.filter((p) => !roundToCents(p.balance).isZero());
  if (funded.length === 1) return funded[0];

  return { currency: want, balance: "0" };
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
 *   {@link BALANCE_PROVENANCE_LATERAL}, and `currency` is a constant the caller
 *   should ignore. Names are interpolated raw: pass LITERAL CTE names.
 * @returns {string}
 */
export function computedBalanceSeriesCtes({
  byCurrency = false,
  accountList = "account_list",
  days = "days",
} = {}) {
  const currencyExpr = byCurrency ? `COALESCE(t.currency, 'EUR')` : `''::text`;
  // Only the per-currency form confines a partition to one currency; the
  // cross-currency form has a single partition per account.
  const samePartition = byCurrency
    ? `AND COALESCE(t.currency, 'EUR') = p.currency`
    : "";
  // The window partition drops the currency column entirely in cross-currency
  // mode: carrying a constant in the PARTITION BY only lengthens every sort key.
  const partitionBy = byCurrency ? "account_id, currency" : "account_id";
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
           ${byCurrency ? "p.currency" : "rc.row_currency"} AS row_currency,
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
    ${
      byCurrency
        ? ""
        : `LEFT JOIN LATERAL (
      SELECT COALESCE(t.currency, 'EUR') AS row_currency
      FROM transactions t
      WHERE t.account_id = p.account_id AND t.is_active = true
        AND t.date < (SELECT first_day FROM bs_span)
      ORDER BY t.date DESC, t.id DESC
      LIMIT 1
    ) rc ON true`
    }
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
  BALANCE_PROVENANCE_LATERAL,
  computedBalanceByCurrencyLateral,
  computedBalanceByCurrencyAggLateral,
  statementPartition,
  computedBalanceSeriesCtes,
};
