/**
 * Row schemas for the info/analytics repositories, cash-flow forecasts,
 * insights, Belgian inflation, the rebalance workspace and the report data
 * fetchers (ADR-193).
 *
 * Each schema describes the row the SQLite driver (database/connection.ts,
 * ADR-263) returns for the projection named in its description — the shapes
 * node-postgres returned on PostgreSQL; see `../rowSchemas.ts` for the
 * primitives and conventions. Schemas only check.
 *
 * Aggregates: `dec_sum` of a decimal column is decimal text (a string), a
 * `COUNT(*)` read through a `::bigint` alias hint or `CAST(... AS TEXT)` is a
 * string (a bare one is a number), and `MIN`/`MAX` of a date column read with
 * a `::date` hint is a `Date`. An aggregate over a non-empty GROUP BY group is
 * never NULL; a `FILTER`ed one, a scalar aggregate and anything behind a LEFT
 * JOIN can be.
 */
import { z } from "zod";
import {
  dbAccountId,
  dbBigint,
  dbCategoryId,
  dbCurrency,
  dbDate,
  dbDayString,
  dbInt,
  dbInvestmentId,
  dbNumeric,
  dbPortfolioTransactionId,
  dbRecipientId,
  dbTagId,
  dbTimestamptz,
} from "../rowSchemas.ts";

/**
 * DOUBLE PRECISION / REAL. Any JS number, including NaN and ±Infinity, which
 * a float column can hold and `z.number()` would reject.
 */
export const dbDouble = z.custom<number>((value) => typeof value === "number", {
  message: "expected number",
});

/** A JSONB object column (the driver hands it back parsed). */
const dbJsonObject = z.record(z.string(), z.unknown());

/**
 * The `balance_parts` column of `computedBalanceByCurrencyAggLateral`:
 * a JSON array of `{ currency, balance }` with the balance as decimal text,
 * read through the `::json` alias hint; NULL for an account with no active
 * rows.
 */
const balancePartsSchema = z
  .array(z.object({ currency: dbCurrency, balance: dbNumeric }))
  .nullable();

/** `MIN(t.date) AS first_date` over a WHERE that can match nothing. */
export const ledgerStartRowSchema = z
  .object({ first_date: dbDate.nullable() })
  .describe("ledger start row");

// ---------------------------------------------------------------------------
// Statistics (infoRepositoryStatistics)
// ---------------------------------------------------------------------------

/**
 * Per (category, currency) amount: the ancestor rollup and the live
 * breakdown. `category_id` is `ancestor.id` or `COALESCE(c.id, -1)`.
 */
export const categoryCurrencyAmountRowSchema = z
  .object({
    category_id: dbCategoryId,
    name: z.string(),
    amount: dbNumeric,
    cnt: dbBigint,
    currency: dbCurrency,
  })
  .describe("category currency amount row");

/** `SELECT * FROM mv_category_totals` (materializedViewService). */
export const mvCategoryTotalsRowSchema = z
  .object({
    category_id: dbCategoryId,
    name: z.string(),
    count: dbBigint,
    total: dbNumeric,
    currency: dbCurrency,
  })
  .describe("mv_category_totals row");

/** `getBanks`: account labels with active transactions. */
export const bankLabelRowSchema = z
  .object({ bank_account: z.string() })
  .describe("bank label row");

/** `getCategoryPivot`: per (category, date, currency) income/expense sums. */
export const categoryPivotRowSchema = z
  .object({
    /** The effective-category COALESCE, filtered IS NOT NULL. */
    category_id: dbCategoryId,
    /** LEFT JOIN categories */
    category_name: z.string().nullable(),
    /** LEFT JOIN category_paths: INTEGER[] / TEXT[]. */
    category_path_ids: z.array(dbInt).nullable(),
    category_path_segments: z.array(z.string()).nullable(),
    period: z.string(),
    date: dbDate,
    currency: dbCurrency,
    /** SUM ... FILTER: NULL when the group has no row of that sign. */
    income: dbNumeric.nullable(),
    expense: dbNumeric.nullable(),
    /** Income from `partner` / `joint` accounts (ADR-201); NULL when there is none. */
    income_partner: dbNumeric.nullable().optional(),
    income_joint: dbNumeric.nullable().optional(),
    cnt: dbBigint,
  })
  .describe("category pivot row");

