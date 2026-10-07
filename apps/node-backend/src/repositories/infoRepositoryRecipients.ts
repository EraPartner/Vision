/**
 * Info sub-repository: recipient / merchant insights.
 *
 * Internal transfers (ADR-083) are ALWAYS excluded here (`is_transfer = false`),
 * independent of the `includeTransfers` cash-flow toggle. These surfaces are a
 * merchant-spend lens — a checking->savings move has no merchant and would only
 * be noise in "top merchants" / month-over-month, so the toggle (which governs
 * income/spending cash-flow aggregates) deliberately does not apply.
 */

import { query } from "../database/connection.ts";
import {
  toDecimal,
  toNumber,
  roundMoney as roundToCents,
} from "../lib/money.ts";
import { toWireDate } from "../lib/dateFormat.ts";
import { todayAppDateString } from "../lib/timezone.ts";
import {
  buildExclusionClauses,
  validateInt4Ids,
} from "../lib/filterBuilder.ts";
import { convertRowsToEur } from "../services/currency/currencyConversionService.js";
import {
  buildPeriodPivot,
  mapRowsForAmountConversion,
} from "./infoRepositoryHelpers.ts";
import type { PeriodPivotEntity } from "./infoRepositoryHelpers.ts";

export interface RecipientInsightsOptions {
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
  startDate?: string;
  endDate?: string;
}

export interface RecipientByYearOptions extends RecipientInsightsOptions {
  targetCurrency?: string;
}

export interface RecipientPivotOptions {
  excludedRecipientIds?: number[];
  targetCurrency?: string;
  bucket?: string;
  startDate?: string | null;
  endDate?: string | null;
  recipientIds?: number[] | null;
}

interface RecipientTotal {
  recipientId: number;
  name: string;
  totalSpend: number;
  transactionCount: number;
}

export interface RecipientPivotResult {
  recipientPivot: Record<string, PeriodPivotEntity[]>;
  conversion: {
    usedHistoricalFallback: boolean;
    affectedCurrencies: string[];
  };
}

