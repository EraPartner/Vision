/**
 * Cash-flow forecast queries:
 *   - getCashflowComparison: cumulative-daily avg-vs-current for chart.
 *   - getCashflowForecastData: raw daily-net series for forecast pipeline.
 *   - getCashflowForecastDataByCategory: per-category variant.
 *
 * Two module-wide conventions, both load-bearing:
 *
 * 1. ONE CLOCK. Every window edge and every piece of month/day arithmetic in
 *    this file is anchored on `todayAppDateString()` — the APP_TIMEZONE
 *    calendar day (ADR-009) — read once per call and threaded into the SQL as
 *    a bound `$n::date` parameter. Postgres `CURRENT_DATE` is NOT used here:
 *    it follows the DB session's zone (UTC), so with the default
 *    APP_TIMEZONE=Europe/Brussels the two clocks name different calendar days
 *    between ~22:00/23:00 UTC and midnight. On a month's last day that
 *    difference is a whole month of arithmetic: the JS side was already in
 *    month M+1 (so it treated M as the last complete month and counted it in
 *    the historical-average divisor) while the SQL windows still ended at the
 *    start of M (so M's rows never reached the numerator). Same-clock is the
 *    invariant; see the pins in tests/infoRepoForecast(.db).test.js, which fix
 *    the clock at exactly that instant.
 *
 * 2. NO INTERPOLATED VALUES. Every runtime value reaching the SQL — the anchor
 *    date, the caller-supplied `historyMonths`/`daysBack`/`daysForward`, and
 *    the module's own `HISTORY_MONTHS` — is bound, never template-interpolated,
 *    using `make_interval(months => $n::int)` / `make_interval(days => $n::int)`
 *    for the interval arithmetic. The `Number.isInteger` + range checks stay as
 *    input validation (they answer 400 on nonsense), but they are no longer the
 *    only thing standing between a caller and injection. Exclusion params keep
 *    $1..$k (buildExclusionClauses); this file's own params are allocated after
 *    them from `excl.nextParamIdx`, and each query passes exactly the
 *    contiguous prefix of $-indices it references.
 */

import { query } from "../database/connection.js";
import {
  addAll,
  divide,
  roundMoney as roundToCents,
  toNumber,
} from "../lib/money.js";
import { formatDateToYmd } from "../lib/dateFormat.js";
import {
  mapRowsForAmountConversion,
  batchConvertGroupsWithHistoricalRateFallback,
  getIncludeTransfers,
} from "./infoRepositoryHelpers.js";
import { todayAppDateString } from "../lib/timezone.js";
import { ValidationError } from "../middleware/errorHandler.js";
import { buildExclusionClauses } from "../lib/filterBuilder.js";
import {
  countObservedMonths,
  monthKeyFromDbDate,
} from "../lib/observedMonths.js";

/** @param {unknown} value */
function safeMoneyInput(value) {
  return Number.isFinite(Number(value))
    ? /** @type {number|string} */ (value)
    : 0;
}

/** @param {...(number|string)} values */
const addMoney = (...values) => toNumber(addAll(values));

// Sum converted rows into a sorted per-day net series (SIMP-50).
/**
 * @param {Array<Record<string, any>>} rows Converted rows with `date` + `amount_eur`.
 * @returns {Array<{ date: string, net: number }>}
 */
function aggregateByDate(rows) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const r of rows) {
    const iso =
      r.date instanceof Date
        ? formatDateToYmd(r.date)
        : String(r.date).slice(0, 10);
    map.set(iso, addMoney(map.get(iso) ?? 0, safeMoneyInput(r.amount_eur)));
  }
  return Array.from(map, ([date, net]) => ({ date, net })).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
}

