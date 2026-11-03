/**
 * Row schemas for the portfolio (non-import), investment, price and currency
 * queries (ADR-193).
 *
 * Same rules as `../rowSchemas.ts`: each schema describes the row shape the
 * driver returns (ADR-263; the shape node-postgres returned with its DEFAULT
 * parsers: NUMERIC/BIGINT/`COUNT(*)` as strings, DATE/TIMESTAMPTZ as `Date`,
 * INTEGER as number, JSON parsed), only checks (no transforms or coercion), and
 * stays a plain `z.object` so `SELECT *` keeps working when a migration adds a
 * column. `.nullable()` marks SQL NULL; `.optional()` marks a column only some
 * projections select.
 *
 * Two easy-to-miss facts:
 *   - an expression column has no declared type, so the SQL gives it an alias
 *     hint (`AS "id::bigint"`, see {@link hintedAlias}) or yields text itself
 *     (`COALESCE(units, '0')`, `CAST(count(*) AS TEXT)`); a `UNION ALL` takes
 *     each column's type from its first branch;
 *   - `SELECT t.*, to_char(t.date, ...) AS date` returns two `date` fields and
 *     the driver keeps the LAST one, so `date` is the formatted string.
 */
import { z } from "zod";
import type { FundHoldingsDocument } from "@vision/types/fund-holdings";
import {
  dbAccountId,
  dbBigint,
  dbCurrency,
  dbDate,
  dbDayString,
  dbInt,
  dbInvestmentId,
  dbNumeric,
  dbPortfolioTransactionId,
  dbTimestamptz,
  dbTransactionId,
} from "../rowSchemas.ts";

/** The driver's alias type hints (src/database/sqlite/values.ts). */
export type AliasHint = "bool" | "json" | "timestamptz" | "date" | "bigint" | "text";

/**
 * A column alias with a driver type hint for an expression column (ADR-263):
 * the SQL alias is `name::hint`, the driver reads the value as that type and
 * removes the hint from the row key. Typed as `name`, so a Kysely `.as()`
 * keeps the key the row schema checks.
 */
export function hintedAlias<N extends string>(name: N, hint: AliasHint): N {
  return `${name}::${hint}` as N;
}

// ---------------------------------------------------------------------------
// Small shared projections
// ---------------------------------------------------------------------------

/** `RETURNING id` / `SELECT id` over an INTEGER/SERIAL key. */
export const portfolioIntIdRowSchema = z
  .object({ id: dbInt })
  .describe("portfolio int id row");

/** `SELECT id` / `RETURNING id` over `portfolio_transactions`. */
export const portfolioTransactionKeyRowSchema = z
  .object({ id: dbPortfolioTransactionId })
  .describe("portfolio transaction id row");

/**
 * `SELECT id` / `RETURNING id` over `investments`.
 * @public
 */
export const investmentKeyRowSchema = z
  .object({ id: dbInvestmentId })
  .describe("investment id row");

/** `RETURNING id` over a BIGINT/BIGSERIAL key. */
export const portfolioBigintIdRowSchema = z
  .object({ id: dbBigint })
  .describe("portfolio bigint id row");

/** `SELECT EXISTS (...) AS present`: EXISTS is never NULL. */
export const presentRowSchema = z
  .object({ present: z.boolean() })
  .describe("present row");

/** `SELECT id,is_active,type FROM accounts` inside the custody write transaction. */
export const custodyAccountLockRowSchema = z
  .object({
    id: dbAccountId,
    is_active: z.boolean(),
    /** `account_type` enum. */
    type: z.string(),
  })
  .describe("custody account lock row");

const incomeRecognitionRoleSchema = z.enum(["standard", "included_in_units"]);

// ---------------------------------------------------------------------------
// portfolio_transactions
// ---------------------------------------------------------------------------