// ---------------------------------------------------------------------------
// Monthly summary (infoRepositoryMonthly)
// ---------------------------------------------------------------------------

/** The MV fast path, grouped by month and currency. */
export const mvMonthlyRowSchema = z
  .object({
    month_start: dbDate,
    month: dbInt,
    year: dbInt,
    currency: dbCurrency,
    /** SUM over the MV's BIGINT `transaction_count`: NUMERIC. */
    transaction_count: dbNumeric,
    total_income: dbNumeric,
    total_spending: dbNumeric,
    net_amount: dbNumeric,
  })
  .describe("mv monthly summary row");

/** The live path: a month LEFT JOINed to its per-(date, currency) totals. */
export const liveMonthlyRowSchema = z
  .object({
    month: dbInt,
    year: dbInt,
    period_start: dbDate,
    period_end: dbDate,
    /** NULL for a month without transactions. */
    date: dbDate.nullable(),
    currency: dbCurrency.nullable(),
    cnt: dbBigint.nullable(),
    income_amount: dbNumeric.nullable(),
    spending_amount: dbNumeric.nullable(),
  })
  .describe("live monthly summary row");

// ---------------------------------------------------------------------------
// Average vs current and forecast series
// ---------------------------------------------------------------------------

/** Per (date, currency, sign) amount (infoRepositoryAverageVsCurrent). */
export const signedDailyAmountRowSchema = z
  .object({
    date: dbDate,
    currency: dbCurrency,
    is_spending: z.boolean(),
    amount: dbNumeric,
    /** COUNT(*): the group's transactions. */
    cnt: dbBigint,
  })
  .describe("signed daily amount row");

/**
 * Per (date, currency) amount. Planned overlays alias `planned_date AS date`
 * into the same shape.
 */
export const dailyAmountRowSchema = z
  .object({
    amount: dbNumeric,
    /** COUNT(*): the group's transactions (planned rows for overlays). */
    cnt: dbBigint,
    currency: dbCurrency,
    date: dbDate,
  })
  .describe("daily amount row");

/** `getCashflowComparison`'s current-month actuals. */
export const dailyAmountDomRowSchema = dailyAmountRowSchema
  .extend({ day_of_month: dbInt })
  .describe("daily amount day-of-month row");

/** `getCashflowComparison`'s historical actuals. */
export const dailyAmountMonthRowSchema = dailyAmountDomRowSchema
  .extend({ month_key: z.string() })
  .describe("daily amount month row");

/** `getCashflowComparison`'s current-month planned overlay. */
export const plannedDailyAmountDomRowSchema = z
  .object({
    amount: dbNumeric,
    /** COUNT(*): the group's planned rows. */
    cnt: dbBigint,
    currency: dbCurrency,
    planned_date: dbDate,
    day_of_month: dbInt,
  })
  .describe("planned daily amount day-of-month row");

/** `getCashflowComparison`'s historical planned overlay. */
export const plannedDailyAmountMonthRowSchema = plannedDailyAmountDomRowSchema
  .extend({ month_key: z.string() })
  .describe("planned daily amount month row");

/** `getCashflowForecastDataByCategory`: per (date, currency, category). */
export const categoryDailyAmountRowSchema = dailyAmountRowSchema
  .extend({
    /** The effective-category COALESCE: NULL when uncategorised. */
    category_id: dbCategoryId.nullable(),
    /** COALESCE(..., 'Uncategorized') */
    general: z.string(),
    detail: z.string(),
    path_name: z.string(),
  })
  .describe("category daily amount row");

// ---------------------------------------------------------------------------
// Bank balances (infoRepositoryBanks)
// ---------------------------------------------------------------------------