/*
 * Denominator for the historical monthly average.
 *
 * The lookback is N *complete, already-elapsed* calendar months ending with the
 * month before the current one. Two failure modes bracket the right answer:
 *
 *  - Dividing by "months that happen to carry rows" (the old behaviour) reports
 *    a single busy month at FULL weight: 240 in one month of a 24-month window
 *    became an "average" of 240. An elapsed month with no rows is a real
 *    observation — the user spent nothing — and must count as a zero.
 *  - Dividing by the whole window unconditionally deflates a short ledger: a
 *    user who installed three months ago has no data for month -20 because the
 *    app did not exist for them, not because they spent nothing. Charging them
 *    21 phantom zeros would shrink the average line ~8x.
 *
 * So the divisor is the span from the month the ledger started through the last
 * complete month, inclusive — "elapsed months since this ledger has history,
 * capped at the lookback window". Empty months inside that span count as zero;
 * months before the ledger's first entry are not counted at all.
 *
 * `ledgerStartMonth` MUST come from an unfiltered probe of `transactions`
 * (sqlLedgerStart below), never from the month keys of the filtered result set
 * — see the comment on that query for why, and for why a planned row cannot
 * establish it.
 *
 * The shared implementation lives in lib/observedMonths.js so this 24-month
 * report and the six-month average-vs-current card cannot drift apart.
 */
// Average, across months, of the running cumulative day-of-month net (SIMP-50).
// `monthDayNet` is { monthKey: { dayOfMonth: net } }. `monthCount` is the
// divisor from countObservedMonths — NOT Object.keys(monthDayNet).length, see
// that function for why.
/**
 * @param {Record<string, Record<string, number>>} monthDayNet
 * @param {number} monthCount Months to divide by (>= 1).
 * @returns {Record<string, number>} day-of-month → average cumulative net
 */
function computeAvgCumulativeByDay(monthDayNet, monthCount) {
  const monthKeys = Object.keys(monthDayNet);
  /** @type {Record<string, number>} */
  const out = {};
  for (const mk of monthKeys) {
    const dayNet = monthDayNet[mk];
    let cum = 0;
    for (let d = 1; d <= 31; d++) {
      cum = addMoney(cum, dayNet[d] || 0);
      out[d] = addMoney(out[d] || 0, cum);
    }
  }
  for (const d of Object.keys(out)) {
    out[d] = toNumber(divide(out[d], monthCount));
  }
  return out;
}

/**
 * @param {number[]} [excludedCategoryIds]
 * @param {number[]} [excludedRecipientIds]
 * @param {string} [targetCurrency]
 */