export const recipientInsightsRepository = {
  /**
   * Recipient / Merchant Insights
   *
   * Returns:
   * - top merchants by total spend (full list; frontend slices for chart/KPIs)
   * - spending frequency & average per recipient
   * - month-over-month comparison alerts ("You spent X% more at …")
   */
  async getRecipientInsights(
    targetCurrency = "EUR",
    {
      excludedCategoryIds = [],
      excludedRecipientIds = [],
      startDate,
      endDate,
    }: RecipientInsightsOptions = {},
  ) {
    // Canonical exclusion semantics (lib/filterBuilder.buildExclusionClauses,
    // shared with the dashboard / statistics endpoints): drop hidden categories
    // (by effective category) and excluded recipients (rolled up to the primary
    // recipient via COALESCE(r.primary_recipient_id, t.recipient_id)). Built once
    // and reused by both queries below since neither carries any other bound
    // parameters. The queries' own r/pr joins satisfy the helper's join contract.
    const excl = buildExclusionClauses({
      excludedCategoryIds,
      excludedRecipientIds,
    });
    const params = excl.params;
    const exclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : "";
    const dateFilters: string[] = [];
    if (startDate) {
      params.push(startDate);
      dateFilters.push(`t.date >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      dateFilters.push(`t.date <= $${params.length}`);
    }
    const dateWhere = dateFilters.length
      ? `AND ${dateFilters.join(" AND ")}`
      : "";

    // Grouped per (recipient, DATE, currency) — the extra `t.date` key exists so
    // the conversion below can use each row's OWN date rate, exactly as
    // getRecipientByYear (:212) and getRecipientPivot (:324) do. Aggregating
    // per recipient first and converting the SUM afterwards would have to pick a
    // single rate for a multi-date total, which is what made Top merchants
    // report a different EUR figure than by-year/pivot for the same recipient.
    // amount < 0 is pinned, so ABS distributes over the same-sign SUM and
    // SUM-then-convert per date is identical to converting each row; tx_count
    // and the MIN/MAX date bounds are re-reduced per recipient in JS below.
    const topRawResult = await query(
      `
      SELECT
        COALESCE(pr.name, r.name)   AS recipient_name,
        COALESCE(pr.id, r.id)       AS recipient_id,
        t.date,
        t.currency,
        SUM(ABS(t.amount))          AS total_abs_amount,
        COUNT(*)                    AS tx_count,
        MIN(t.date)                 AS first_seen,
        MAX(t.date)                 AS last_seen
      FROM transactions t
      JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.amount < 0
        AND t.is_active = true
        AND t.is_transfer = false
        ${exclusionWhere}
        ${dateWhere}
      GROUP BY COALESCE(pr.id, r.id), COALESCE(pr.name, r.name), t.date, t.currency
    `,
      params,
    );

    // Historical per-date rates, matching getRecipientByYear / getRecipientPivot.
    // Converting at the LATEST rate here made one 2024 USD purchase read 90 in
    // Top merchants and 25 in the by-year / pivot views of the same recipient.
    const topConverted = await convertRowsToEur(
      mapRowsForAmountConversion(topRawResult.rows, "total_abs_amount", false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: "date" },
    );

    const recipientAgg: Record<
      string,
      RecipientTotal & { firstSeen: string | null; lastSeen: string | null }
    > = {};
    for (const row of topConverted) {
      const rid = row.recipient_id;
      const eur = row.amount_eur;
      const count = parseInt(row.tx_count, 10);

      if (!recipientAgg[rid]) {
        recipientAgg[rid] = {
          recipientId: rid,
          name: row.recipient_name,
          totalSpend: 0,
          transactionCount: 0,
          // DATE columns as calendar-day strings (Y-M-D compares
          // lexicographically, so the min/max below still works).
          firstSeen: toWireDate(row.first_seen),
          lastSeen: toWireDate(row.last_seen),
        };
      }
      // Decimal accumulation (money-hygiene): native `+=` over per-currency
      // converted spend drifts sub-cent before the final round.
      recipientAgg[rid].totalSpend = toNumber(
        toDecimal(recipientAgg[rid].totalSpend).plus(toDecimal(eur)),
      );
      recipientAgg[rid].transactionCount += count;
      const firstSeen = toWireDate(row.first_seen);
      const lastSeen = toWireDate(row.last_seen);
      const seen = recipientAgg[rid];
      // Comparing null with a 'YYYY-MM-DD' string is always false in JS (NaN),
      // so the null checks only make that explicit; MIN/MAX of a non-empty
      // group is never NULL anyway.
      if (
        firstSeen !== null &&
        seen.firstSeen !== null &&
        firstSeen < seen.firstSeen
      )
        seen.firstSeen = firstSeen;
      if (
        lastSeen !== null &&
        seen.lastSeen !== null &&
        lastSeen > seen.lastSeen
      )
        seen.lastSeen = lastSeen;
    }

    const topMerchants = Object.values(recipientAgg)
      .sort((a, b) => b.totalSpend - a.totalSpend)
      .map((r) => ({
        ...r,
        totalSpend: roundToCents(r.totalSpend),
        avgAmount: roundToCents(r.totalSpend / r.transactionCount),
      }));

    // Grouped per (recipient, period, DATE, currency) for the same reason top
    // merchants above is: the conversion below needs each row's OWN date rate.
    // Aggregating a whole month first and converting the SUM afterwards has to
    // pick ONE rate for the month, and passing no options at all picked the
    // CURRENT `is_latest` rate for BOTH months — so a rate move between the two
    // compared months was invisible (the change percent measured spend only)
    // and MoM's EUR figures disagreed with the now-historical top-merchants /
    // by-year / pivot surfaces on the same page. amount < 0 is pinned, so ABS
    // distributes over the same-sign SUM and SUM-then-convert per date is
    // identical to converting each row; the per-(recipient, period) totals are
    // re-reduced in JS below.
    // The single clock for the month-over-month card (ADR-009): the
    // APP_TIMEZONE calendar day, bound once and reused for the period keys
    // below, as the forecast, monthly and average-vs-current cards do.
    const todayYmd = todayAppDateString();
    const momParams = [...params, todayYmd];
    const today = `$${momParams.length}::date`;
    const momRawResult = await query(
      `
      SELECT
        COALESCE(pr.id, r.id)       AS recipient_id,
        COALESCE(pr.name, r.name)   AS recipient_name,
        TO_CHAR(t.date, 'YYYY-MM')  AS period,
        t.date,
        t.currency,
        SUM(ABS(t.amount))          AS abs_amount
      FROM transactions t
      JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.amount < 0
        AND t.is_active = true
        AND t.is_transfer = false
        AND t.date >= (DATE_TRUNC('month', ${today}) - INTERVAL '1 month')
        -- Like-for-like windows: the current month is month-to-date, so cap the
        -- previous month at the SAME day-of-month. Otherwise (partial current vs
        -- full previous) every recipient shows a spurious decrease early in the month.
        AND (
          t.date >= DATE_TRUNC('month', ${today})
          OR t.date <= (DATE_TRUNC('month', ${today}) - INTERVAL '1 month')::date
                       + (${today} - DATE_TRUNC('month', ${today})::date)
        )
        ${exclusionWhere}
        ${dateWhere}
      GROUP BY COALESCE(pr.id, r.id), COALESCE(pr.name, r.name), TO_CHAR(t.date, 'YYYY-MM'), t.date, t.currency
    `,
      momParams,
    );

    // Historical per-date rates, matching top merchants / by-year / pivot.
    const momConverted = await convertRowsToEur(
      mapRowsForAmountConversion(momRawResult.rows, "abs_amount", false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: "date" },
    );

    // Derive the current / previous month keys in the database from the same
    // bound day as the window above, so they match the
    // `TO_CHAR(t.date, 'YYYY-MM')` buckets even at a month boundary.
    const periodResult = await query(
      `
      SELECT TO_CHAR($1::date, 'YYYY-MM') AS current_period,
             TO_CHAR($1::date - INTERVAL '1 month', 'YYYY-MM') AS prev_period
    `,
      [todayYmd],
    );
    const currentPeriod = periodResult.rows[0].current_period;
    const prevPeriod = periodResult.rows[0].prev_period;

    const momAgg: Record<
      string,
      { name: string; current: number; previous: number }
    > = {};
    for (const row of momConverted) {
      const rid = row.recipient_id;
      const eur = row.amount_eur;
      if (!momAgg[rid])
        momAgg[rid] = { name: row.recipient_name, current: 0, previous: 0 };
      // Decimal accumulation (money-hygiene), as in the top-merchants reduction
      // above: per-date conversion means a month is now many converted rows,
      // and native `+=` over them drifts sub-cent before the final round.
      if (row.period === currentPeriod) {
        momAgg[rid].current = toNumber(
          toDecimal(momAgg[rid].current).plus(toDecimal(eur)),
        );
      } else if (row.period === prevPeriod) {
        momAgg[rid].previous = toNumber(
          toDecimal(momAgg[rid].previous).plus(toDecimal(eur)),
        );
      }
    }

    const monthOverMonth = Object.entries(momAgg)
      .filter(([, v]) => v.previous > 0 && v.current > 0)
      .map(([rid, v]) => ({
        recipientId: parseInt(rid, 10),
        name: v.name,
        currentSpend: roundToCents(v.current),
        previousSpend: roundToCents(v.previous),
        changePercent:
          Math.round(((v.current - v.previous) / v.previous) * 100 * 10) / 10,
      }))
      .sort((a, b) => b.currentSpend - a.currentSpend)
      .slice(0, 10);

    return { topMerchants, monthOverMonth };
  },

  async getRecipientByYear({
    targetCurrency = "EUR",
    excludedRecipientIds = [],
    excludedCategoryIds = [],
    startDate,
    endDate,
  }: RecipientByYearOptions = {}): Promise<{
    recipientsByYear: Record<string, RecipientTotal[]>;
  }> {
    // Canonical exclusion clauses (lib/filterBuilder.buildExclusionClauses).
    // Category exclusion (incl. hidden categories) must apply here too, or the
    // year-filtered Top Recipients view contradicts the "All years" view (which
    // does exclude them).
    const excl = buildExclusionClauses({
      excludedCategoryIds,
      excludedRecipientIds,
    });
    const params = excl.params;
    const exclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : "";
    const dateFilters: string[] = [];
    if (startDate) {
      params.push(startDate);
      dateFilters.push(`t.date >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      dateFilters.push(`t.date <= $${params.length}`);
    }
    const dateWhere = dateFilters.length
      ? `AND ${dateFilters.join(" AND ")}`
      : "";

    // Aggregate in SQL per (recipient, year, date, currency) instead of streaming
    // every expense row to JS. amount < 0 is pinned, so ABS distributes over the
    // same-sign SUM and converting at each row's date rate is identical to the
    // old per-transaction loop; cnt preserves transactionCount.
    const sql = `
      SELECT
        EXTRACT(YEAR FROM t.date)::int AS year,
        COALESCE(pr.id, r.id) AS recipient_id,
        COALESCE(pr.name, r.name) AS name,
        t.date, t.currency,
        SUM(ABS(t.amount)) AS abs_amount,
        COUNT(*) AS cnt
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.is_active = true
        AND t.amount < 0
        AND t.is_transfer = false
        ${exclusionWhere}
        ${dateWhere}
      GROUP BY EXTRACT(YEAR FROM t.date)::int, COALESCE(pr.id, r.id), COALESCE(pr.name, r.name), t.date, t.currency
    `;

    const result = await query(sql, params);

    const converted = await convertRowsToEur(
      mapRowsForAmountConversion(result.rows, "abs_amount", false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: "date" },
    );

    const yearRecMap: Record<string, Record<string, RecipientTotal>> = {};
    for (const row of converted) {
      const year = String(row.year);
      const rid = row.recipient_id;
      const eur = Math.abs(row.amount_eur);
      const cnt = parseInt(row.cnt, 10) || 0;

      if (!yearRecMap[year]) yearRecMap[year] = {};
      if (!yearRecMap[year][rid]) {
        yearRecMap[year][rid] = {
          recipientId: rid,
          name: row.name,
          totalSpend: 0,
          transactionCount: 0,
        };
      }
      yearRecMap[year][rid].totalSpend = toNumber(
        toDecimal(yearRecMap[year][rid].totalSpend).plus(toDecimal(eur)),
      );
      yearRecMap[year][rid].transactionCount += cnt;
    }

    const recipientsByYear: Record<string, RecipientTotal[]> = {};
    for (const [year, recs] of Object.entries(yearRecMap)) {
      recipientsByYear[year] = Object.values(recs)
        .sort((a, b) => b.totalSpend - a.totalSpend)
        .slice(0, 20)
        .map((r) => ({ ...r, totalSpend: roundToCents(r.totalSpend) }));
    }

    return { recipientsByYear };
  },

  async getRecipientPivot({
    excludedRecipientIds = [],
    targetCurrency = "EUR",
    bucket = "monthly",
    startDate = null,
    endDate = null,
    recipientIds = null,
  }: RecipientPivotOptions = {}): Promise<RecipientPivotResult> {
    // Canonical recipient exclusion (lib/filterBuilder.buildExclusionClauses).
    const excl = buildExclusionClauses({ excludedRecipientIds });
    const params = excl.params;
    const recExclude = excl.whereSql ? `AND ${excl.whereSql}` : "";

    const periodExpr =
      bucket === "yearly"
        ? "TO_CHAR(t.date, 'YYYY')"
        : "TO_CHAR(t.date, 'YYYY-MM')";

    const dateFilters: string[] = [];
    if (startDate) {
      params.push(startDate);
      dateFilters.push(`t.date >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      dateFilters.push(`t.date <= $${params.length}`);
    }
    const dateWhere = dateFilters.length > 0 ? dateFilters.join(" AND ") : "";

    // Optional inclusion narrowing: the only consumer (saved CustomChart) renders
    // a handful of selected recipients, so resolve their alias members and scan
    // ONLY those rows (hits idx_transactions_recipient_date_active) instead of
    // every active expense row for all recipients. See ADR-041 amendment.
    let recipientInclude = "";
    const validIncludeIds = validateInt4Ids(recipientIds, "recipientIds");
    if (validIncludeIds.length > 0) {
      const memberRes = await query<{ id: number }>(
        `WITH selected_roots AS (
           SELECT DISTINCT COALESCE(primary_recipient_id, id) AS id
           FROM recipients
           WHERE id = ANY($1::int[])
         )
         SELECT id FROM selected_roots
         UNION
         SELECT r.id
         FROM recipients r
         JOIN selected_roots sr ON r.primary_recipient_id = sr.id`,
        [validIncludeIds],
      );
      const memberIds = [
        ...new Set(memberRes.rows.map((row) => Number(row.id))),
      ];
      if (memberIds.length === 0) {
        return {
          recipientPivot: {},
          conversion: {
            usedHistoricalFallback: false,
            affectedCurrencies: [],
          },
        };
      }
      params.push(memberIds);
      recipientInclude = `AND t.recipient_id = ANY($${params.length}::int[])`;
    }

    // Aggregate per (recipient, period, date, currency) in SQL. amount < 0 is
    // pinned so ABS distributes over the same-sign SUM; per-date conversion is
    // identical to the old per-row loop while collapsing same-day repeat
    // purchases at one merchant. cnt preserves transactionCount.
    const sql = `
      SELECT
        COALESCE(pr.id, r.id)       AS recipient_id,
        COALESCE(pr.name, r.name)   AS recipient_name,
        ${periodExpr}               AS period,
        t.date, t.currency,
        SUM(ABS(t.amount))          AS abs_amount,
        COUNT(*)                    AS cnt
      FROM transactions t
      JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.is_active = true
        AND t.amount < 0
        AND t.is_transfer = false
        ${recExclude}
        ${recipientInclude}
        ${dateWhere ? `AND ${dateWhere}` : ""}
      GROUP BY COALESCE(pr.id, r.id), COALESCE(pr.name, r.name), ${periodExpr}, t.date, t.currency
    `;

    const result = await query(sql, params);

    const converted = await convertRowsToEur(
      mapRowsForAmountConversion(result.rows, "abs_amount", false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: "date" },
    );

    const recipientPivot = buildPeriodPivot(converted, {
      idField: "recipient_id",
      labelField: "recipient_name",
      idKey: "recipientId",
      labelKey: "name",
    });

    const usedHistoricalFallback = converted.some(
      (row) => row.used_fallback_rate === true,
    );
    const affectedCurrencies = [
      ...new Set(
        converted
          .filter((row) => row.used_fallback_rate === true)
          .map((row) =>
            String(row.currency || "")
              .trim()
              .toUpperCase(),
          )
          .filter(Boolean),
      ),
    ].sort();

    return {
      recipientPivot,
      conversion: {
        usedHistoricalFallback,
        affectedCurrencies,
      },
    };
  },
};