/** `getBankBalances`' current balance: one row per (account, currency). */
export const bankBalanceRowSchema = z
  .object({
    account_id: dbAccountId,
    bank_account: z.string(),
    display_name: z.string(),
    currency: dbCurrency,
    balance: dbNumeric,
    /**
     * `json_object` over the decimal column with `json(balance)`: JSON
     * encodes it as a number, as PostgreSQL's json_build_object did, so
     * `balance` arrives as a JS number.
     */
    statement_balances: z.array(
      z.object({
        currency: dbCurrency,
        balance: z.number(),
        balance_date: dbDayString,
      }),
    ),
    account_currency: dbCurrency,
    anchor_date: dbDayString.nullable(),
    /** Scalar sub-select of a COUNT(*). */
    post_anchor_count: dbBigint.nullable(),
    date: dbDayString,
    transaction_count: dbBigint,
    first_transaction: dbDate.nullable(),
    last_transaction: dbDate.nullable(),
  })
  .describe("bank balance row");
export type BankBalanceRow = z.output<typeof bankBalanceRowSchema>;

/** `getBankBalances`' daily history per (account, day, currency). */
export const bankHistoryRowSchema = z
  .object({
    bank_account: z.string(),
    day: dbDayString,
    currency: dbCurrency,
    balance: dbNumeric,
  })
  .describe("bank history row");

// ---------------------------------------------------------------------------
// Net worth (infoRepositoryNetWorth)
// ---------------------------------------------------------------------------

/** LEAST of two scalar MINs: NULL when there is no source record. */
export const firstDataDateRowSchema = z
  .object({ first_data_date: dbDate.nullable() })
  .describe("net worth first data date row");

/** Portfolio snapshot values per day. */
export const snapshotInvestmentRowSchema = z
  .object({ day: dbDayString, investments: dbNumeric })
  .describe("net worth snapshot row");

/** The history walk: one row per (day, account, currency partition). */
export const netWorthHistoryRowSchema = z
  .object({
    day: dbDayString,
    bank_account: z.string(),
    is_liability: z.boolean(),
    currency: dbCurrency,
    balance: dbNumeric,
  })
  .describe("net worth history row");

/** The current point: one row per in-net-worth account. */
export const netWorthCurrentBalanceRowSchema = z
  .object({
    bank_account: z.string(),
    is_liability: z.boolean(),
    account_currency: dbCurrency,
    balance_parts: balancePartsSchema,
  })
  .describe("net worth current balance row");

/** The transaction-flow fallback: a running total per (day, bucket). */
export const netWorthFlowRowSchema = z
  .object({
    day: dbDayString,
    currency: dbCurrency,
    is_liability: z.boolean(),
    value: dbNumeric,
  })
  .describe("net worth flow row");

// ---------------------------------------------------------------------------
// Recipient, tag and Sankey aggregates
// ---------------------------------------------------------------------------

/** `getRecipientInsights`' top merchants, per (recipient, date, currency). */
export const recipientTopRawRowSchema = z
  .object({
    recipient_name: z.string(),
    recipient_id: dbRecipientId,
    date: dbDate,
    currency: dbCurrency,
    total_abs_amount: dbNumeric,
    tx_count: dbBigint,
    first_seen: dbDate,
    last_seen: dbDate,
  })
  .describe("recipient top merchants row");

/** `getRecipientInsights`' month-over-month rows. */
export const recipientMomRawRowSchema = z
  .object({
    recipient_id: dbRecipientId,
    recipient_name: z.string(),
    period: z.string(),
    date: dbDate,
    currency: dbCurrency,
    abs_amount: dbNumeric,
  })
  .describe("recipient month-over-month row");

/** The current / previous month keys, derived in SQL. */
export const periodKeysRowSchema = z
  .object({ current_period: z.string(), prev_period: z.string() })
  .describe("period keys row");

/**
 * `getRecipientByYear`. The recipient joins are LEFT JOINs, but
 * `transactions.recipient_id` is a NOT NULL foreign key, so `r` always
 * matches and the COALESCEd id and name (both NOT NULL) are never NULL.
 */
export const recipientYearRowSchema = z
  .object({
    year: dbInt,
    recipient_id: dbRecipientId,
    name: z.string(),
    date: dbDate,
    currency: dbCurrency,
    abs_amount: dbNumeric,
    cnt: dbBigint,
  })
  .describe("recipient by year row");

/** `getRecipientPivot`'s alias-member resolution. */
export const recipientMemberRowSchema = z
  .object({ id: dbRecipientId })
  .describe("recipient member row");