export async function getCashflowComparison(
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = "EUR",
) {
  // The single clock for this call (ADR-009). Read ONCE, used for the JS month
  // arithmetic below AND bound into every SQL window below in place of
  // CURRENT_DATE — see convention 1 at the top of this file.
  const todayYmd = todayAppDateString();
  const daysInMonth = new Date(
    Date.UTC(Number(todayYmd.slice(0, 4)), Number(todayYmd.slice(5, 7)), 0),
  ).getUTCDate();
  const currentDay = Number(todayYmd.slice(8, 10));
  const HISTORY_MONTHS = 24;

  // Canonical exclusion clauses (lib/filterBuilder.js). The joins are only
  // needed when a clause actually references r/pr, so they stay conditional.
  const excl = buildExclusionClauses({
    excludedCategoryIds,
    excludedRecipientIds,
  });
  const categoryExclusionJoin = excl.whereSql ? excl.joinSql : "";
  const categoryExclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : "";
  const excludeParams = excl.params;

  // This function's own bound params, allocated AFTER the exclusion params so
  // the exclusion numbering ($1..$k) is untouched. Each query below passes the
  // contiguous prefix it actually references — Postgres derives the parameter
  // count from the highest $n in the text, so a referenced-but-unsupplied (or
  // skipped) index is an error, not a no-op.
  const pDate = excl.nextParamIdx; // the APP_TIMEZONE anchor date
  const pMonths = pDate + 1; // HISTORY_MONTHS
  const anchor = `$${pDate}::date`;

  // ADR-083: internal transfers must not inflate cash-flow aggregates unless
  // the user opts in via the runtime `includeTransfers` setting. Identical
  // predicate and identical setting read as the sibling surfaces rendered on
  // the same dashboard (infoRepositoryAverageVsCurrent.js:22-23,
  // infoRepositoryMonthly.js:38/194, infoRepositoryStatistics.js:19/129) —
  // without it a checking->savings transfer's outflow leg was counted here and
  // excluded there, so two cards on one dashboard disagreed on one fixture.
  const includeTransfers = await getIncludeTransfers();
  const transferFilter = includeTransfers ? "" : "AND t.is_transfer = false";

  // Aggregate in SQL per (date, currency) rather than streaming every row to
  // Node. batchConvertGroupsWithHistoricalRateFallback converts by (currency,
  // date), and every consumer below re-buckets by date — and rows sharing a
  // (date, currency) share one rate — so SUM-then-convert is identical to
  // convert-then-SUM. day_of_month/month_key are deterministic functions of the
  // grouped date column, so they remain valid in the SELECT list.
  const sqlPast = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date,
           EXTRACT(DAY FROM t.date)::int AS day_of_month,
           TO_CHAR(date_trunc('month', t.date), 'YYYY-MM') AS month_key
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', ${anchor}) - make_interval(months => $${pMonths}::int)
      AND t.date < date_trunc('month', ${anchor})
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;

  const sqlCurrent = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date,
           EXTRACT(DAY FROM t.date)::int AS day_of_month
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', ${anchor})
      AND t.date <= ${anchor}
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;

  // The two planned_transactions overlays below carry NO transfer predicate:
  // ADR-083 added `is_transfer` / `transfer_peer_id` to `transactions` only,
  // and planned_transactions has no such column. Planned rows are user-authored
  // future intents, not reconciled bank legs, so there is no detected pair to
  // net out; a user who plans an internal transfer excludes it the pre-ADR-083
  // way, via category/recipient exclusions.
  //
  // These two carry no exclusion params, so they number their own from $1
  // ($1 = the anchor date, $2 = HISTORY_MONTHS) rather than reusing `anchor`.
  const sqlPlannedCurrent = `
    SELECT SUM(pt.amount) AS amount, pt.currency, pt.planned_date,
           EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', $1::date)
      AND pt.planned_date <= (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')
    GROUP BY pt.planned_date, pt.currency
  `;

  const sqlPlannedHist = `
    SELECT SUM(pt.amount) AS amount, pt.currency, pt.planned_date,
           EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month,
           TO_CHAR(date_trunc('month', pt.planned_date), 'YYYY-MM') AS month_key
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', $1::date) - make_interval(months => $2::int)
      AND pt.planned_date < date_trunc('month', $1::date)
    GROUP BY pt.planned_date, pt.currency
  `;

  // Ledger start for the historical-average divisor (countObservedMonths).
  // Deliberately UNFILTERED — no exclusions, no transfer predicate — and kept
  // LAST in the Promise.all so the four data queries keep their call order.
  //
  // "When did this ledger start having history" is a property of the ledger,
  // not of the current view. Deriving it from the month keys of the filtered
  // result set let a category/recipient exclusion — or the ADR-083 transfer
  // filter itself — empty the oldest months and silently re-base the divisor,
  // so toggling an exclusion moved the average line by a factor that had
  // nothing to do with the excluded rows.
  //
  // It also reads `transactions` ONLY. A planned row must never establish the
  // start: a recurring plan the auto-linker never matched keeps its original
  // past `planned_date` forever, and letting one un-executed row dated 24
  // months back set the divisor deflated a one-month-old ledger's average 24x
  // — precisely the "short history" failure this divisor exists to prevent. A
  // planned row inside the window still contributes its numerator; it just
  // cannot extend the timeline backwards. Both historical series then share
  // this one divisor, so the overlay stays commensurable with the base line.
  //
  // `is_active` applies because a soft-deleted row is not history; the window
  // floor applies because a row older than the lookback cannot shorten it. Its
  // floor is anchored on the SAME bound date as everything else, so the month
  // it reports and the month arithmetic below cannot straddle a rollover.
  // Unfiltered means no *predicates* — the two bound values are the window
  // itself, not a filter on the ledger.
  const sqlLedgerStart = `
    SELECT MIN(t.date) AS first_date
    FROM transactions t
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', $1::date) - make_interval(months => $2::int)
  `;

  const [
    pastResult,
    currentResult,
    plannedCurrentResult,
    plannedHistResult,
    ledgerStartResult,
  ] = await Promise.all([
    query(sqlPast, [...excludeParams, todayYmd, HISTORY_MONTHS]),
    query(sqlCurrent, [...excludeParams, todayYmd]),
    query(sqlPlannedCurrent, [todayYmd]),
    query(sqlPlannedHist, [todayYmd, HISTORY_MONTHS]),
    query(sqlLedgerStart, [todayYmd, HISTORY_MONTHS]),
  ]);

  const [
    pastConverted,
    currentCashflowConverted,
    plannedCurrentConverted,
    plannedHistConverted,
  ] = await batchConvertGroupsWithHistoricalRateFallback(
    [
      mapRowsForAmountConversion(pastResult.rows, "amount", false),
      mapRowsForAmountConversion(currentResult.rows, "amount", false),
      mapRowsForAmountConversion(plannedCurrentResult.rows, "amount", false),
      mapRowsForAmountConversion(plannedHistResult.rows, "amount", false),
    ],
    targetCurrency,
    "date",
  );

  /** @type {Record<string, Record<string, number>>} */
  const monthDayNet = {};
  for (const row of pastConverted) {
    const eur = row.amount_eur;
    const mk = row.month_key;
    if (!monthDayNet[mk]) monthDayNet[mk] = {};
    monthDayNet[mk][row.day_of_month] = addMoney(
      monthDayNet[mk][row.day_of_month] || 0,
      safeMoneyInput(eur),
    );
  }

  /** @type {Record<string, number>} */
  const currentDayNet = {};
  for (const row of currentCashflowConverted) {
    currentDayNet[row.day_of_month] = addMoney(
      currentDayNet[row.day_of_month] || 0,
      safeMoneyInput(row.amount_eur),
    );
  }

  let currentCum = 0;
  /** @type {Record<string, number>} */
  const currentByDay = {};
  for (let d = 1; d <= currentDay; d++) {
    currentCum = addMoney(currentCum, currentDayNet[d] || 0);
    currentByDay[d] = currentCum;
  }

  /** @type {Record<string, number>} */
  const plannedCurrentByDay = {};
  for (const row of plannedCurrentConverted) {
    plannedCurrentByDay[row.day_of_month] = addMoney(
      plannedCurrentByDay[row.day_of_month] || 0,
      safeMoneyInput(row.amount_eur),
    );
  }

  /** @type {Record<string, Record<string, number>>} */
  const plannedHistMonthDay = {};
  for (const row of plannedHistConverted) {
    const mk = row.month_key;
    if (!plannedHistMonthDay[mk]) plannedHistMonthDay[mk] = {};
    plannedHistMonthDay[mk][row.day_of_month] = addMoney(
      plannedHistMonthDay[mk][row.day_of_month] || 0,
      safeMoneyInput(row.amount_eur),
    );
  }

  // ONE divisor for both historical series, taken from the unfiltered ledger
  // probe above: a month with transactions but no *planned* rows is a month in
  // which the user planned nothing (a real zero), so the overlay must not be
  // re-based onto its own shorter span and averaged up.
  //
  // `todayYmd` is the same string bound into that probe's window, so "the last
  // complete month" and "the months the numerator could draw from" are two
  // readings of one clock.
  const lastCompleteMonthIdx =
    Number(todayYmd.slice(0, 4)) * 12 + (Number(todayYmd.slice(5, 7)) - 1) - 1;
  const observedMonths = countObservedMonths(
    monthKeyFromDbDate(ledgerStartResult.rows[0]?.first_date),
    lastCompleteMonthIdx,
    HISTORY_MONTHS,
  );

  const avgCumulativeByDay = computeAvgCumulativeByDay(
    monthDayNet,
    observedMonths,
  );
  const avgPlannedCumByDay = computeAvgCumulativeByDay(
    plannedHistMonthDay,
    observedMonths,
  );

  const withoutPlanned = [];
  const withPlanned = [];
  let plannedCum = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const avg =
      avgCumulativeByDay[day] !== undefined
        ? avgCumulativeByDay[day]
        : avgCumulativeByDay[day - 1] || 0;
    const current = day <= currentDay ? currentByDay[day] : null;

    withoutPlanned.push({
      day,
      average: roundToCents(avg),
      current: current !== null ? roundToCents(current) : null,
    });

    const avgPlanned =
      avgPlannedCumByDay[day] !== undefined
        ? avgPlannedCumByDay[day]
        : avgPlannedCumByDay[day - 1] || 0;
    plannedCum = addMoney(plannedCum, plannedCurrentByDay[day] || 0);
    const currentWithPlanned =
      current !== null ? addMoney(current, plannedCum) : null;

    withPlanned.push({
      day,
      average: roundToCents(addMoney(avg, avgPlanned)),
      current:
        currentWithPlanned !== null ? roundToCents(currentWithPlanned) : null,
    });
  }

  return {
    days_in_month: daysInMonth,
    current_day: currentDay,
    month: Number(todayYmd.slice(5, 7)),
    year: Number(todayYmd.slice(0, 4)),
    without_planned: withoutPlanned,
    with_planned: withPlanned,
  };
}