/** A raw `portfolio_transactions` row (`SELECT *` / `RETURNING *`). */
export const portfolioTransactionDbRowSchema = z
  .object({
    id: dbPortfolioTransactionId,
    investment_id: dbInvestmentId,
    /** `portfolio_txn_type` enum. */
    type: z.string(),
    date: dbDate,
    /** NUMERIC(18,4) NOT NULL */
    amount: dbNumeric,
    units: dbNumeric.nullable(),
    price_per_unit: dbNumeric.nullable(),
    fees: dbNumeric.nullable(),
    taxes: dbNumeric.nullable(),
    currency: dbCurrency,
    fx_rate_to_eur: dbNumeric.nullable(),
    note: z.string().nullable(),
    is_recurring: z.boolean(),
    recurrence_interval: z.string().nullable(),
    recurrence_end_date: dbDate.nullable(),
    created_at: dbTimestamptz,
    updated_at: dbTimestamptz,
    account_id: dbAccountId.nullable(),
    /**
     * BIGINT FK (migration 0086). Optional because the repository still
     * probes for the column (`hasPortfolioTransactionImportBatchIdColumn`).
     */
    import_batch_id: dbBigint.nullable().optional(),
    dividend_amount_convention: z.enum(["gross", "net", "unknown"]),
    source_record_hash: z.string().nullable(),
    dedup_fingerprint: z.string().nullable(),
    dedup_fingerprint_version: dbInt.nullable(),
    income_recognition_role: incomeRecognitionRoleSchema,
  })
  .describe("portfolio_transactions row");

/** `getAllWithCount`: the raw row plus the window `COUNT(*) OVER ()`. */
export const portfolioTransactionCountedRowSchema =
  portfolioTransactionDbRowSchema
    .extend({ total_count: dbBigint })
    .describe("portfolio_transactions counted row");

/** `getUnitEventIdsForImportBatch`. */
export const portfolioTransactionIdPairRowSchema = z
  .object({ id: dbPortfolioTransactionId, investment_id: dbInvestmentId })
  .describe("portfolio transaction id pair row");

/** `getAccountLabel`: `accounts.name` is NOT NULL. */
export const accountLabelRowSchema = z
  .object({ display_name: z.string().nullable(), name: z.string() })
  .describe("account label row");

/** `getAssetClassByInvestmentId`. */
export const assetClassRowSchema = z
  .object({ asset_class: z.string() })
  .describe("asset class row");

/**
 * `getUnitEventsForInvestment`: transactions, asset transfers and asset
 * adjustments in one UNION; ids are BIGINT strings (the three tables share
 * one id sequence) and the numeric columns decimal text.
 */
export const portfolioUnitEventRowSchema = z
  .object({
    id: dbBigint,
    type: z.string(),
    date: dbDayString,
    /** `COALESCE(units, 0)` on the transaction leg. */
    units: dbNumeric,
    account_id: dbAccountId.nullable(),
    amount: dbNumeric,
    /** Raw nullable `fees` on the transaction leg. */
    fees: dbNumeric.nullable(),
    taxes: dbNumeric.nullable(),
    /** NULL when a non-EUR transaction has neither a stamped nor a stored rate. */
    fxMultiplier: dbNumeric.nullable(),
    source_account_id: dbAccountId.nullable(),
    destination_account_id: dbAccountId.nullable(),
    fee_units: dbNumeric,
    transfer_id: dbBigint.nullable(),
    currency: dbCurrency.nullable(),
    source_record_hash: z.string().nullable(),
    adjustment_kind: z.enum(["yield_reversal", "asset_fee"]).nullable(),
    basis_policy: z.enum(["zero_yield_only", "carried"]).nullable(),
    eligible_source_record_hashes: z.array(z.string()).nullable(),
    adjustment_id: dbBigint.nullable(),
    income_recognition_role: incomeRecognitionRoleSchema,
  })
  .describe("portfolio unit event row");

/**
 * `getRowsForPortfolioMath`: the same three-way UNION for the math paths,
 * NUMERIC columns COALESCEd to 0 except `fx_rate_to_eur`.
 */
