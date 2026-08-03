/**
 * Info sub-repository: bank account balances and daily balance history.
 */

import { query } from '../database/connection.js';
import { toDecimal, toNumber } from '../lib/money.js';
import { toYmd } from '../utils/portfolioMath.js';
import {
  COMPUTED_BALANCE_LATERAL,
  computedBalanceByCurrencyLateral,
  computedBalanceSeriesCtes,
  statementPartition,
} from './accountBalanceSql.js';
import {
  roundToCents,
  toWireDate,
  batchConvertGroupsWithHistoricalRateFallback,
} from './infoRepositoryHelpers.js';

export const banksRepository = {
  /**
   * Get current balance per account and daily historical balances over
   * the last 12 months.
   *
   * The current balance is sourced from the shared anchor+delta lateral
   * (`COMPUTED_BALANCE_LATERAL`, ADR-094) — the *same* single source the
   * accounts hub (`accountRepository.getAll`) consumes — so the dashboard
   * widget no longer diverges from the hub. The naive "latest stamped balance" it replaced froze
   * at the last imported statement figure, dropping manual/trade/brokerage
   * activity that leaves `transactions.balance` NULL. Grouped by account_id
   * (ADR-088); the label is sourced from `accounts.name` so the response
   * contract is unchanged while the bank_account string is being retired.
   *
   * Each account row additionally carries (WP-A1, additive — existing fields
   * are untouched):
   *   - `display_name`      — friendly label (falls back to `name`).
   *   - `drift`             — statement_balance − the reconciliation base (the
   *                           computed balance of the partition the statement is
   *                           a statement for), in that native currency — the
   *                           same figure as the hub's drift badge, since both
   *                           go through `statementPartition`; absent when no
   *                           statement balance is stored.
   *   - `anchor_date` / `post_anchor_count` — balance provenance from the
   *     shared lateral ("as of {date} statement + {n} entries since" vs
   *     "sum of {n} entries" when anchor_date is absent).
   *
   * Multi-currency accounts: the anchor+delta computation is partitioned by
   * `transactions.currency` (`computedBalanceByCurrencyLateral`) and each
   * partition is converted at its own rate before the per-account total is
   * summed. The previous single-partition form added a EUR amount to a USD
   * amount as bare numbers and converted the sum at the most recent row's rate
   * (100 EUR + 100 USD at rate 0.5 → 100 instead of 150). Single-currency accounts
   * have exactly one partition and are unaffected.
   *
   * The 12-month history uses that SAME definition evaluated as of each day,
   * and both sides convert at the rate of the day they represent (the history
   * at each day, the headline at today — `CURRENT_DATE`, where the series
   * ends). So the last history point equals `total_net_position`, in every
   * currency, by construction. The series is no longer gated on stamped rows
   * (which hid manual-only accounts from the chart while they counted in the
   * headline, and froze stamped accounts at their last statement figure). An
   * account contributes no point at all before its first active row (not a
   * zero, and not its first known balance carried backwards).
   */
  async getBankBalances(targetCurrency = 'EUR') {
    const accounts = [];

    // Both queries are independent — run in parallel, then batch-convert
    // with one historical-rate lookup instead of two.
    const [latestBalanceResult, historyResult] = await Promise.all([
      query(`
        SELECT a.name AS bank_account,
               COALESCE(a.display_name, a.name) AS display_name,
               bal.currency,
               bal.balance,
               -- Drift inputs, resolved in JS by the SAME shared helper the hub
               -- badge uses (statementPartition) so the two surfaces
               -- cannot disagree: the statement figure minus the partition it is
               -- a statement FOR — the account's own currency's, since
               -- a.statement_balance is one number carrying one date and sitting
               -- next to a.currency. It used to read the cross-currency
               -- lb.balance for hub parity, which put a Σ-of-bare-amounts drift
               -- next to a per-currency converted balance on the same badge; the
               -- hub now derives drift this way too, so parity holds on the
               -- correct figure instead of the wrong one.
               a.statement_balance,
               COALESCE(a.currency, 'EUR') AS account_currency,
               lb.anchor_date,
               lb.post_anchor_count,
               -- FX anchor for the conversion below: TODAY, the day this
               -- balance represents — the same day the history series ends on,
               -- so the headline and the last chart point convert at one rate.
               -- Keying it on the account's last activity instead (as this did)
               -- revalued a stamped foreign-currency account at the rate of its
               -- last statement while the chart moved with the daily rate: a
               -- USD account last imported 30 days ago showed 500 over a chart
               -- ending at 900. Native-currency figures (drift) are unaffected.
               to_char(CURRENT_DATE, 'YYYY-MM-DD') AS date,
               tx.transaction_count,
               tx.first_transaction,
               tx.last_transaction
        FROM accounts a
        ${COMPUTED_BALANCE_LATERAL}
        -- One row per currency the account holds, each with its own anchored
        -- running balance, converted independently below (the per-account total
        -- is summed after conversion). lb above stays the account-level
        -- (cross-currency) figure ONLY for the provenance fields — "as of {date}
        -- statement + {n} entries since" describes the account's stamping
        -- history, not one currency's — matching the accounts hub, which reads
        -- the same lateral for the same two fields.
        ${computedBalanceByCurrencyLateral({ account: 'a.id' })}
        JOIN LATERAL (
          -- Per-account activity metadata over active rows.
          SELECT COUNT(*) AS transaction_count,
                 MIN(t.date) AS first_transaction,
                 MAX(t.date) AS last_transaction
          FROM transactions t
          WHERE t.account_id = a.id AND t.is_active = true
        ) tx ON true
        WHERE a.type <> 'liability'
          -- §1 F3: in_net_worth governs aggregates (is_active governs UI
          -- listing) — closing an account sets in_net_worth=false, so it
          -- leaves this widget the moment it is closed, matching net worth.
          AND a.in_net_worth = true
          AND tx.transaction_count > 0
        ORDER BY a.name, bal.currency
      `),
      query(`
        WITH days AS (
          SELECT generate_series(
            CURRENT_DATE - interval '12 months',
            CURRENT_DATE,
            interval '1 day'
          )::date AS day
        ),
        account_list AS (
          SELECT a.id AS account_id, a.name AS bank_account
          FROM accounts a
          -- Same population rule as the current-balance query above (§1 F3):
          -- aggregates include only in_net_worth accounts.
          WHERE a.type <> 'liability'
            AND a.in_net_worth = true
            AND a.id IN (
              SELECT t.account_id FROM transactions t
               WHERE t.is_active = true AND t.account_id IS NOT NULL
            )
        ),
        -- The series carries the SAME per-currency anchor+delta definition the
        -- current balance above uses, evaluated at every day. The old "latest
        -- STAMPED balance ≤ day" probe (plus a WHERE lb.balance IS NOT NULL
        -- gate) dropped never-stamped accounts from the chart while they
        -- counted in total_net_position, and froze stamped accounts at their
        -- last statement, so today's chart point disagreed with the headline
        -- sitting above it. A day before the account's first active row still
        -- yields no point, so a series starts at first activity rather than
        -- back-filling zeroes.
        --
        -- Daily (not month-end) points: the dashboard Balance History chart's
        -- time-scale auto-ticks outnumbered monthly datapoints, duplicating
        -- month labels.
        --
        -- Note the series is bounded at each day while the headline (like the
        -- accounts hub) is unbounded, so a FUTURE-dated row counts in the
        -- headline before it reaches the chart. That is pre-existing and
        -- deliberate: bounding the headline instead would diverge it from the
        -- hub.
        ${computedBalanceSeriesCtes({ byCurrency: true })}
        -- to_char keeps the day a plain string (pg DATE → local-midnight JS Date
        -- otherwise — the recurring day-shift hazard).
        SELECT
          a.bank_account,
          to_char(s.day, 'YYYY-MM-DD') AS day,
          s.currency,
          s.balance
        FROM balance_series s
        JOIN account_list a ON a.account_id = s.account_id
        ORDER BY s.account_id, s.day, s.currency
      `),
    ]);

    const [currentBalancesConverted, historyConverted] =
      await batchConvertGroupsWithHistoricalRateFallback(
        [
          latestBalanceResult.rows.map((/** @type {{
            bank_account: string, display_name: string, currency: string|null,
            balance: string, statement_balance: string|null, account_currency: string,
            anchor_date: string|null, post_anchor_count: string|null,
            date: Date|null, transaction_count: string,
            first_transaction: Date|null, last_transaction: Date|null,
          }} */ r) => ({
            ...r,
            amount: toNumber(toDecimal(r.balance)),
            currency: r.currency || 'EUR',
          })),
          // History rows carry no `date`: the conversion helper falls back to
          // `day` (see resolveDateFromRow), which is the right FX anchor for an
          // as-of-that-day balance — and the convention net worth's history
          // already follows.
          historyResult.rows
            .filter((/** @type {{
              bank_account: string, day: string, currency: string,
              balance: string,
            }} */ r) => r.bank_account)
            .map((/** @type {{
              bank_account: string, day: string, currency: string,
              balance: string,
            }} */ r) => ({
              ...r,
              amount: toNumber(toDecimal(r.balance)),
              currency: r.currency || 'EUR',
            })),
        ],
        targetCurrency,
        'date'
      );

    // One row per (account, currency partition): sum the CONVERTED partitions
    // back into a single per-account balance, keeping the account metadata from
    // whichever partition arrived first (it is identical across them). The
    // NATIVE (unconverted) partitions are collected alongside so drift can be
    // resolved per currency once every partition has been seen.
    /** @type {Map<string, {
     *   account: Record<string, any>,
     *   balance: import('decimal.js').Decimal,
     *   parts: Array<{ currency: string, balance: string }>,
     *   statementBalance: string|null,
     *   accountCurrency: string,
     * }>} */
    const accountsByName = new Map();
    for (const row of currentBalancesConverted) {
      let entry = accountsByName.get(row.bank_account);
      if (!entry) {
        entry = {
          account: {
            bank_account: row.bank_account,
            display_name: row.display_name || row.bank_account,
            balance: 0,
            // Provenance (WP-A1): anchor_date is already a YYYY-MM-DD string via
            // to_char in the lateral; NULL (no stamp) → undefined.
            anchor_date: row.anchor_date == null ? undefined : row.anchor_date,
            post_anchor_count: row.post_anchor_count == null
              ? undefined
              : parseInt(row.post_anchor_count, 10),
            transaction_count: parseInt(row.transaction_count, 10),
            // DATE columns cross the wire as calendar-day strings: pg reads DATE
            // as a local-midnight Date, which JSON-serializes to the PREVIOUS
            // day east of UTC (lib/dateFormat.js).
            first_transaction: toWireDate(row.first_transaction),
            last_transaction: toWireDate(row.last_transaction),
          },
          balance: toDecimal(0),
          parts: [],
          statementBalance: row.statement_balance,
          accountCurrency: row.account_currency,
        };
        accountsByName.set(row.bank_account, entry);
        accounts.push(entry.account);
      }
      entry.balance = entry.balance.plus(toDecimal(row.amount_eur));
      entry.parts.push({ currency: row.currency, balance: row.balance });
    }
    let totalNetPositionDec = toDecimal(0);
    for (const entry of accountsByName.values()) {
      entry.account.balance = roundToCents(entry.balance);
      // Native-currency, per-currency drift — the statement figure minus its own
      // currency's partition, resolved by the shared helper so this badge and
      // the hub's (accountRepository.getAll) are the same number by
      // construction. No statement balance → undefined, never null (convention).
      entry.account.drift = entry.statementBalance == null
        ? undefined
        : roundToCents(toNumber(
          toDecimal(entry.statementBalance)
            .minus(toDecimal(statementPartition(entry.parts, entry.accountCurrency).balance)),
        ));
      totalNetPositionDec = totalNetPositionDec.plus(toDecimal(entry.account.balance));
    }
    const totalNetPosition = toNumber(totalNetPositionDec);

    // Same per-(account, day) fold: a multi-currency account contributes one
    // converted partition per currency to the same chart point.
    /** @type {Record<string, Map<string, import('decimal.js').Decimal>>} */
    const historyByDay = {};
    for (const row of historyConverted) {
      const key = row.bank_account;
      if (!historyByDay[key]) historyByDay[key] = new Map();
      // toYmd uses local getters for the defensive Date branch (the SQL emits
      // day via to_char, so this normally passes the string straight through).
      const day = toYmd(row.day);
      const dayTotals = historyByDay[key];
      dayTotals.set(day, (dayTotals.get(day) ?? toDecimal(0)).plus(toDecimal(row.amount_eur)));
    }

    /** @type {Record<string, Array<{ date: string, balance: number }>>} */
    const historyMap = {};
    for (const [key, dayTotals] of Object.entries(historyByDay)) {
      historyMap[key] = [...dayTotals.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, balance]) => ({ date, balance: roundToCents(balance) }));
    }

    const totalsByDate = new Map();
    for (const entries of Object.values(historyMap)) {
      for (const { date, balance } of entries) {
        totalsByDate.set(date, toNumber(toDecimal(totalsByDate.get(date) ?? 0).plus(toDecimal(balance))));
      }
    }
    const totalHistory = [...totalsByDate.keys()]
      .sort()
      .map((date) => ({ date, balance: roundToCents(totalsByDate.get(date)) }));

    return {
      accounts,
      total_net_position: roundToCents(totalNetPosition),
      history: historyMap,
      total_history: totalHistory,
    };
  },
};