/**
 * @param {number} historyMonths
 * @param {number[]} [excludedCategoryIds]
 * @param {number[]} [excludedRecipientIds]
 * @param {string} [targetCurrency]
 */
export async function getCashflowForecastData(
  historyMonths,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = "EUR",
) {
  if (
    !Number.isInteger(historyMonths) ||
    historyMonths < 1 ||
    historyMonths > 120
  ) {
    throw new ValidationError("historyMonths must be an integer in [1, 120]");
  }

  // One clock for the whole call (ADR-009), bound into the SQL below in place
  // of CURRENT_DATE — see convention 1 at the top of this file.
  const todayYmd = todayAppDateString();

  // Canonical exclusion clauses (lib/filterBuilder.js); joins stay conditional.
  const excl = buildExclusionClauses({
    excludedCategoryIds,
    excludedRecipientIds,
  });
  const categoryExclusionJoin = excl.whereSql ? excl.joinSql : "";
  const categoryExclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : "";
  const excludeParams = excl.params;

  // Own bound params, allocated after the exclusion params (convention 2).
  const pDate = excl.nextParamIdx;
  const pMonths = pDate + 1;
  const anchor = `$${pDate}::date`;

  // ADR-083 transfer exclusion — see getCashflowComparison for the rationale.
  const includeTransfers = await getIncludeTransfers();
  const transferFilter = includeTransfers ? "" : "AND t.is_transfer = false";

  // GROUP BY (date, currency) in SQL — aggregateByDate re-buckets by date and
  // conversion is per (currency, date), so this is identical to the old per-row
  // stream (see getCashflowComparison for the full rationale).
  const sqlHistory = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', ${anchor}) - make_interval(months => $${pMonths}::int)
      AND t.date < date_trunc('month', ${anchor})
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;
  const sqlCurrent = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', ${anchor})
      AND t.date <= ${anchor}
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;
  // No transfer predicate on the planned overlays: planned_transactions has no
  // `is_transfer` column (ADR-083 flagged `transactions` only). No exclusion
  // params either, so these two number their own from $1.
  const sqlPlannedCurrent = `
    SELECT SUM(pt.amount) AS amount, pt.currency, pt.planned_date AS date
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', $1::date)
      AND pt.planned_date <= (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')
    GROUP BY pt.planned_date, pt.currency
  `;
  const sqlPlannedHist = `
    SELECT SUM(pt.amount) AS amount, pt.currency, pt.planned_date AS date
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', $1::date) - make_interval(months => $2::int)
      AND pt.planned_date < date_trunc('month', $1::date)
    GROUP BY pt.planned_date, pt.currency
  `;

  const [histRes, currentRes, plannedCurRes, plannedHistRes] =
    await Promise.all([
      query(sqlHistory, [...excludeParams, todayYmd, historyMonths]),
      query(sqlCurrent, [...excludeParams, todayYmd]),
      query(sqlPlannedCurrent, [todayYmd]),
      query(sqlPlannedHist, [todayYmd, historyMonths]),
    ]);

  const [histConv, currentConv, plannedCurConv, plannedHistConv] =
    await batchConvertGroupsWithHistoricalRateFallback(
      [
        mapRowsForAmountConversion(histRes.rows, "amount", false),
        mapRowsForAmountConversion(currentRes.rows, "amount", false),
        mapRowsForAmountConversion(plannedCurRes.rows, "amount", false),
        mapRowsForAmountConversion(plannedHistRes.rows, "amount", false),
      ],
      targetCurrency,
      "date",
    );

  return {
    history: aggregateByDate(histConv),
    currentActual: aggregateByDate(currentConv),
    plannedCurrent: aggregateByDate(plannedCurConv),
    plannedHist: aggregateByDate(plannedHistConv),
    historyMonths,
  };
}