/** `getRecipientPivot`: per (recipient, period, date, currency). */
export const recipientPivotRowSchema = z
  .object({
    recipient_id: dbRecipientId,
    recipient_name: z.string(),
    period: z.string(),
    date: dbDate,
    currency: dbCurrency,
    abs_amount: dbNumeric,
    cnt: dbBigint,
  })
  .describe("recipient pivot row");

/** `getTagPivot`: per (tag, period, date, currency). */
export const tagPivotRowSchema = z
  .object({
    tag_id: dbTagId,
    tag_slug: z.string(),
    period: z.string(),
    date: dbDate,
    currency: dbCurrency,
    abs_amount: dbNumeric,
    cnt: dbBigint,
  })
  .describe("tag pivot row");

/** `getSankeyAggregates`; the category is a LEFT JOIN. */
export const sankeyAggregateRowSchema = z
  .object({
    category_id: dbCategoryId.nullable(),
    category_name: z.string().nullable(),
    currency: dbCurrency,
    is_income: z.boolean(),
    /** SUM(ABS(NUMERIC)) */
    amount: dbNumeric,
    /** COUNT(*): the group's transactions. */
    cnt: dbBigint,
  })
  .describe("sankey aggregate row");
export type SankeyAggregateRow = z.output<typeof sankeyAggregateRowSchema>;

// ---------------------------------------------------------------------------
// Cash-flow forecast caches and accuracy
// ---------------------------------------------------------------------------

/**
 * A `cashflow_forecast_accuracy` read, `as_of_month` through `to_char`.
 * mae/rmse/mape are DOUBLE PRECISION and, with sample_days, nullable columns
 * (migration 0012). `upsert` binds numbers for mae, rmse and sample_days, but
 * nothing in the schema rules out NULL, so the contract admits it; `mape` is
 * NULL when no month had a percentage sample.
 */
export const forecastAccuracyRowSchema = z
  .object({
    user_id: z.string(),
    method_id: z.string(),
    as_of_month: z.string(),
    mae: dbDouble.nullable(),
    rmse: dbDouble.nullable(),
    mape: dbDouble.nullable(),
    sample_days: dbInt.nullable(),
    recorded_at: dbTimestamptz,
  })
  .describe("cashflow forecast accuracy row");
export type ForecastAccuracyRow = z.output<typeof forecastAccuracyRowSchema>;

/** `SELECT DISTINCT user_id FROM cashflow_forecast_accuracy`. */
export const forecastUserIdRowSchema = z
  .object({ user_id: z.string() })
  .describe("forecast user id row");

/** A cached Monte Carlo forecast (monthly or rolling): JSONB payload. */
export const forecastMcCacheRowSchema = z
  .object({ payload: dbJsonObject, computed_at: dbTimestamptz })
  .describe("forecast mc cache row");
export type ForecastMcCacheRow = z.output<typeof forecastMcCacheRowSchema>;

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/** The `insight_dismissals.kind` CHECK constraint. */
const insightKindSchema = z.enum([
  "subscription_new",
  "subscription_price_change",
  "category_outlier",
]);

/**
 * An `insight_dismissals` row with `month_start` through `to_char` as
 * `month_key`. `id` is BIGSERIAL; `deviation_at_dismiss` is DOUBLE PRECISION.
 */
export const insightDismissalRowSchema = z
  .object({
    id: dbBigint,
    kind: insightKindSchema,
    recipient_id: dbRecipientId.nullable(),
    category_id: dbCategoryId.nullable(),
    month_key: z.string().nullable(),
    dismissed_at: dbTimestamptz,
    deviation_at_dismiss: dbDouble.nullable(),
  })
  .describe("insight_dismissals row");
export type InsightDismissalRow = z.output<typeof insightDismissalRowSchema>;

/** `listDismissals` (no id). */
export const insightDismissalListRowSchema = insightDismissalRowSchema
  .omit({ id: true })
  .describe("insight dismissal list row");

/** `upsertSubscription`'s RETURNING. */
export const insightSubscriptionDismissalRowSchema = insightDismissalRowSchema
  .pick({ id: true, kind: true, recipient_id: true, dismissed_at: true })
  .describe("insight subscription dismissal row");

