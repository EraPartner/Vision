import { sql } from "kysely";
import type { RawBuilder } from "kysely";
import { bankChronologySql } from "./bankChronologySql.ts";
import { roundToCents } from "../lib/money.ts";
import { storedCurrencyCode } from "../lib/currencyCode.ts";
import type { CurrencyCode } from "@vision/types/brands";

/** The backend's local calendar day (ADR-009): PostgreSQL's CURRENT_DATE. */
const TODAY = sql`today()`;

/**
 * Shared SQL for an account's computed balance (ADR-094).
 *
 * The anchor+delta rule described below is the canonical *current*-balance
 * definition; `computedBalanceByCurrencyLateral` and `computedBalanceSeriesCtes`
 * below are the two forms that emit a figure from it (per-currency, and the same
 * figure as a daily series) and that the balance-history charts need in order to
 * agree with each other. `balanceProvenanceLateral` carries the provenance half
 * of the same rule.
 *
 * The naive "latest active transaction with a non-null balance" probe froze
 * at the last *imported* statement balance: `transactions.balance` is only
 * stamped by bank-CSV adapters, so manual entries, trade cash legs, and
 * brokerage cash fan-out (which leave it NULL) never advanced the figure. That
 * stale balance then poisoned the accounts hub, the drift badge
 * (selected statement reading − computed balance), per-account net worth, and the
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
 * SQLite has no LATERAL (ADR-263), so the "laterals" here are LEFT JOINs onto
 * a derived table keyed by account id whose columns are correlated scalar
 * subqueries over that account; the names are kept for their callers. Money is
 * summed with dec_sum/dec_add (exact) and the chronology key is the text
 * `dec_key` of bankChronologySql.
 */

/** The `t.date, chronology, t.id` order key of an alias, newest first. */
function newestFirst(alias: string): RawBuilder<unknown> {
  const t = sql.id(alias);
  return sql`${t}.date DESC, ${bankChronologySql(alias)} DESC, ${t}.id DESC`;
}

/**
 * Rows of `row` posted strictly after the anchor row `anchor` in bank
 * chronology, or every row when there is no anchor (`anchor.id IS NULL`).
 * The plain date bound is implied by the row comparison; it lets the
 * (account_id, currency, date) index skip the rows before the anchor.
 */
function afterAnchor(row: string, anchor: string): RawBuilder<unknown> {
  const r = sql.id(row);
  const a = sql.id(anchor);
  return sql`(${a}.id IS NULL OR (${r}.date >= ${a}.date
      AND (${r}.date, ${bankChronologySql(row)}, ${r}.id) > (${a}.date, ${bankChronologySql(anchor)}, ${a}.id)))`;
}

/**
 * The account-level (cross-currency) provenance of the computed balance, as a
 * LEFT JOIN that always matches exactly one row per account (so it never
 * drops the account), exposing two columns under `lb`. The account must be
 * aliased `a`:
 *   - `anchor_date`       — the stamped anchor row's date as a 'YYYY-MM-DD'
 *                           string (to_char, so the driver never hands back a
 *                           local-midnight JS Date), SQL NULL when nothing is
 *                           stamped. Provenance for "as of {date} bank
 *                           statement + {n} entries since" (WP-A1).
 *   - `post_anchor_count` — count of active rows strictly after the anchor;
 *                           with no stamp it is the total active-row count
 *                           (the "sum of {n} entries" case). Decimal text, as
 *                           PostgreSQL's bigint COUNT(*) arrived.
 *
 * It deliberately emits NO `balance`: at account level the delta sums
 * `transactions.amount` across currencies as bare numbers (100 EUR + 100 USD =
 * 200), which is why every consumer moved to the per-currency forms for the
 * figure and reads this join for the provenance fields only. The FX-blind
 * column — and the anchor/Σ terms that existed solely to produce it — are
 * stripped rather than left dangling, so no future consumer can pick it up.
 *
 * @param opts `asOfDate` is a SQL date expression ('YYYY-MM-DD' text), default
 *   `today()`.
 */