/**
 * @param {number} historyMonths
 * @param {number} daysBack
 * @param {number} daysForward
 * @param {number[]} [excludedCategoryIds]
 * @param {number[]} [excludedRecipientIds]
 * @param {string} [targetCurrency]
 */
export async function getCashflowForecastDataRolling(
  historyMonths,
  daysBack,
  daysForward,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = "EUR",
) {
  if (
    !Number.isInteger(historyMonths) ||
    historyMonths < 1 ||
    historyMonths > 120
  ) {
    throw new ValidationError("historyMonths must be an integer in [1, 120]");
  }
  if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 365) {
    throw new ValidationError("daysBack must be an integer in [1, 365]");
  }
  if (!Number.isInteger(daysForward) || daysForward < 1 || daysForward > 365) {
    throw new ValidationError("daysForward must be an integer in [1, 365]");
  }

  // One clock for the whole call (ADR-009), bound into the SQL below in place
  // of CURRENT_DATE — see convention 1 at the top of this file.
  const todayYmd = todayAppDateString();

  // Canonical exclusion clauses (lib/filterBuilder.js); joins stay conditional.
  const excl = buildExclusionClauses({
    excludedCategoryIds,
    excludedRecipientIds,
  });
  const categoryExclusionJoin = excl.whereSql ? excl.joinSql : "";
  const categoryExclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : "";
  const excludeParams = excl.params;

  // Own bound params, allocated after the exclusion params (convention 2).
  const pDate = excl.nextParamIdx;
  const pDaysBack = pDate + 1;
  const pMonths = pDate + 2;
  const anchor = `$${pDate}::date`;
  const rollingStart = `(${anchor} - make_interval(days => $${pDaysBack}::int))`;

  // ADR-083 transfer exclusion — see getCashflowComparison for the rationale.
  const includeTransfers = await getIncludeTransfers();
  const transferFilter = includeTransfers ? "" : "AND t.is_transfer = false";

  // History ends at `today - daysBack` (exclusive) so it never overlaps with currentActual.
  // GROUP BY (date, currency) — identical to the old per-row stream (aggregateByDate re-buckets by date).
  const sqlHistory = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= ${rollingStart} - make_interval(months => $${pMonths}::int)
      AND t.date < ${rollingStart}
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;
  const sqlCurrent = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= ${rollingStart}
      AND t.date <= ${anchor}
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;
  // No transfer predicate — planned_transactions has no `is_transfer` column.
  // No exclusion params either, so this one numbers its own from $1
  // ($1 = the anchor date, $2 = daysForward).
  const sqlPlannedFuture = `
    SELECT SUM(pt.amount) AS amount, pt.currency, pt.planned_date AS date
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date > $1::date
      AND pt.planned_date <= ($1::date + make_interval(days => $2::int))
    GROUP BY pt.planned_date, pt.currency
  `;

  const [histRes, currentRes, plannedRes] = await Promise.all([
    query(sqlHistory, [...excludeParams, todayYmd, daysBack, historyMonths]),
    query(sqlCurrent, [...excludeParams, todayYmd, daysBack]),
    query(sqlPlannedFuture, [todayYmd, daysForward]),
  ]);

  const [histConv, currentConv, plannedConv] =
    await batchConvertGroupsWithHistoricalRateFallback(
      [
        mapRowsForAmountConversion(histRes.rows, "amount", false),
        mapRowsForAmountConversion(currentRes.rows, "amount", false),
        mapRowsForAmountConversion(plannedRes.rows, "amount", false),
      ],
      targetCurrency,
      "date",
    );

  return {
    history: aggregateByDate(histConv),
    currentActual: aggregateByDate(currentConv),
    plannedCurrent: aggregateByDate(plannedConv),
    historyMonths,
  };
}