export const portfolioMathTxRowSchema = z
  .object({
    /** BIGINT string: one id sequence across the three event tables. */
    id: dbBigint,
    investment_id: dbInvestmentId,
    type: z.string(),
    amount: dbNumeric,
    units: dbNumeric,
    fees: dbNumeric,
    taxes: dbNumeric,
    date: dbDayString,
    /** Same value as `date`, second alias. */
    day: dbDayString,
    currency: dbCurrency,
    fx_rate_to_eur: dbNumeric.nullable(),
    account_id: dbAccountId.nullable(),
    /** Custody event origin; NULL on transaction and adjustment legs. */
    source_account_id: dbAccountId.nullable(),
    destination_account_id: dbAccountId.nullable(),
    fee_units: dbNumeric,
    source_record_hash: z.string().nullable(),
    adjustment_kind: z.enum(["yield_reversal", "asset_fee"]).nullable(),
    basis_policy: z.enum(["zero_yield_only", "carried"]).nullable(),
    eligible_source_record_hashes: z.array(z.string()).nullable(),
    income_recognition_role: incomeRecognitionRoleSchema,
  })
  .describe("portfolio math row");

/** `getSummary`: SUM over nullable NUMERIC columns can be NULL. */
export const portfolioTransactionSummaryDbRowSchema = z
  .object({
    type: z.string(),
    income_recognition_role: incomeRecognitionRoleSchema,
    /** SUM over the NOT NULL `amount`; every group has at least one row. */
    total_amount: dbNumeric,
    total_units: dbNumeric.nullable(),
    total_fees: dbNumeric.nullable(),
    total_taxes: dbNumeric.nullable(),
    /** Bare COUNT(*) */
    count: dbBigint,
  })
  .describe("portfolio transaction summary row");