export function balanceProvenanceLateral({
  asOfDate = TODAY,
}: { asOfDate?: RawBuilder<unknown> } = {}): RawBuilder<unknown> {
  return sql`
  LEFT JOIN (
    SELECT lb_anchor.lb_account_id,
           to_char(lb_anc.date, 'YYYY-MM-DD') AS anchor_date,
           CAST((
             SELECT COUNT(*)
             FROM transactions t2
             WHERE t2.account_id = lb_anchor.lb_account_id AND t2.is_active = 1
               AND t2.date <= ${asOfDate}
               AND ${afterAnchor("t2", "lb_anc")}
           ) AS TEXT) AS post_anchor_count
    FROM (
      SELECT lb_acc.id AS lb_account_id,
             (SELECT t.id
                FROM transactions t
               WHERE t.account_id = lb_acc.id AND t.is_active = 1
                 AND t.date <= ${asOfDate}
                 AND t.balance IS NOT NULL
               ORDER BY ${newestFirst("t")}
               LIMIT 1) AS anchor_id
      FROM accounts lb_acc
    ) lb_anchor
    LEFT JOIN transactions lb_anc ON lb_anc.id = lb_anchor.anchor_id
  ) lb ON lb.lb_account_id = a.id
`;
}

/**
 * The per-currency partitions as a SELECT of `(account_id, currency, balance)`
 * rows: the anchor+delta balance of each currency an account has active rows
 * in on or before `asOfDate`. With `account` (a column of an enclosing query,
 * which the subquery is then correlated to) only that account's partitions;
 * without it, every account's.
 */
function partitionBalancesSelect(
  asOfDate: RawBuilder<unknown>,
  account?: RawBuilder<unknown>,
): RawBuilder<unknown> {
  return sql`
    SELECT ccy.account_id, ccy.currency,
           dec_add(COALESCE(anch.balance, '0'), (
             SELECT COALESCE(dec_sum(t2.amount), '0')
             FROM transactions t2
             WHERE t2.account_id = ccy.account_id AND t2.is_active = 1
               AND t2.date <= ${asOfDate}
               AND t2.currency = ccy.currency
               AND ${afterAnchor("t2", "anch")}
           )) AS balance
    FROM (
      SELECT g.account_id, g.currency,
             (SELECT t.id
                FROM transactions t
               WHERE t.account_id = g.account_id AND t.is_active = 1
                 AND t.date <= ${asOfDate}
                 AND t.balance IS NOT NULL
                 AND t.currency = g.currency
               ORDER BY ${newestFirst("t")}
               LIMIT 1) AS anchor_id
      FROM (
        SELECT t.account_id, COALESCE(t.currency, 'EUR') AS currency
        FROM transactions t
        WHERE ${account === undefined ? sql`t.account_id IS NOT NULL` : sql`t.account_id = ${account}`}
          AND t.is_active = 1
          AND t.date <= ${asOfDate}
        GROUP BY t.account_id, COALESCE(t.currency, 'EUR')
      ) g
    ) ccy
    LEFT JOIN transactions anch ON anch.id = ccy.anchor_id`;
}

/**
 * Same anchor+delta definition as {@link balanceProvenanceLateral}, but emitted
 * **per currency**: one row per currency the account holds.
 *
 * Why it exists: `SUM(t2.amount)` in the unpartitioned form adds a EUR
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
 * {@link balanceProvenanceLateral}'s anchor and count.
 *
 * Emits ZERO rows for an account with no active rows at all (rather than a
 * synthetic 0); every caller already excludes those accounts. It is an inner
 * JOIN onto the partitions of every account, matched on `account`.
 *
 * Columns exposed under `alias`:
 *   - `currency` — partition currency (`COALESCE(t.currency, 'EUR')`).
 *   - `balance`  — anchored running balance for that currency, exact decimal
 *                  text. It is a *current* balance, so callers convert it at
 *                  today's rate, not at the partition's last-activity date.
 *
 * @param opts
 *   `account` is the outer query's account-id column (`a.id`); `asOfDate` is a
 *   SQL date expression ('YYYY-MM-DD' text) and defaults to `today()` for
 *   current-balance callers. Values inside either are bound parameters.
 *   `alias` is emitted as a quoted identifier.
 */
