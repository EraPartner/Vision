/**
 * Info sub-repository: category statistics and transaction summaries.
 */

import { queryPrepared } from "../database/connection.ts";
import { checkRows, queryRows } from "../database/rowContracts.ts";
import { countRowSchema } from "../database/rowSchemas.ts";
import {
  bankLabelRowSchema,
  categoryCurrencyAmountRowSchema,
  categoryPivotRowSchema,
  mvCategoryTotalsRowSchema,
} from "../database/rows/info.ts";
import { buildExclusionClauses } from "../lib/filterBuilder.ts";
import {
  toDecimal,
  toNumber,
  roundMoney as roundToCents,
} from "../lib/money.ts";
import { convertRowsToEur } from "../services/currency/currencyConversionService.ts";
import {
  mvAvailable,
  mapRowsForAmountConversion,
  buildCategoryFromConvertedRows,
  getIncludeTransfers,
} from "./infoRepositoryHelpers.ts";
import type { CategoryTotal } from "./infoRepositoryHelpers.ts";

export interface CategoryPivotCell {
  categoryId: number | null;
  categoryName: string;
  categoryPathIds: number[];
  categoryPathSegments: string[];
  total: number;
  income: number;
  expense: number;
  transactionCount: number;
}

export interface CategoryPivotOptions {
  excludedCategoryIds?: number[];
  targetCurrency?: string;
  excludedRecipientIds?: number[];
  startDate?: string;
  endDate?: string;
}

/** An ungrouped `count(*)` always returns exactly one row. */
function parseCountRow(rows: Array<{ count: string }>): number {
  const [row] = rows;
  if (!row) throw new Error("count(*) returned no row");
  return parseInt(row.count, 10);
}

