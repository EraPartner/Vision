/**
 * Monthly financial summary — materialized-view fast path plus
 * live-query fallback with category/recipient exclusions.
 *
 * ONE CLOCK, same rule as infoRepositoryForecast.js and
 * infoRepositoryAverageVsCurrent.js: every month-window edge here is anchored
 * on `todayAppDateString()` — the APP_TIMEZONE calendar day (ADR-009) — read
 * once per call and bound into the SQL as a 'YYYY-MM-DD' date parameter. The
 * SQL clock (`today()`, formerly PostgreSQL's `CURRENT_DATE`) is not used: it
 * follows the database's zone, not APP_TIMEZONE, so the two can disagree on
 * the calendar day for the hours around midnight — and on a month's last day
 * the SQL window set and the JS zero-fill key set disagreed by a whole month.
 */

import { sql } from "kysely";
import type { RawBuilder } from "kysely";
import { checkedRows, db } from "../database/db.ts";
import {
  liveMonthlyRowSchema,
  mvMonthlyRowSchema,
} from "../database/rows/info.ts";
import {
  validateInt4Ids,
  andClauses,
  exclusionClauses,
} from "../lib/filterBuilder.ts";
import { convertRowsToEur } from "../services/currency/currencyConversionService.ts";
import {
  createUnconvertedTally,
  noteUnconverted,
  unconvertedFields,
} from "../lib/unconvertedTally.ts";
import { logger } from "../config/logger.ts";
import {
  toDecimal,
  toNumber,
  roundMoney as roundToCents,
} from "../lib/money.ts";
import { formatDateToYmd, toWireDate } from "../lib/dateFormat.ts";
import { formatYearMonthKey } from "../lib/dateKeys.ts";
import { todayAppDateString, firstOfMonthYmd } from "../lib/timezone.ts";
import { nanToZero } from "../lib/math.ts";
import {
  mvAvailable,
  buildMonthlySummary,
  mapRowsForAmountConversion,
  getIncludeTransfers,
} from "./infoRepositoryHelpers.ts";

/** One month of the summary while it is being accumulated. */
interface MonthTotals {
  month: number;
  year: number;
  period_start: string | null;
  period_end: string | null;
  total_spending: number;
  total_income: number;
  net_amount: number;
  transaction_count: number;
}

/**
 * Round income and spending to cents, and derive the net from those rounded
 * parts so that net_amount = total_income + total_spending holds exactly in
 * the response (rounding the unrounded net could differ by a cent).
 */
function roundMonthTotals<T extends MonthTotals>(m: T): T {
  const total_spending = roundToCents(m.total_spending);
  const total_income = roundToCents(m.total_income);
  return {
    ...m,
    total_spending,
    total_income,
    net_amount: roundToCents(toDecimal(total_income).plus(total_spending)),
  };
}