export function computedBalanceByCurrencyLateral({
  account,
  alias = "bal",
  asOfDate = TODAY,
}: {
  account: RawBuilder<unknown>;
  alias?: string;
  asOfDate?: RawBuilder<unknown>;
}): RawBuilder<unknown> {
  const key = sql.id(`${alias}_account_id`);
  return sql`
  JOIN (
    SELECT bal_part.account_id AS ${key}, bal_part.currency, bal_part.balance
    FROM (${partitionBalancesSelect(asOfDate)}) bal_part
  ) ${sql.id(alias)} ON ${sql.id(alias)}.${key} = ${account}
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
 *   - `balance_parts` — `[{ balance, currency }, …]` ordered by currency, or
 *     SQL NULL when the account has no active rows. `balance` is emitted as a
 *     **string**: a JSON number would round-trip a NUMERIC through an IEEE
 *     double before `toDecimal` ever sees it. Feed each entry through
 *     `toDecimal(part.balance)` exactly as you would a NUMERIC column. Keys are
 *     in jsonb order (`balance` before `currency`), as PostgreSQL returned them.
 *
 * The column is JSON text with no declared type: select it with the alias
 * hint, `bp.balance_parts AS "balance_parts::json"` (see
 * {@link balancePartsColumn}), so the driver parses it.
 *
 * Conversion is the caller's job and must happen per partition, at today's
 * rate (these are *current* balances) — see
 * {@link computedBalanceByCurrencyLateral} for why summing first is wrong.
 *
 * @param opts
 *   As for {@link computedBalanceByCurrencyLateral}; `alias` and `column` are
 *   emitted as quoted identifiers.
 */
export function computedBalanceByCurrencyAggLateral({
  account,
  alias = "bp",
  column = "balance_parts",
  asOfDate = TODAY,
}: {
  account: RawBuilder<unknown>;
  alias?: string;
  column?: string;
  asOfDate?: RawBuilder<unknown>;
}): RawBuilder<unknown> {
  // The derived table is one row per account whose only computed column is a
  // correlated scalar subquery, so SQLite evaluates it for the joined accounts
  // only. json_group_array has no ORDER BY before SQLite 3.44: it folds the
  // rows of a subquery ordered by currency. Over zero rows it would be '[]',
  // so the CASE keeps PostgreSQL's NULL for an account without active rows.
  const key = sql.id(`${alias}_account_id`);
  return sql`
  LEFT JOIN (
    SELECT bp_acc.id AS ${key},
           (SELECT CASE WHEN COUNT(*) = 0 THEN NULL
                        ELSE json_group_array(json_object('balance', bp_part.balance, 'currency', bp_part.currency))
                   END
              FROM (${partitionBalancesSelect(asOfDate, sql`bp_acc.id`)}
                    ORDER BY ccy.currency) bp_part) AS ${sql.id(column)}
    FROM accounts bp_acc
  ) ${sql.id(alias)} ON ${sql.id(alias)}.${key} = ${account}
`;
}

/**
 * The select-list entry for {@link computedBalanceByCurrencyAggLateral}'s
 * column with its `::json` alias hint, so the row carries the parsed array
 * under `column`.
 */
export function balancePartsColumn(
  alias = "bp",
  column = "balance_parts",
): RawBuilder<unknown> {
  return sql`${sql.id(alias)}.${sql.id(column)} AS ${sql.id(`${column}::json`)}`;
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
 * Each statement reading names its currency. Drift is therefore that figure
 * minus the matching currency partition, never minus a cross-currency sum (which added a
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
 * @param accountCurrency `accounts.currency`.
 * @returns `balance` is a numeric string (pass it through `toDecimal`, like a
 *   NUMERIC column).
 */
export function statementPartition(
  parts: Array<{ currency: CurrencyCode; balance: string }> | null | undefined,
  accountCurrency: CurrencyCode | null | undefined,
): { currency: CurrencyCode; balance: string } {
  const want = storedCurrencyCode(accountCurrency);
  const list = (parts ?? []).map((p) => ({
    currency: storedCurrencyCode(p.currency),
    balance: p.balance,
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
  const [onlyFunded] = funded;
  if (funded.length === 1 && onlyFunded) return onlyFunded;

  return { currency: want, balance: "0" };
}

/**
 * The same anchor+delta balance as a **daily series**: one row per
 * (account[, currency], day) over a caller-supplied day grid.
 *
 * Evaluating the per-currency join above once per (account, day) is the obvious
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
 *   - `days(day)`                   — the day grid as 'YYYY-MM-DD' date text.
 *                                     Only its MIN/MAX are read; the emitted
 *                                     series is dense between them, which for
 *                                     the dense grids both callers generate is
 *                                     the same set of days.
 *
 * `balance_series.day` is 'YYYY-MM-DD' text without a declared type (select it
 * as `day AS "day::date"` for the local-midnight Date a DATE column gives) and
 * `balance` is exact decimal text.
 *
 * Series edges: a day before the account's first active row yields NO row (its
 * first known balance is never carried backwards). Activity that predates the
 * grid is folded onto the grid's first day, so a series that started earlier
 * opens at its true running balance rather than at zero. Rows after the grid's
 * last day are excluded, so a future-dated transaction does not leak backwards.
 *
 * @param opts
 *   `byCurrency` partitions the whole computation by `transactions.currency`
 *   (each partition anchored by its own stamps — see
 *   {@link computedBalanceByCurrencyLateral} for why that is the only
 *   consistent reading). With it false the sum is cross-currency, matching
 *   {@link balanceProvenanceLateral}, and `currency` is a constant the caller
 *   should ignore. Names are emitted as quoted identifiers.
 */
export function computedBalanceSeriesCtes({
  byCurrency = false,
  accountList = "account_list",
  days = "days",
}: { byCurrency?: boolean; accountList?: string; days?: string } = {}): RawBuilder<unknown> {
  const currencyExpr = byCurrency ? sql`COALESCE(t.currency, 'EUR')` : sql`''`;
  // Only the per-currency form confines a partition to one currency; the
  // cross-currency form has a single partition per account. `t.currency` is
  // NOT NULL, so it equals COALESCE(t.currency, 'EUR') and keeps the
  // (account_id, currency, date) index usable.
  const samePartition = (p: string) =>
    byCurrency ? sql`AND t.currency = ${sql.id(p)}.currency` : sql``;
  // The window partition drops the currency column entirely in cross-currency
  // mode: carrying a constant in the PARTITION BY only lengthens every sort key.
  const partitionBy = byCurrency ? sql`account_id, currency` : sql`account_id`;
  const accountListTable = sql.id(accountList);
  const daysTable = sql.id(days);
  const firstDay = sql`(SELECT first_day FROM bs_span)`;
  return sql`
  bs_span AS (
    SELECT MIN(day) AS first_day, MAX(day) AS last_day FROM ${daysTable}
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
           ${
             byCurrency
               ? sql`p.currency`
               : sql`(
             SELECT COALESCE(t.currency, 'EUR')
             FROM transactions t
             WHERE t.account_id = p.account_id AND t.is_active = 1
               AND t.date < ${firstDay}
             ORDER BY ${newestFirst("t")}
             LIMIT 1
           )`
           } AS row_currency,
           add_days(${firstDay}, -1) AS date,
           -1 AS id,
           dec_key('-1') AS chronology,
           dec_add(COALESCE(anch.balance, '0'), (
             SELECT COALESCE(dec_sum(t.amount), '0')
             FROM transactions t
             WHERE t.account_id = p.account_id AND t.is_active = 1
               AND t.date < ${firstDay}
               ${samePartition("p")}
               AND ${afterAnchor("t", "anch")}
           )) AS balance,
           '0' AS amount
    FROM (
      SELECT p0.account_id, p0.currency,
             (SELECT t.id
                FROM transactions t
               WHERE t.account_id = p0.account_id AND t.is_active = 1
                 AND t.balance IS NOT NULL
                 AND t.date < ${firstDay}
                 ${samePartition("p0")}
               ORDER BY ${newestFirst("t")}
               LIMIT 1) AS anchor_id
      FROM (
        SELECT DISTINCT t.account_id, ${currencyExpr} AS currency
        FROM transactions t
        JOIN ${accountListTable} bs_al ON bs_al.account_id = t.account_id
        WHERE t.is_active = 1 AND t.date < ${firstDay}
      ) p0
    ) p
    LEFT JOIN transactions anch ON anch.id = p.anchor_id
  ),
  bs_src AS (
    SELECT account_id, currency, row_currency, date, id, chronology, balance, amount
    FROM bs_opening
    UNION ALL
    SELECT t.account_id,
           ${currencyExpr},
           COALESCE(t.currency, 'EUR'),
           t.date, t.id, ${bankChronologySql("t")}, t.balance, t.amount
    FROM transactions t
    JOIN ${accountListTable} bs_al ON bs_al.account_id = t.account_id
    WHERE t.is_active = 1
      AND t.date >= ${firstDay}
      AND t.date <= (SELECT last_day FROM bs_span)
  ),
  bs_rows AS (
    -- Everything that can share ONE ordering of the rows is computed here, in a
    -- single window pass: the running sum, the running count of stamps (which
    -- numbers each row's stamp group: the latest stamp at or before it opens
    -- it, group 0 has none) and (via LEAD) the flag marking the last row of
    -- each day. The day column clamps the opening row onto the grid's first
    -- day; because it is monotonic along the window order, "last row of the
    -- day" is simply "the next row belongs to another day". Dates are
    -- 'YYYY-MM-DD' text and the chronology a dec_key, so both order as text.
    SELECT account_id,
           currency,
           row_currency,
           date,
           id,
           chronology,
           balance,
           greatest(date, ${firstDay}) AS day,
           LEAD(greatest(date, ${firstDay})) OVER bs_w AS next_day,
           dec_sum(amount) OVER bs_w AS cum,
           COUNT(balance) OVER bs_w AS stamp_group
    FROM bs_src
    WINDOW bs_w AS (PARTITION BY ${partitionBy} ORDER BY date, chronology, id)
  ),
  bs_carry AS (
    -- Carry the latest stamp's adj (balance − cum) forward: a stamp opens its
    -- group and is the group's only stamped row, so the sum of adj over the
    -- group is exactly that stamp's adj (NULL in group 0, before any stamp).
    SELECT account_id, currency, row_currency, day, next_day, cum,
           dec_sum(CASE WHEN balance IS NOT NULL THEN dec_sub(balance, cum) END)
             OVER (PARTITION BY ${partitionBy}, stamp_group) AS adj
    FROM bs_rows
  ),
  bs_day_end AS (
    -- End-of-day balance per (account[, currency], day). No stamp yet → the
    -- carry is NULL and the balance is the plain running sum.
    SELECT account_id, currency, row_currency, day,
           dec_add(cum, COALESCE(adj, '0')) AS balance
    FROM bs_carry
    WHERE next_day IS NOT day
  ),
  bs_spans AS (
    -- Each day-end balance holds until the day before the next one (or the end
    -- of the grid). Expanding these spans is what fills the quiet days.
    SELECT account_id, currency, balance, row_currency,
           day AS from_day,
           COALESCE(
             add_days(LEAD(day) OVER (PARTITION BY ${partitionBy} ORDER BY day), -1),
             (SELECT last_day FROM bs_span)
           ) AS thru_day
    FROM bs_day_end
  ),
  bs_fill AS (
    -- Expand rather than join: forward-filling by LEFT JOINing a dense grid
    -- against a statistics-less CTE made the fill O(days²) per account. The
    -- recursive CTE emits each span's days directly (generate_series in
    -- PostgreSQL), so the fill costs one row per output row and no join.
    SELECT account_id, currency, from_day AS day, balance, row_currency, thru_day
    FROM bs_spans
    WHERE from_day <= thru_day
    UNION ALL
    SELECT account_id, currency, add_days(day, 1), balance, row_currency, thru_day
    FROM bs_fill
    WHERE day < thru_day
  ),
  balance_series AS (
    SELECT account_id, currency, day, balance, row_currency
    FROM bs_fill
  )`;
}