/**
 * @param {number} historyMonths
 * @param {number[]} [excludedCategoryIds]
 * @param {number[]} [excludedRecipientIds]
 * @param {string} [targetCurrency]
 */
export async function getCashflowForecastDataByCategory(
  historyMonths,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = "EUR",
) {
  if (
    !Number.isInteger(historyMonths) ||
    historyMonths < 1 ||
    historyMonths > 120
  ) {
    throw new ValidationError("historyMonths must be an integer in [1, 120]");
  }

  // One clock for the whole call (ADR-009), bound into the SQL below in place
  // of CURRENT_DATE — see convention 1 at the top of this file.
  const todayYmd = todayAppDateString();

  // Canonical exclusion clauses (lib/filterBuilder.js). The r/pr joins are
  // unconditional here (the effective-category COALESCE needs them anyway).
  const excl = buildExclusionClauses({
    excludedCategoryIds,
    excludedRecipientIds,
  });
  const excludeParams = excl.params;
  const exclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : "";

  // Own bound params, allocated after the exclusion params (convention 2).
  const pDate = excl.nextParamIdx;
  const pMonths = pDate + 1;
  const anchor = `$${pDate}::date`;

  // ADR-083 transfer exclusion — see getCashflowComparison for the rationale.
  // This matters doubly here: the category breakdown attributes a transfer leg
  // to whatever category the account's recipient defaults to, inventing spend
  // in a category the user never spent in.
  const includeTransfers = await getIncludeTransfers();
  const transferFilter = includeTransfers ? "" : "AND t.is_transfer = false";

  // Aggregate per (date, currency, effective category) in SQL — aggregateByDateAndCategory
  // re-buckets by (date, category) and conversion is per (currency, date), so SUM-then-convert
  // is identical to the old per-row stream.
  const selectCols = `
    SUM(t.amount) AS amount,
    t.currency,
    t.date,
    COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS category_id,
    COALESCE(cat.general, 'Uncategorized')                                  AS general,
    COALESCE(cat.detail,  'Uncategorized')                                  AS detail
  `;
  const groupByCols = `
    GROUP BY t.date, t.currency,
             COALESCE(t.category_id, r.default_category_id, pr.default_category_id),
             cat.general, cat.detail
  `;
  const joins = `
    LEFT JOIN recipients r  ON t.recipient_id = r.id
    LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    LEFT JOIN categories cat
      ON cat.id = COALESCE(t.category_id, r.default_category_id, pr.default_category_id)
  `;

  const sqlHistory = `
    SELECT ${selectCols}
    FROM transactions t ${joins}
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', ${anchor}) - make_interval(months => $${pMonths}::int)
      AND t.date <  date_trunc('month', ${anchor})
      ${exclusionWhere}
    ${groupByCols}
  `;
  const sqlCurrent = `
    SELECT ${selectCols}
    FROM transactions t ${joins}
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', ${anchor})
      AND t.date <= ${anchor}
      ${exclusionWhere}
    ${groupByCols}
  `;

  const [histRes, currentRes] = await Promise.all([
    query(sqlHistory, [...excludeParams, todayYmd, historyMonths]),
    query(sqlCurrent, [...excludeParams, todayYmd]),
  ]);

  const [histConv, currentConv] =
    await batchConvertGroupsWithHistoricalRateFallback(
      [
        mapRowsForAmountConversion(histRes.rows, "amount", false),
        mapRowsForAmountConversion(currentRes.rows, "amount", false),
      ],
      targetCurrency,
      "date",
    );

  /**
   * @param {Array<Record<string, any>>} rows
   * @returns {Array<{ date: string, category_id: number|null, general: string, detail: string, net: number }>}
   */
  const aggregateByDateAndCategory = (rows) => {
    /** @type {Map<string, { date: string, category_id: number|null, general: string, detail: string, net: number }>} */
    const map = new Map();
    for (const r of rows) {
      const date =
        r.date instanceof Date
          ? formatDateToYmd(r.date)
          : String(r.date).slice(0, 10);
      const key = `${date}|${r.category_id ?? "null"}`;
      if (!map.has(key)) {
        map.set(key, {
          date,
          category_id: r.category_id ?? null,
          general: r.general ?? "Uncategorized",
          detail: r.detail ?? "Uncategorized",
          net: 0,
        });
      }
      map.get(key).net = addMoney(
        map.get(key).net,
        safeMoneyInput(r.amount_eur),
      );
    }
    return Array.from(map.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  };

  return {
    historyByCategory: aggregateByDateAndCategory(histConv),
    currentActualByCategory: aggregateByDateAndCategory(currentConv),
  };
}