export async function getMonthlyFinancialSummary(
  excludedCategoryIds: number[] = [],
  targetCurrency = "EUR",
  excludedRecipientIds: number[] = [],
  allTime = false,
  startDate?: string,
  endDate?: string,
  accountIds: number[] = [],
) {
  const validIds = validateInt4Ids(excludedCategoryIds, "excludedCategoryIds");
  // Empty means every account; the MV has no account grain, so a scope forces
  // the live path.
  const validAccountIds = validateInt4Ids(accountIds, "accountIds");
  const validRecipientIds = validateInt4Ids(
    excludedRecipientIds,
    "excludedRecipientIds",
  );
  logger.debug("getMonthlyFinancialSummary called", {
    excludedCategoryIds,
    validIds,
    validRecipientIds,
  });
  // The single clock for this call (ADR-009). Read ONCE, bound into whichever
  // path runs (MV filter or the live month series) and reused for the JS
  // zero-fill below, so the SQL month set and the JS key set can never
  // straddle a month rollover.
  const todayYmd = todayAppDateString();
  const includeTransfers = await getIncludeTransfers();

  // The MV is grained month×currency, so its fast path converts a whole month's
  // total at the 1st-of-month rate. That only matches the live per-(date,currency)
  // path when NO conversion happens — i.e. every MV row is already in the target
  // currency. If any row differs, fall through to the live path (whose own
  // comment explains intra-month FX varies). Avoids the dashboard's monthly
  // history visibly shifting when an unrelated exclusion toggles the path.
  const mvTarget = (targetCurrency || "EUR").toUpperCase();
  let mvCurrencyHomogeneous = false;
  const hasExplicitRange = Boolean(startDate || endDate);
  const mvUsable =
    !includeTransfers &&
    !allTime &&
    !hasExplicitRange &&
    validIds.length === 0 &&
    validRecipientIds.length === 0 &&
    validAccountIds.length === 0 &&
    (await mvAvailable("mv_monthly_summary"));
  if (mvUsable) {
    const hetero = await sql`SELECT 1 FROM mv_monthly_summary WHERE UPPER(currency) <> ${mvTarget} LIMIT 1`.execute(
      db,
    );
    mvCurrencyHomogeneous = hetero.rows.length === 0;
  }

  if (mvUsable && mvCurrencyHomogeneous) {
    // Upper bound matches the live path (whose month series ends at the
    // current month) — without it a post-dated transaction adds a future month
    // on the MV path only, so the dashboard month set changed with the code path.
    // Anchored on the bound app date, the same clock as the zero-fill.
    const dateFilterClause = sql`WHERE month_start >= add_months(date_trunc('month', ${todayYmd}), -5)
        AND month_start <= date_trunc('month', ${todayYmd})`;
    const mvRows = await checkedRows(
      mvMonthlyRowSchema,
      sql`
      SELECT month_start, month, year, currency,
             sum(transaction_count) AS "transaction_count::bigint",
             dec_sum(total_income) AS total_income,
             dec_sum(total_spending) AS total_spending,
             dec_sum(net_amount) AS net_amount
      FROM mv_monthly_summary
      ${dateFilterClause}
      GROUP BY month_start, month, year, currency
      ORDER BY month_start
    `,
    );

    const mergedRows = [];
    for (const r of mvRows) {
      const dateStr =
        r.month_start instanceof Date
          ? formatDateToYmd(r.month_start)
          : String(r.month_start);
      const monthKey = formatYearMonthKey(r.year, r.month);
      mergedRows.push({
        currency: r.currency,
        amount: toNumber(toDecimal(r.total_income)),
        _key: monthKey,
        _type: "income",
        _row: r,
        date: dateStr,
      });
      mergedRows.push({
        currency: r.currency,
        amount: toNumber(toDecimal(r.total_spending)),
        _key: monthKey,
        _type: "spending",
        _row: r,
        date: dateStr,
      });
    }
    const mergedConverted = await convertRowsToEur(mergedRows, targetCurrency, {
      useHistoricalRatesByDate: true,
      dateField: "date",
    });

    // Every MV row is already in the target currency (checked above), so no
    // row lacks a rate here; the tally keeps the response shape uniform.
    const unconverted = createUnconvertedTally();
    const monthMap: Record<string, MonthTotals> = {};
    for (const conv of mergedConverted) {
      const key = conv._key;
      const r = conv._row;
      if (conv.amount_eur === undefined) {
        if (conv._type === "income")
          noteUnconverted(
            unconverted,
            conv.currency,
            nanToZero(parseInt(r.transaction_count, 10)),
          );
        continue;
      }
      monthMap[key] ??= {
        month: r.month,
        year: r.year,
        period_start: toWireDate(r.month_start),
        period_end: null,
        total_spending: 0,
        total_income: 0,
        net_amount: 0,
        transaction_count: 0,
      };
      // Decimal accumulation (ADR money-hygiene): summing per-month EUR amounts
      // with native `+=` drifts sub-cent across many rows before the final round.
      if (conv._type === "income")
        monthMap[key].total_income = toNumber(
          toDecimal(monthMap[key].total_income).plus(
            toDecimal(conv.amount_eur),
          ),
        );
      else
        monthMap[key].total_spending = toNumber(
          toDecimal(monthMap[key].total_spending).plus(
            toDecimal(conv.amount_eur),
          ),
        );
      monthMap[key].net_amount = toNumber(
        toDecimal(monthMap[key].total_income).plus(
          toDecimal(monthMap[key].total_spending),
        ),
      );
      monthMap[key].transaction_count += parseInt(r.transaction_count, 10);
    }

    // Zero-fill months with no transactions so the MV path returns the SAME
    // 6-month set as the live path's month series. Without this, toggling an
    // exclusion (which switches paths) changed the dashboard's month set.
    // Uses the SAME app-timezone "today" (ADR-009) bound into the SQL above —
    // one clock reading, so the key set and the window set agree by
    // construction, at any hour.
    for (let i = 5; i >= 0; i--) {
      const monthStart = firstOfMonthYmd(todayYmd, -i);
      const year = Number(monthStart.slice(0, 4));
      const month = Number(monthStart.slice(5, 7));
      const key = formatYearMonthKey(year, month);
      monthMap[key] ??= {
        month,
        year,
        period_start: monthStart,
        period_end: null,
        total_spending: 0,
        total_income: 0,
        net_amount: 0,
        transaction_count: 0,
      };
    }

    for (const m of Object.values(monthMap)) {
      m.transaction_count = Math.round(m.transaction_count / 2);
    }

    const months = Object.values(monthMap)
      .sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month))
      .map((m) =>
        roundMonthTotals({
          ...m,
          period_end: formatDateToYmd(new Date(m.year, m.month, 0)),
        }),
      );

    return {
      months,
      summary: buildMonthlySummary(months),
      ...unconvertedFields(unconverted),
    };
  }

  // Canonical exclusion clauses: 3-level category COALESCE and alias-aware
  // recipient exclusion.
  const excl = exclusionClauses({
    excludedCategoryIds,
    excludedRecipientIds,
  });

  // Month bounds are DATEs (local calendar months, ADR-009): the app-date
  // anchor, or a caller's YYYY-MM-DD bound read as a date (ts_date is
  // PostgreSQL's `::date`).
  let rangeStart = allTime
    ? sql`COALESCE((SELECT date_trunc('month', min(date)) FROM transactions WHERE is_active = 1), date_trunc('month', ${todayYmd}))`
    : sql`add_months(date_trunc('month', ${todayYmd}), -5)`;
  let rangeEnd = sql`date_trunc('month', ${todayYmd})`;
  const transactionFilters: RawBuilder<unknown>[] = [];
  if (!allTime && startDate) {
    rangeStart = sql`date_trunc('month', ts_date(${startDate}))`;
    transactionFilters.push(sql`t.date >= ts_date(${startDate})`);
  }
  if (!allTime && endDate) {
    rangeEnd = sql`date_trunc('month', ts_date(${endDate}))`;
    transactionFilters.push(sql`t.date <= ts_date(${endDate})`);
  }
  if (validAccountIds.length > 0) {
    transactionFilters.push(
      sql`t.account_id IN (SELECT value FROM json_each(${JSON.stringify(validAccountIds)}))`,
    );
  }

  // Aggregate per (date, currency) in SQL instead of streaming every transaction
  // into JS. This path converts at each transaction's historical date rate
  // (useHistoricalRatesByDate below), so we can only collapse rows that share a
  // rate — i.e. the same date+currency. Within such a group every row uses the
  // same rate, and rate > 0 preserves sign, so:
  //   • SUM(amount) FILTER (amount >= 0) converted == Σ converted incomes
  //   • SUM(amount) FILTER (amount <  0) converted == Σ converted spendings
  // making this numerically identical to the old per-transaction loop while
  // pushing the heavy exact SUM/COUNT into the database. (A month-level GROUP
  // BY would NOT be valid here because intra-month FX varies.)
  //
  // `months` is every month start from rangeStart through rangeEnd inclusive
  // (PostgreSQL's generate_series over '1 month'); empty when the start lies
  // after the end.
  const monthlyQuery = sql`
    WITH RECURSIVE bounds AS (
      SELECT ${rangeStart} AS first_month, ${rangeEnd} AS last_month
    ),
    months(month_start) AS (
      SELECT first_month FROM bounds WHERE first_month <= last_month
      UNION ALL
      SELECT add_months(m.month_start, 1)
      FROM months m, bounds b
      WHERE add_months(m.month_start, 1) <= b.last_month
    ),
    filtered_transactions AS (
      SELECT
        t.amount,
        t.currency,
        t.date,
        -- Canonical 3-level effective category (own → recipient default →
        -- PRIMARY recipient's default), matching transactionRepository and the
        -- mv_monthly_summary definition. The exclusion clauses above already
        -- resolve 3 levels via exclusionClauses, so this column keeps the
        -- CTE's own resolution consistent with them.
        COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS effective_category_id
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.is_active = 1
      ${includeTransfers ? sql`` : sql`AND t.is_transfer = 0`}
      ${excl.where}
      ${andClauses(transactionFilters)}
    ),
    daily AS (
      SELECT
        date,
        date_trunc('month', date) AS month_start,
        currency,
        count(*) AS cnt,
        COALESCE(dec_sum(amount) FILTER (WHERE dec_sign(amount) >= 0), '0') AS income_amount,
        COALESCE(dec_sum(amount) FILTER (WHERE dec_sign(amount) < 0), '0') AS spending_amount
      FROM filtered_transactions
      GROUP BY date, currency
    )
    SELECT
      date_part('month', m.month_start) AS month,
      date_part('year', m.month_start) AS year,
      m.month_start AS "period_start::date",
      month_end(m.month_start) AS "period_end::date",
      d.date AS "date::date", d.currency, d.cnt AS "cnt::bigint", d.income_amount, d.spending_amount
    FROM months m
    -- An equality on the month (not a date range) lets the planner hash the
    -- join; the range form compared every day with every month.
    LEFT JOIN daily d ON d.month_start = m.month_start
    ORDER BY m.month_start, d.date
  `;
  logger.debug("Monthly summary SQL executing", {
    exclusions: excl.active,
    transactionFilterCount: transactionFilters.length,
  });

  const liveRows = await checkedRows(liveMonthlyRowSchema, monthlyQuery);
  logger.debug("Monthly summary query returned", {
    rowCount: liveRows.length,
  });

  const dailyRows = liveRows.filter((r) => r.date != null);
  // Convert each (date, currency) income/spending aggregate at that date's rate.
  const [incomeConverted, spendingConverted] = await Promise.all([
    convertRowsToEur(
      mapRowsForAmountConversion(dailyRows, "income_amount", false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: "date" },
    ),
    convertRowsToEur(
      mapRowsForAmountConversion(dailyRows, "spending_amount", false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: "date" },
    ),
  ]);

  const monthMap: Record<string, MonthTotals> = {};
  for (const row of liveRows) {
    const key = formatYearMonthKey(row.year, row.month);
    monthMap[key] ??= {
      month: row.month,
      year: row.year,
      period_start: toWireDate(row.period_start),
      period_end: toWireDate(row.period_end),
      total_spending: 0,
      total_income: 0,
      net_amount: 0,
      transaction_count: 0,
    };
  }

  // A (date, currency) group without a stored rate is left out of its month
  // (amounts and transaction count) and counted once in `unconverted_count`.
  const unconverted = createUnconvertedTally();
  for (const [i, row] of dailyRows.entries()) {
    const key = formatYearMonthKey(row.year, row.month);
    // Every live row seeded its month above, and convertRowsToEur returns one
    // converted row per input row, in order.
    const totals = monthMap[key];
    const income = incomeConverted[i];
    const spending = spendingConverted[i];
    if (!totals || !income || !spending) {
      throw new Error(
        "monthly summary: converted rows out of step with daily rows",
      );
    }
    if (income.amount_eur === undefined || spending.amount_eur === undefined) {
      noteUnconverted(unconverted, row.currency, nanToZero(Number(row.cnt)));
      continue;
    }
    totals.total_income = toNumber(
      toDecimal(totals.total_income).plus(toDecimal(income.amount_eur)),
    );
    totals.total_spending = toNumber(
      toDecimal(totals.total_spending).plus(toDecimal(spending.amount_eur)),
    );
    totals.net_amount = toNumber(
      toDecimal(totals.total_income).plus(toDecimal(totals.total_spending)),
    );
    totals.transaction_count += Number(row.cnt);
  }

  const months = Object.values(monthMap)
    .sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month))
    .map(roundMonthTotals);

  return {
    months,
    summary: buildMonthlySummary(months),
    ...unconvertedFields(unconverted),
  };
}
