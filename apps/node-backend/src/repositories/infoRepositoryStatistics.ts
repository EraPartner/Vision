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
  createUnconvertedTally,
  partitionConvertedRows,
  unconvertedFields,
  type UnconvertedTally,
} from "../lib/unconvertedTally.ts";
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
  /**
   * Part of `income` booked on `partner` and `joint` accounts (ADR-201). Present
   * only when one of them is non-zero; the rest of `income` is on `me` accounts
   * or on transactions without an account.
   */
  incomeByOwner?: { partner?: number; joint?: number };
}

export interface CategoryPivotOptions {
  excludedCategoryIds?: number[] | undefined;
  targetCurrency?: string | undefined;
  excludedRecipientIds?: number[] | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

/** An ungrouped `count(*)` always returns exactly one row. */
function parseCountRow(rows: Array<{ count: string }>): number {
  const [row] = rows;
  if (!row) throw new Error("count(*) returned no row");
  return parseInt(row.count, 10);
}

export const statisticsRepository = {
  /**
   * Category totals in `targetCurrency`. Rows without a stored rate are left
   * out (count and total) and recorded in `unconverted` when it is given.
   */
  async getCategoryBreakdown(
    targetCurrency = "EUR",
    ancestorCategoryId: number | undefined = undefined,
    filters: CategoryPivotOptions = {},
    unconverted: UnconvertedTally = createUnconvertedTally(),
  ): Promise<CategoryTotal[]> {
    const includeTransfers = await getIncludeTransfers();
    const exclusion = buildExclusionClauses({
      excludedCategoryIds: filters.excludedCategoryIds ?? [],
      excludedRecipientIds: filters.excludedRecipientIds ?? [],
      startParamIdx: ancestorCategoryId === undefined ? 1 : 2,
    });
    const params: unknown[] =
      ancestorCategoryId === undefined
        ? [...exclusion.params]
        : [ancestorCategoryId, ...exclusion.params];
    const clauses = exclusion.whereSql ? [exclusion.whereSql] : [];
    if (filters.startDate) {
      params.push(filters.startDate);
      clauses.push(`t.date >= $${params.length}`);
    }
    if (filters.endDate) {
      params.push(filters.endDate);
      clauses.push(`t.date <= $${params.length}`);
    }
    const filterSql = clauses.length ? `AND ${clauses.join(" AND ")}` : "";

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
          ${filterSql}
        GROUP BY ancestor.id, ancestor.path_name, t.currency
      `,
        params,
      );
      const { converted } = partitionConvertedRows(
        await convertRowsToEur(
          mapRowsForAmountConversion(rows, "amount", false),
          targetCurrency,
        ),
        (row) => parseInt(row.cnt, 10) || 0,
        unconverted,
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
    if (
      !filterSql &&
      !includeTransfers &&
      (await mvAvailable("mv_category_totals"))
    ) {
      const catRows = await queryRows(
        mvCategoryTotalsRowSchema,
        "SELECT * FROM mv_category_totals ORDER BY count DESC LIMIT 500",
      );
      const { converted } = partitionConvertedRows(
        await convertRowsToEur(
          mapRowsForAmountConversion(catRows, "total", true),
          targetCurrency,
        ),
        (row) => parseInt(String(row.count), 10) || 0,
        unconverted,
      );
      return buildCategoryFromConvertedRows(converted);
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
        ${filterSql}
      GROUP BY COALESCE(c.id, -1),
               COALESCE(c.path_name, 'UNCATEGORISED'),
               t.currency
    `,
      params,
    );

    const { converted: catConverted } = partitionConvertedRows(
      await convertRowsToEur(
        mapRowsForAmountConversion(categoryAmountRows, "amount", false),
        targetCurrency,
      ),
      (row) => parseInt(row.cnt, 10) || 0,
      unconverted,
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
    opts: { accountId?: number | null | undefined } = {},
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
    unconverted_count: number;
    unconverted_currencies: string[];
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
        SUM(t.amount) FILTER (WHERE t.amount >= 0 AND acct.owner = 'partner') AS income_partner,
        SUM(t.amount) FILTER (WHERE t.amount >= 0 AND acct.owner = 'joint') AS income_joint,
        COUNT(*) AS cnt
      FROM transactions t
      LEFT JOIN accounts acct ON acct.id = t.account_id
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
      // Owner legs (ADR-201) only when non-zero, so a household without
      // partner or joint accounts converts exactly the rows it did before.
      const incomePartner = Number(r.income_partner) || 0;
      if (incomePartner !== 0) {
        convRows.push({ ...base, _leg: "income_partner", amount: incomePartner });
      }
      const incomeJoint = Number(r.income_joint) || 0;
      if (incomeJoint !== 0) {
        convRows.push({ ...base, _leg: "income_joint", amount: incomeJoint });
      }
    }

    // A (category, date, currency) group without a stored rate is left out of
    // every cell; its transactions are counted once, on the income leg.
    const { converted, unconverted } = partitionConvertedRows(
      await convertRowsToEur(
        mapRowsForAmountConversion(convRows, "amount", false),
        targetCurrency,
        { useHistoricalRatesByDate: true, dateField: "date" },
      ),
      (row) => (row._leg === "income" ? row.cnt : 0),
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
      if (row._leg === "income_partner" || row._leg === "income_joint") {
        const owner = row._leg === "income_partner" ? "partner" : "joint";
        cell.incomeByOwner ??= {};
        cell.incomeByOwner[owner] = (cell.incomeByOwner[owner] ?? 0) + eur;
        continue;
      }
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
          ...(c.incomeByOwner
            ? {
                incomeByOwner: Object.fromEntries(
                  Object.entries(c.incomeByOwner).map(([owner, value]) => [
                    owner,
                    roundToCents(value),
                  ]),
                ),
              }
            : {}),
        }))
        .sort((a, b) => a.total - b.total);
    }

    return { categoryPivot, ...unconvertedFields(unconverted) };
  },
};