export const statisticsRepository = {
  async getCategoryBreakdown(
    targetCurrency = "EUR",
    ancestorCategoryId: number | undefined = undefined,
  ): Promise<CategoryTotal[]> {
    const includeTransfers = await getIncludeTransfers();

    if (ancestorCategoryId !== undefined) {
      // Expand the effective category only once through the ancestry view. A
      // transaction assigned directly to the ancestor and one assigned four
      // levels below both contribute one row to this one requested rollup.
      const rows = await queryRows(
        categoryCurrencyAmountRowSchema,
        `
        SELECT ancestor.id AS category_id, ancestor.path_name AS name,
               SUM(t.amount) AS amount, COUNT(*) AS cnt, t.currency
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
        JOIN category_ancestors ancestry
          ON ancestry.category_id = COALESCE(t.category_id, r.default_category_id, pr.default_category_id)
         AND ancestry.ancestor_id = $1
        JOIN categories ancestor ON ancestor.id = ancestry.ancestor_id
        WHERE t.is_active = true
          ${includeTransfers ? "" : "AND t.is_transfer = false"}
        GROUP BY ancestor.id, ancestor.path_name, t.currency
      `,
        [ancestorCategoryId],
      );
      const converted = await convertRowsToEur(
        mapRowsForAmountConversion(rows, "amount", false),
        targetCurrency,
      );
      let count = 0;
      let total = toDecimal(0);
      for (const row of converted) {
        count += parseInt(row.cnt, 10) || 0;
        total = total.plus(toDecimal(row.amount_eur));
      }
      const [first] = converted;
      return first
        ? [
            {
              id: ancestorCategoryId,
              name: first.name,
              count,
              total: roundToCents(toNumber(total)),
            },
          ]
        : [];
    }

    // The MV (mv_category_totals) is built transfer-excluding, so it is only a
    // valid fast path when the caller also wants transfers excluded.
    if (!includeTransfers && (await mvAvailable("mv_category_totals"))) {
      const catRows = await queryRows(
        mvCategoryTotalsRowSchema,
        "SELECT * FROM mv_category_totals ORDER BY count DESC LIMIT 500",
      );
      const convertedRows = await convertRowsToEur(
        mapRowsForAmountConversion(catRows, "total", true),
        targetCurrency,
      );
      return buildCategoryFromConvertedRows(convertedRows);
    }

    // Live fallback path. Mirror the MV's transfer exclusion (ADR-083) so totals
    // do not silently change depending on whether the MV is populated.
    //
    // Aggregate in SQL per (category, currency) instead of streaming every
    // active transaction into JS. The default conversion (below) applies one
    // flat rate per currency — no per-date component — so SUM(amount) per
    // (category, currency) converted once equals Σ of the converted per-row
    // amounts (rate is linear and sign-preserving): numerically identical to
    // the old per-row loop, minus the row-cardinality transfer to Node.
    //
    // Effective category is the canonical 3-level resolution (own → recipient
    // default → PRIMARY recipient's default), matching transactionRepository —
    // an alias row categorised via its primary must not show as UNCATEGORISED
    // here while the transactions list shows it categorised.
    const categoryAmountRows = await queryRows(
      categoryCurrencyAmountRowSchema,
      `
      SELECT COALESCE(c.id, -1) AS category_id,
             COALESCE(c.path_name, 'UNCATEGORISED') AS name,
             SUM(t.amount) AS amount,
             COUNT(*) AS cnt,
             t.currency
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id
      WHERE t.is_active = true
        ${includeTransfers ? "" : "AND t.is_transfer = false"}
      GROUP BY COALESCE(c.id, -1),
               COALESCE(c.path_name, 'UNCATEGORISED'),
               t.currency
    `,
    );

    const catConverted = await convertRowsToEur(
      mapRowsForAmountConversion(categoryAmountRows, "amount", false),
      targetCurrency,
    );

    const catMap: Record<string, CategoryTotal> = {};
    for (const row of catConverted) {
      const catId =
        row.category_id === -1 ? null : parseInt(String(row.category_id), 10);
      const eur = row.amount_eur;
      const key = catId ?? "null";
      if (!catMap[key])
        catMap[key] = { id: catId, name: row.name, count: 0, total: 0 };
      catMap[key].count += parseInt(row.cnt, 10) || 0;
      // Decimal accumulation (money-hygiene) — native `+=` over the per-currency
      // converted subtotals drifts sub-cent before the roundToCents below.
      catMap[key].total = toNumber(
        toDecimal(catMap[key].total).plus(toDecimal(eur)),
      );
    }
    return Object.values(catMap)
      .map((cat) => ({ ...cat, total: roundToCents(cat.total) }))
      .sort((a, b) => b.count - a.count);
  },

  async getBanks(): Promise<string[]> {
    // Account labels for filter dropdowns, sourced from accounts.name (ADR-088).
    // EXISTS keeps the prior behaviour: only accounts that actually have active
    // transactions appear (an account is "seen" once it has activity).
    const result = await queryPrepared(
      "info_get_banks",
      `SELECT a.name AS bank_account
         FROM accounts a
        WHERE a.id IN (
          SELECT t.account_id FROM transactions t
           WHERE t.is_active = true AND t.account_id IS NOT NULL
        )
        ORDER BY a.name`,
      [],
    );
    return checkRows(bankLabelRowSchema, result.rows).map(
      (r) => r.bank_account,
    );
  },

  async getTransactionCount(
    opts: { accountId?: number | null } = {},
  ): Promise<number> {
    const { accountId } = opts;
    // Optional exact-FK account filter (ADR-088). Absent → unchanged unconditional
    // count (reuses the cached prepared statement); present → a parameterized,
    // separately-cached prepared statement so the two query shapes don't collide.
    if (accountId != null) {
      const result = await queryPrepared(
        "info_tx_count_by_account",
        "SELECT count(*) FROM transactions WHERE is_active = true AND account_id = $1",
        [accountId],
      );
      return parseCountRow(checkRows(countRowSchema, result.rows));
    }
    const result = await queryPrepared(
      "info_tx_count",
      "SELECT count(*) FROM transactions WHERE is_active = true",
      [],
    );
    return parseCountRow(checkRows(countRowSchema, result.rows));
  },

  async getCategoryPivot({
    excludedCategoryIds = [],
    targetCurrency = "EUR",
    excludedRecipientIds = [],
    startDate,
    endDate,
  }: CategoryPivotOptions = {}): Promise<{
    categoryPivot: Record<string, CategoryPivotCell[]>;
  }> {
    const includeTransfers = await getIncludeTransfers();
    // Canonical exclusion clauses (lib/filterBuilder.buildExclusionClauses,
    // shared with every other money surface): 3-level category COALESCE and
    // ALIAS-AWARE recipient exclusion. The bare `t.recipient_id NOT IN` here
    // previously kept an excluded recipient's transactions whenever they were
    // recorded under an alias of the excluded primary — disagreeing with the
    // dashboard/forecast.
    const excl = buildExclusionClauses({
      excludedCategoryIds,
      excludedRecipientIds,
    });
    const params = excl.params;
    const exclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : "";
    const dateFilters = [];
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

    // Aggregate in SQL per (category, period, date, currency) instead of
    // streaming every active transaction into JS. Conversion uses each row's
    // historical date rate, and rows sharing date+currency share one rate
    // (rate > 0 preserves sign), so SUM(...) FILTER by sign converted == Σ of
    // the converted per-transaction amounts — numerically identical to the old
    // per-row loop. The sign-split also gives explicit income/expense per cell
    // so consumers no longer have to classify by the sign of the net total.
    // Effective category is the canonical 3-level resolution (own →
    // recipient default → PRIMARY recipient's default), matching
    // transactionRepository — the same expression appears in the SELECT, the
    // NOT NULL filter and the GROUP BY, and all three must stay identical.
    const sql = `
      SELECT
        COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS category_id,
        CASE WHEN c.legacy_compatible
             THEN CONCAT(c.general, ': ', c.detail)
             ELSE c.path_name END AS category_name,
        path.ids AS category_path_ids,
        path.names AS category_path_segments,
        TO_CHAR(t.date, 'YYYY-MM') AS period,
        t.date, t.currency,
        SUM(t.amount) FILTER (WHERE t.amount >= 0) AS income,
        SUM(t.amount) FILTER (WHERE t.amount < 0) AS expense,
        COUNT(*) AS cnt
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = c.id
      LEFT JOIN category_paths path ON path.id = c.id
      WHERE t.is_active = true
        ${includeTransfers ? "" : "AND t.is_transfer = false"}
        AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id) IS NOT NULL
        ${exclusionWhere}
        ${dateWhere}
      GROUP BY COALESCE(t.category_id, r.default_category_id, pr.default_category_id),
               c.id, path.ids, path.names, TO_CHAR(t.date, 'YYYY-MM'), t.date, t.currency
      ORDER BY period
    `;

    const pivotRows = await queryRows(categoryPivotRowSchema, sql, params);

    // Two conversion legs per group (income + expense) so each converts at its
    // own date's rate. cnt is the whole group's count — counted once (income leg).
    const convRows = [];
    for (const r of pivotRows) {
      const base = {
        period: r.period,
        category_id: r.category_id,
        category_name: r.category_name,
        category_path_ids: r.category_path_ids,
        category_path_segments: r.category_path_segments,
        date: r.date,
        currency: r.currency,
        cnt: parseInt(r.cnt, 10) || 0,
      };
      convRows.push({ ...base, _leg: "income", amount: Number(r.income) || 0 });
      convRows.push({
        ...base,
        _leg: "expense",
        amount: Number(r.expense) || 0,
      });
    }

    const converted = await convertRowsToEur(
      mapRowsForAmountConversion(convRows, "amount", false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: "date" },
    );

    const periodCatMap: Record<string, Record<string, CategoryPivotCell>> = {};
    for (const row of converted) {
      const period = row.period;
      const catId = row.category_id
        ? parseInt(String(row.category_id), 10)
        : null;
      const catName = row.category_name || "Uncategorised";
      const eur = row.amount_eur;
      const catKey = catId ?? "null";

      if (!periodCatMap[period]) periodCatMap[period] = {};
      if (!periodCatMap[period][catKey]) {
        periodCatMap[period][catKey] = {
          categoryId: catId,
          categoryName: catName,
          categoryPathIds: row.category_path_ids ?? [],
          categoryPathSegments: row.category_path_segments ?? [],
          total: 0,
          income: 0,
          expense: 0,
          transactionCount: 0,
        };
      }
      const cell = periodCatMap[period][catKey];
      cell.total += eur;
      if (row._leg === "income") {
        cell.income += eur;
        cell.transactionCount += row.cnt;
      } else {
        cell.expense += eur;
      }
    }

    const categoryPivot: Record<string, CategoryPivotCell[]> = {};
    for (const [period, cats] of Object.entries(periodCatMap)) {
      categoryPivot[period] = Object.values(cats)
        .map((c) => ({
          ...c,
          total: roundToCents(c.total),
          income: roundToCents(c.income),
          expense: roundToCents(c.expense),
        }))
        .sort((a, b) => a.total - b.total);
    }

    return { categoryPivot };
  },
};