/** The jsonb `portfolio_income_transaction_snapshot(pt)` returns. */
export const portfolioTransactionSnapshotSchema = z.object({
  id: dbPortfolioTransactionId,
  investment_id: dbInvestmentId,
  type: z.string(),
  date: z.string(),
  amount: z.string().nullable(),
  units: z.string().nullable(),
  price_per_unit: z.string().nullable(),
  fees: z.string().nullable(),
  taxes: z.string().nullable(),
  currency: dbCurrency.nullable(),
  fx_rate_to_eur: z.string().nullable(),
  account_id: dbAccountId.nullable(),
  note: z.string().nullable(),
  dividend_amount_convention: z.string(),
  is_recurring: z.boolean(),
  recurrence_interval: z.string().nullable(),
  recurrence_end_date: z.string().nullable(),
  import_batch_id: z.string().nullable(),
  source_record_hash: z.string().nullable(),
  dedup_fingerprint: z.string().nullable(),
  dedup_fingerprint_version: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// Income recognition journal
// ---------------------------------------------------------------------------

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** A `portfolio_import_income_recognition_journal` row (`SELECT r.*`). */
export const incomeRecognitionJournalRowSchema = z
  .object({
    id: dbBigint,
    batch_id: dbBigint,
    staging_row_id: dbBigint,
    unit_staging_row_id: dbBigint,
    income_transaction_id: dbPortfolioTransactionId,
    unit_transaction_id: dbPortfolioTransactionId,
    action: z.enum(["record", "restore"]),
    previous_entry_id: dbBigint.nullable(),
    /** CHECK jsonb_typeof = 'object' */
    income_data: jsonObjectSchema,
    unit_data: jsonObjectSchema,
    proof_data: jsonObjectSchema,
    created_at: dbTimestamptz,
  })
  .describe("income recognition journal row");

// ---------------------------------------------------------------------------
// Broker re-tag
// ---------------------------------------------------------------------------

/** `lockEligibleDestinationAccount`. */
export const retagDestinationAccountRowSchema = z
  .object({
    id: dbAccountId,
    name: z.string(),
    display_name: z.string().nullable(),
    /** `account_type` enum. */
    type: z.string(),
    is_active: z.boolean(),
  })
  .describe("retag destination account row");

/** `lockTransactions`. */
export const retagLockedTransactionRowSchema = z
  .object({
    id: dbPortfolioTransactionId,
    investment_id: dbInvestmentId,
    account_id: dbAccountId.nullable(),
  })
  .describe("retag locked transaction row");

/** `getUnitEventsForInvestments`' transaction projection. */
export const retagTransactionEventRowSchema = z
  .object({
    id: dbPortfolioTransactionId,
    investment_id: dbInvestmentId,
    /** `portfolio_txn_type` enum. */
    type: z.string(),
    date: dbDayString,
    amount: dbNumeric,
    units: dbNumeric,
    fees: dbNumeric,
    taxes: dbNumeric,
    currency: dbCurrency,
    fx_rate_to_eur: dbNumeric.nullable(),
    /** NULL when a non-EUR row has neither a stamped nor a stored rate. */
    fx_multiplier_eur: dbNumeric.nullable(),
    account_id: dbAccountId.nullable(),
    /** `asset_class` enum. */
    asset_class: z.string(),
    current_price: dbNumeric,
    interest_rate: dbNumeric,
  })
  .describe("retag transaction event row");

// ---------------------------------------------------------------------------
// Asset adjustments and transfers
// ---------------------------------------------------------------------------

/** `getEligibleYieldSources`: MIN over a BIGINT staging id, as text. */
export const eligibleYieldSourceRowSchema = z
  .object({
    source_record_hash: z.string(),
    staging_row_id: dbBigint,
  })
  .describe("eligible yield source row");

/** `portfolio_asset_adjustments` with `date` re-projected as 'YYYY-MM-DD'. */
export const portfolioAssetAdjustmentRowSchema = z
  .object({
    id: dbBigint,
    investment_id: dbInvestmentId,
    account_id: dbAccountId,
    date: dbDayString,
    units: dbNumeric,
    adjustment_kind: z.enum(["yield_reversal", "asset_fee"]),
    basis_policy: z.enum(["zero_yield_only", "carried"]),
    eligible_source_record_hashes: z.array(z.string()),
    /** jsonb object, DEFAULT '{}'. */
    basis_allocations: jsonObjectSchema,
    import_batch_id: dbBigint,
    staging_row_id: dbBigint,
    source_record_hash: z.string(),
    dedup_fingerprint: z.string(),
    dedup_fingerprint_version: dbInt,
    created_at: dbTimestamptz,
  })
  .describe("portfolio_asset_adjustments row");

/** `portfolio_asset_transfers` with `date` re-projected as 'YYYY-MM-DD'. */
export const portfolioAssetTransferRowSchema = z
  .object({
    id: dbBigint,
    investment_id: dbInvestmentId,
    source_account_id: dbAccountId,
    destination_account_id: dbAccountId,
    date: dbDayString,
    units: dbNumeric,
    fee_units: dbNumeric,
    /** jsonb object, DEFAULT '{}'. */
    fee_basis_allocations: jsonObjectSchema,
    import_batch_id: dbBigint,
    staging_row_id: dbBigint,
    source_record_hash: z.string(),
    dedup_fingerprint: z.string(),
    dedup_fingerprint_version: dbInt,
    created_at: dbTimestamptz,
  })
  .describe("portfolio_asset_transfers row");

// ---------------------------------------------------------------------------
// Exposure
// ---------------------------------------------------------------------------

/** `portfolio_exposure_classifications` with camelCase aliases. */
export const exposureClassificationRowSchema = z
  .object({
    /** UUID */
    id: z.string(),
    investmentId: dbInvestmentId.nullable(),
    identifierType: z.string().nullable(),
    identifierValue: z.string().nullable(),
    identifierExchange: z.string().nullable(),
    issuerId: z.string(),
    issuerName: z.string(),
    sector: z.string().nullable(),
    issuerCountryCode: z.string().nullable(),
    sourceLabel: z.string(),
    createdAt: dbTimestamptz,
    updatedAt: dbTimestamptz,
  })
  .describe("exposure classification row");

const isJsonObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A stored fund holdings document. It was validated against
 * `fundHoldingsDocumentSchema` before it was written; re-running that strict,
 * refined input schema on every read would turn a later tightening of the
 * input rules into a read outage, so the row check only asserts a JSON object.
 */
const storedFundHoldingsDocumentSchema = z.custom<FundHoldingsDocument>(
  isJsonObject,
  { message: "expected a fund holdings document object" },
);

/** `portfolio_fund_holdings_documents` with camelCase aliases. */
export const fundHoldingsDocumentRowSchema = z
  .object({
    /** UUID */
    id: z.string(),
    investmentId: dbInvestmentId,
    shareClassIdentifier: z.object({
      type: z.string(),
      value: z.string(),
      exchange: z.string().nullable().optional(),
    }),
    document: storedFundHoldingsDocumentSchema,
    sourceAsOfDate: dbDate,
    sourceSha256: z.string(),
    createdAt: dbTimestamptz,
    updatedAt: dbTimestamptz,
  })
  .describe("fund holdings document row");

/** `listExposureTargets`. */
export const exposureTargetRowSchema = z
  .object({ id: dbInvestmentId, assetClass: z.string() })
  .describe("exposure target row");

// ---------------------------------------------------------------------------
// Investments
// ---------------------------------------------------------------------------

/** A raw `investments` row (`SELECT i.*` / `RETURNING *`). */
export const investmentDbRowSchema = z
  .object({
    id: dbInvestmentId,
    name: z.string(),
    symbol: z.string().nullable(),
    /** `asset_class` enum. */
    asset_class: z.string(),
    currency: dbCurrency,
    /** NUMERIC(18,6) */
    current_price: dbNumeric.nullable(),
    interest_rate: dbNumeric.nullable(),
    maturity_date: dbDate.nullable(),
    location: z.string().nullable(),
    municipality: z.string().nullable(),
    cadastral_income: dbNumeric.nullable(),
    municipality_tax_rate: dbNumeric.nullable(),
    notes: z.string().nullable(),
    is_active: z.boolean(),
    /** `price_provider` enum. */
    price_provider: z.string(),
    price_provider_id: z.string().nullable(),
    price_provider_url: z.string().nullable(),
    price_provider_latest_url: z.string().nullable(),
    price_provider_latest_path: z.string().nullable(),
    price_provider_history_url: z.string().nullable(),
    price_provider_history_path: z.string().nullable(),
    price_provider_history_ts_path: z.string().nullable(),
    price_provider_history_price_path: z.string().nullable(),
    price_updated_at: dbTimestamptz.nullable(),
    created_at: dbTimestamptz,
    updated_at: dbTimestamptz,
    /** `COALESCE(tp.show_in_ticker, true)` on the joined reads only. */
    show_in_ticker: z.boolean().optional(),
  })
  .describe("investments row");

/** `getAllWithCount`: the joined row plus `COUNT(*) OVER ()`. */
export const investmentCountedDbRowSchema = investmentDbRowSchema
  .extend({ total_count: dbBigint })
  .describe("investments counted row");

/**
 * `portfolioSummaryService`'s `SELECT i.*` with `currency`, `current_price`
 * and `interest_rate` re-projected through COALESCE (non-null).
 */
export const summaryInvestmentDbRowSchema = investmentDbRowSchema
  .extend({ current_price: dbNumeric, interest_rate: dbNumeric })
  .describe("portfolio summary investments row");

/** `getLatestPriceUpdatedAt`: MAX over zero rows is NULL. */
export const latestPriceUpdatedAtRowSchema = z
  .object({ latest: dbTimestamptz.nullable() })
  .describe("latest price updated row");

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

/** A raw `watchlist` row (`SELECT *` / `RETURNING *`). */
export const watchlistRowSchema = z
  .object({
    id: dbInt,
    name: z.string(),
    symbol: z.string().nullable(),
    /** `asset_class` enum. */
    asset_class: z.string(),
    /** NUMERIC(18,6) */
    target_price: dbNumeric,
    currency: dbCurrency,
    notes: z.string().nullable(),
    price_provider_id: z.string().nullable(),
    /** NUMERIC(18,6); NULL on rows predating migration 0058. */
    added_price: dbNumeric.nullable(),
    created_at: dbTimestamptz,
    updated_at: dbTimestamptz,
  })
  .describe("watchlist row");

/** `getAllWithCount`. */
export const watchlistCountedRowSchema = watchlistRowSchema
  .extend({ total_count: dbBigint })
  .describe("watchlist counted row");

// ---------------------------------------------------------------------------
// Research provider tables
// ---------------------------------------------------------------------------

/** `instrument_provider_map` (migration 0042), the full table. */
export const instrumentProviderMapRowSchema = z
  .object({
    id: dbInt,
    instrument_key: z.string(),
    key_type: z.enum(["isin", "internal"]),
    provider: z.string(),
    provider_symbol: z.string().nullable(),
    resolved_name: z.string().nullable(),
    exchange: z.string().nullable(),
    currency: dbCurrency.nullable(),
    status: z.enum(["confirmed", "auto", "failed"]),
    verified_at: dbTimestamptz.nullable(),
    created_at: dbTimestamptz,
    updated_at: dbTimestamptz,
  })
  .describe("instrument_provider_map row");

/** `provider_health` (migration 0010). */
export const providerHealthRowSchema = z
  .object({
    provider: z.string(),
    kind: z.string(),
    last_success_at: dbTimestamptz.nullable(),
    last_error_at: dbTimestamptz.nullable(),
    last_error: z.string().nullable(),
    consecutive_failures: dbInt,
    updated_at: dbTimestamptz,
  })
  .describe("provider_health row");

/** `provider_quota.count` (INTEGER). */
export const providerQuotaCountRowSchema = z
  .object({ count: dbInt })
  .describe("provider quota count row");

/** `provider_api_keys` (migration 0043). */
export const providerApiKeyRowSchema = z
  .object({
    provider: z.string(),
    api_key: z.string(),
    updated_at: dbTimestamptz,
  })
  .describe("provider_api_keys row");

// ---------------------------------------------------------------------------
// Prices (asset_price_history) and quote backfill
// ---------------------------------------------------------------------------

/** A full `asset_price_history` row. */
export const assetPriceHistoryRowSchema = z
  .object({
    id: dbInt,
    investment_id: dbInvestmentId,
    price_date: dbDate,
    /** NUMERIC(18,6) */
    close_price: dbNumeric,
    source: z.string(),
    fetched_at: dbTimestamptz,
    updated_at: dbTimestamptz,
  })
  .describe("asset_price_history row");

/** `loadHistoricalPointsFromDatabase`. */
export const pricePointDbRowSchema = assetPriceHistoryRowSchema
  .pick({ price_date: true, close_price: true })
  .describe("price point row");

/** `loadLatestHistoricalPointByInvestmentIds`. */
export const latestPricePointDbRowSchema = assetPriceHistoryRowSchema
  .pick({ investment_id: true, price_date: true, close_price: true })
  .describe("latest price point row");

/** `quoteBackfillService`'s selectHoldingWindowRows(). */
export const holdingWindowRowSchema = z
  .object({
    id: dbInvestmentId,
    asset_class: z.string(),
    currency: dbCurrency,
    price_provider: z.string(),
    price_provider_id: z.string().nullable(),
    symbol: z.string().nullable(),
    price_provider_url: z.string().nullable(),
    price_provider_latest_url: z.string().nullable(),
    price_provider_latest_path: z.string().nullable(),
    price_provider_history_url: z.string().nullable(),
    price_provider_history_path: z.string().nullable(),
    price_provider_history_ts_path: z.string().nullable(),
    price_provider_history_price_path: z.string().nullable(),
    tx_id: dbPortfolioTransactionId,
    /** `portfolio_txn_type` enum, filtered to buy|gift|sell. */
    tx_type: z.string(),
    tx_date: dbDayString,
    /** `COALESCE(pt.units, 0)` */
    tx_units: dbNumeric,
  })
  .describe("holding window row");

/** `getStoredPriceDates`. */
export const storedPriceDateRowSchema = z
  .object({ d: dbDayString })
  .describe("stored price date row");

// ---------------------------------------------------------------------------
// Snapshot builder and performance snapshots
// ---------------------------------------------------------------------------

/** `getFirstDataDate`: MIN over zero rows is NULL. */
export const firstDataDateRowSchema = z
  .object({ first_data_date: dbDate.nullable() })
  .describe("first data date row");

/** The day walk's unit-priced investment seed. */
export const snapshotUnitInvestmentRowSchema = z
  .object({
    id: dbInvestmentId,
    currency: dbCurrency,
    /** `COALESCE(i.current_price, 0)` */
    current_price: dbNumeric,
    asset_class: z.string(),
  })
  .describe("snapshot unit investment row");

/** The day walk's savings/bond/real_estate seed. */
export const snapshotNonUnitInvestmentRowSchema =
  snapshotUnitInvestmentRowSchema
    .extend({
      /** `COALESCE(interest_rate, 0)` */
      interest_rate: dbNumeric,
      /** `COALESCE(ts_date(created_at), $1)` */
      active_from: dbDayString,
    })
    .describe("snapshot non-unit investment row");

/** The day walk's price history. */
export const snapshotPriceHistoryRowSchema = z
  .object({
    investment_id: dbInvestmentId,
    day: dbDayString,
    close_price: dbNumeric,
  })
  .describe("snapshot price history row");

/** The day walk's Belgian inflation series. */
export const snapshotInflationRowSchema = z
  .object({
    /** 'YYYY-MM' */
    month: z.string(),
    /** NUMERIC(10,8) */
    monthly_rate: dbNumeric,
  })
  .describe("snapshot inflation row");

/** `exchange_rates` `currency_code, rate_to_eur` (latest or point reads). */
export const fxRateRowSchema = z
  .object({ currency_code: z.string(), rate_to_eur: dbNumeric })
  .describe("fx rate row");

/** A single `rate_to_eur` lookup. */
export const rateToEurRowSchema = z
  .object({ rate_to_eur: dbNumeric })
  .describe("rate to eur row");

/** The day walk's FX history (`to_char(rate_date) AS day`). */
export const snapshotFxHistoryRowSchema = fxRateRowSchema
  .extend({ day: dbDayString })
  .describe("snapshot fx history row");

/** `SELECT * FROM portfolio_performance_snapshots`. */
export const portfolioPerformanceSnapshotRowSchema = z
  .object({
    id: dbInt,
    snapshot_date: dbDate,
    invested: dbNumeric,
    value: dbNumeric,
    stocks_etfs_value: dbNumeric,
    crypto_value: dbNumeric,
    metals_value: dbNumeric,
    cash_value: dbNumeric,
    gain_loss: dbNumeric,
    return_pct: dbNumeric,
    inflation_adjusted_value: dbNumeric,
    cumulative_inflation: dbNumeric,
    real_return_pct: dbNumeric,
    stocks_etfs_invested: dbNumeric,
    crypto_invested: dbNumeric,
    metals_invested: dbNumeric,
    currency: dbCurrency,
    computed_at: dbTimestamptz,
    /** NUMERIC(18,2), migration 0039; absent on un-migrated databases. */
    value_fx_neutral: dbNumeric.nullable().optional(),
  })
  .describe("portfolio_performance_snapshots row");

/** `portfolio_broker_snapshots` as `getBrokerSnapshots` projects it. */
export const brokerSnapshotRowSchema = z
  .object({
    snapshot_date: dbDate,
    currency: dbCurrency,
    account_key: z.string(),
    account_id: dbAccountId.nullable(),
    account_name: z.string(),
    value: dbNumeric,
    invested: dbNumeric,
    gain_loss: dbNumeric,
    computed_at: dbTimestamptz,
  })
  .describe("portfolio_broker_snapshots row");

/** The table's name from `sqlite_schema`: NULL when the table is missing. */
export const regclassRowSchema = z
  .object({ relation: z.string().nullable() })
  .describe("regclass row");

/** Broker snapshot account names: `COALESCE(NULLIF(display_name,''), name)`. */
export const accountDisplayNameRowSchema = z
  .object({ id: dbAccountId, display_name: z.string() })
  .describe("account display name row");

/** `portfolioSummaryService`'s archived in-kind income read. */
export const archivedIncomeDbRowSchema = z
  .object({
    investment_id: dbInvestmentId,
    /** NUMERIC NOT NULL */
    amount: dbNumeric,
    currency: dbCurrency,
    date: dbDayString,
    fx_rate_to_eur: dbNumeric.nullable(),
  })
  .describe("archived income row");

/**
 * `getBrokerageCashFees`: source-owned brokerage cash fees. Both CTE branches
 * join on `account_id` equality, so it is never NULL here.
 */
export const brokerageCashFeeRowSchema = z
  .object({
    id: dbTransactionId,
    account_id: dbAccountId,
    date: dbDayString,
    currency: dbCurrency,
    /** `dec_neg(t.amount)` */
    amount: z.string(),
  })
  .describe("brokerage cash fee row");

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

/** `exchange_rates` with `rate_date` formatted as 'YYYY-MM-DD'. */
export const historicalRateRowSchema = fxRateRowSchema
  .extend({ rate_date: dbDayString })
  .describe("historical rate row");

/** `listLatestStoredRates`. */
export const latestStoredRateRowSchema = fxRateRowSchema
  .extend({ rate_date: dbDate, fetched_at: dbTimestamptz })
  .describe("latest stored rate row");

/** A distinct (currency, transaction day) pair; `rate_date` is a DATE. */
export const currencyDatePairRowSchema = z
  .object({ currency_code: z.string(), rate_date: dbDate })
  .describe("currency date pair row");

/** `rate_date` as text, an existence check. */
export const currencyDayKeyRowSchema = z
  .object({ currency_code: z.string(), rate_date: dbDayString })
  .describe("currency day key row");

// ---------------------------------------------------------------------------
// Derived row types
// ---------------------------------------------------------------------------

export type PortfolioTransactionDbRow = z.output<
  typeof portfolioTransactionDbRowSchema
>;
export type PortfolioUnitEventDbRow = z.output<
  typeof portfolioUnitEventRowSchema
>;
export type PortfolioMathTxDbRow = z.output<typeof portfolioMathTxRowSchema>;
export type IncomeRecognitionJournalDbRow = z.output<
  typeof incomeRecognitionJournalRowSchema
>;
export type RetagTransactionEventDbRow = z.output<
  typeof retagTransactionEventRowSchema
>;
export type RetagDestinationAccountRow = z.output<
  typeof retagDestinationAccountRowSchema
>;
export type RetagLockedTransactionRow = z.output<
  typeof retagLockedTransactionRowSchema
>;
export type EligibleYieldSourceDbRow = z.output<
  typeof eligibleYieldSourceRowSchema
>;
export type PortfolioAssetAdjustmentDbRow = z.output<
  typeof portfolioAssetAdjustmentRowSchema
>;
export type PortfolioAssetTransferDbRow = z.output<
  typeof portfolioAssetTransferRowSchema
>;
export type ExposureClassificationDbRow = z.output<
  typeof exposureClassificationRowSchema
>;
export type FundHoldingsDocumentDbRow = z.output<
  typeof fundHoldingsDocumentRowSchema
>;
export type InvestmentDbRow = z.output<typeof investmentDbRowSchema>;
export type SummaryInvestmentDbRow = z.output<
  typeof summaryInvestmentDbRowSchema
>;
export type ProviderHealthDbRow = z.output<typeof providerHealthRowSchema>;
export type ProviderApiKeyDbRow = z.output<typeof providerApiKeyRowSchema>;
export type HoldingWindowDbRow = z.output<typeof holdingWindowRowSchema>;
export type FxRateDbRow = z.output<typeof fxRateRowSchema>;
export type SnapshotFxHistoryDbRow = z.output<
  typeof snapshotFxHistoryRowSchema
>;
export type PortfolioPerformanceSnapshotDbRow = z.output<
  typeof portfolioPerformanceSnapshotRowSchema
>;
export type ArchivedIncomeDbRow = z.output<typeof archivedIncomeDbRowSchema>;
export type HistoricalRateDbRow = z.output<typeof historicalRateRowSchema>;
export type LatestStoredRateDbRow = z.output<typeof latestStoredRateRowSchema>;