/** `upsertOutlier`'s RETURNING. */
export const insightOutlierDismissalRowSchema = insightDismissalRowSchema
  .omit({ recipient_id: true })
  .describe("insight outlier dismissal row");

/** `SELECT EXISTS (...) AS exists`. */
export const existsRowSchema = z
  .object({ exists: z.boolean() })
  .describe("exists row");

/** The `insight_digest_state` singleton; the versions are BIGINT. */
export const insightDigestStateRowSchema = z
  .object({
    undismissed_count: dbInt.nullable(),
    dirty_version: dbBigint,
    computed_version: dbBigint,
    computed_at: dbTimestamptz.nullable(),
    expires_at: dbTimestamptz.nullable(),
  })
  .describe("insight digest state row");
export type InsightDigestStateRow = z.output<
  typeof insightDigestStateRowSchema
>;

/** `saveCountIfVersion`'s `RETURNING computed_at` (set to NOW()). */
export const computedAtRowSchema = z
  .object({ computed_at: dbTimestamptz })
  .describe("computed at row");

/** `insight_cash_projections.month_end_net_cashflow` (NUMERIC NOT NULL). */
export const cashProjectionRowSchema = z
  .object({ month_end_net_cashflow: dbNumeric })
  .describe("cash projection row");

// ---------------------------------------------------------------------------
// Belgian inflation rates
// ---------------------------------------------------------------------------

/** A row of `belgian_inflation_rates` (migration 0001). */
export const belgianInflationRateRowSchema = z
  .object({
    id: dbInt,
    /** DATE (first of month). */
    month_date: dbDate,
    /** NUMERIC(10,8) */
    monthly_rate: dbNumeric,
    /** VARCHAR(50) NOT NULL DEFAULT 'statbel' */
    source: z.string(),
    fetched_at: dbTimestamptz,
    updated_at: dbTimestamptz,
  })
  .describe("belgian_inflation_rates row");

/** `loadFromDatabase`' projection. */
export const belgianInflationMonthRowSchema = belgianInflationRateRowSchema
  .pick({ month_date: true, monthly_rate: true })
  .describe("belgian inflation month row");

// ---------------------------------------------------------------------------
// Rebalance workspace (crossWorkspaceDataService)
// ---------------------------------------------------------------------------

/** A spendable account with its per-currency computed balance. */
export const rebalanceCashAccountRowSchema = z
  .object({
    id: dbAccountId,
    name: z.string(),
    currency: dbCurrency,
    balance_parts: balancePartsSchema,
  })
  .describe("rebalance cash account row");

// ---------------------------------------------------------------------------
// Report data fetchers
// ---------------------------------------------------------------------------

/** The `portfolio_transactions.income_recognition_role` CHECK constraint. */
const incomeRecognitionRoleSchema = z.enum(["standard", "included_in_units"]);

/** `fetchTaxTransactions` (reports/dataFetcherTax). */
export const taxTxnRowSchema = z
  .object({
    id: dbPortfolioTransactionId,
    investment_id: dbInvestmentId,
    investment_name: z.string(),
    symbol: z.string().nullable(),
    /** `asset_class` enum */
    asset_class: z.string(),
    /** `portfolio_txn_type` enum */
    type: z.string(),
    /** CHECK constraint */
    dividend_amount_convention: z.enum(["gross", "net", "unknown"]),
    income_recognition_role: incomeRecognitionRoleSchema,
    /** COALESCE(NUMERIC, 0) */
    amount: dbNumeric,
    taxes: dbNumeric,
    fees: dbNumeric,
    currency: dbCurrency,
    rate_date: dbDayString,
    year: dbInt,
    month: dbInt,
  })
  .describe("report tax transaction row");

/** `fetchDividends` (reports/dataFetcherPortfolio). */
export const dividendTxRowSchema = z
  .object({
    investment_id: dbInvestmentId,
    investment_name: z.string(),
    symbol: z.string().nullable(),
    asset_class: z.string(),
    year: dbInt,
    month: dbInt,
    amount: dbNumeric,
    currency: dbCurrency,
    income_recognition_role: incomeRecognitionRoleSchema,
    rate_date: dbDayString,
  })
  .describe("report dividend row");
