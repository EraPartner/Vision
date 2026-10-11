/**
 * Row schemas for the portfolio (non-import), investment, price and currency
 * queries (ADR-193).
 *
 * Same rules as `../rowSchemas.ts`: each schema describes what node-postgres
 * returns with its DEFAULT parsers (NUMERIC/BIGINT/`COUNT(*)` as strings,
 * DATE/TIMESTAMPTZ as `Date`, INTEGER as number, JSON parsed), only checks (no
 * transforms or coercion), and stays a plain `z.object` so `SELECT *` keeps
 * working when a migration adds a column. `.nullable()` marks SQL NULL;
 * `.optional()` marks a column only some projections select.
 *
 * Column types were checked against the real schema (information_schema and
 * `\gdesc`). Two easy-to-miss facts:
 *   - a `UNION ALL` of an INTEGER id with a BIGINT id is BIGINT, so the unit
 *     event and portfolio-math reads emit `id` as a string;
 *   - `SELECT t.*, to_char(t.date, ...) AS date` returns two `date` fields and
 *     node-postgres keeps the LAST one, so `date` is the formatted string.
 */
import { z } from "zod";
import type { FundHoldingsDocument } from "@vision/types/fund-holdings";
import {
  pgBigint,
  pgDate,
  pgDayString,
  pgInt,
  pgNumeric,
  pgTimestamptz,
} from "../rowSchemas.ts";

// ---------------------------------------------------------------------------
// Small shared projections
// ---------------------------------------------------------------------------

/** `RETURNING id` / `SELECT id` over an INTEGER/SERIAL key. */
export const portfolioIntIdRowSchema = z
  .object({ id: pgInt })
  .describe("portfolio int id row");

/** `RETURNING id` over a BIGINT/BIGSERIAL key. */
export const portfolioBigintIdRowSchema = z
  .object({ id: pgBigint })
  .describe("portfolio bigint id row");

/** `SELECT EXISTS (...) AS present`: EXISTS is never NULL. */
export const presentRowSchema = z
  .object({ present: z.boolean() })
  .describe("present row");

/** `SELECT id,is_active,type FROM accounts ... FOR UPDATE` (custody writes). */
export const custodyAccountLockRowSchema = z
  .object({
    id: pgInt,
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
    id: pgInt,
    investment_id: pgInt,
    /** `portfolio_txn_type` enum. */
    type: z.string(),
    date: pgDate,
    /** NUMERIC(18,4) NOT NULL */
    amount: pgNumeric,
    units: pgNumeric.nullable(),
    price_per_unit: pgNumeric.nullable(),
    fees: pgNumeric.nullable(),
    taxes: pgNumeric.nullable(),
    currency: z.string(),
    fx_rate_to_eur: pgNumeric.nullable(),
    note: z.string().nullable(),
    is_recurring: z.boolean(),
    recurrence_interval: z.string().nullable(),
    recurrence_end_date: pgDate.nullable(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
    account_id: pgInt.nullable(),
    /**
     * BIGINT FK (migration 0086). Optional because the repository still
     * probes for the column (`hasPortfolioTransactionImportBatchIdColumn`).
     */
    import_batch_id: pgBigint.nullable().optional(),
    dividend_amount_convention: z.enum(["gross", "net", "unknown"]),
    source_record_hash: z.string().nullable(),
    dedup_fingerprint: z.string().nullable(),
    dedup_fingerprint_version: pgInt.nullable(),
    income_recognition_role: incomeRecognitionRoleSchema,
  })
  .describe("portfolio_transactions row");

/** `getAllWithCount`: the raw row plus the window `COUNT(*) OVER ()`. */
export const portfolioTransactionCountedRowSchema =
  portfolioTransactionDbRowSchema
    .extend({ total_count: pgBigint })
    .describe("portfolio_transactions counted row");

/** `getUnitEventIdsForImportBatch`. */
export const portfolioTransactionIdPairRowSchema = z
  .object({ id: pgInt, investment_id: pgInt })
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
 * adjustments in one UNION, so ids widen to BIGINT and the numeric columns
 * to NUMERIC.
 */
export const portfolioUnitEventRowSchema = z
  .object({
    id: pgBigint,
    type: z.string(),
    date: pgDayString,
    /** `COALESCE(units, 0)` on the transaction leg. */
    units: pgNumeric,
    account_id: pgInt.nullable(),
    amount: pgNumeric,
    /** Raw nullable `fees` on the transaction leg. */
    fees: pgNumeric.nullable(),
    taxes: pgNumeric.nullable(),
    /** NULL when a non-EUR transaction has neither a stamped nor a stored rate. */
    fxMultiplier: pgNumeric.nullable(),
    source_account_id: pgInt.nullable(),
    destination_account_id: pgInt.nullable(),
    fee_units: pgNumeric,
    transfer_id: pgBigint.nullable(),
    currency: z.string().nullable(),
    source_record_hash: z.string().nullable(),
    adjustment_kind: z.enum(["yield_reversal", "asset_fee"]).nullable(),
    basis_policy: z.enum(["zero_yield_only", "carried"]).nullable(),
    eligible_source_record_hashes: z.array(z.string()).nullable(),
    adjustment_id: pgBigint.nullable(),
    income_recognition_role: incomeRecognitionRoleSchema,
  })
  .describe("portfolio unit event row");

/**
 * `getRowsForPortfolioMath`: the same three-way UNION for the math paths,
 * NUMERIC columns COALESCEd to 0 except `fx_rate_to_eur`.
 */
export const portfolioMathTxRowSchema = z
  .object({
    /** BIGINT: the UNION widens the INTEGER transaction id. */
    id: pgBigint,
    investment_id: pgInt,
    type: z.string(),
    amount: pgNumeric,
    units: pgNumeric,
    fees: pgNumeric,
    taxes: pgNumeric,
    date: pgDayString,
    /** Same value as `date`, second alias. */
    day: pgDayString,
    currency: z.string(),
    fx_rate_to_eur: pgNumeric.nullable(),
    account_id: pgInt.nullable(),
    /** Custody event origin; NULL on transaction and adjustment legs. */
    source_account_id: pgInt.nullable(),
    destination_account_id: pgInt.nullable(),
    fee_units: pgNumeric,
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
    total_amount: pgNumeric,
    total_units: pgNumeric.nullable(),
    total_fees: pgNumeric.nullable(),
    total_taxes: pgNumeric.nullable(),
    /** Bare COUNT(*) */
    count: pgBigint,
  })
  .describe("portfolio transaction summary row");

/** The jsonb `portfolio_income_transaction_snapshot(pt)` returns. */
export const portfolioTransactionSnapshotSchema = z.object({
  id: z.number(),
  investment_id: z.number(),
  type: z.string(),
  date: z.string(),
  amount: z.string().nullable(),
  units: z.string().nullable(),
  price_per_unit: z.string().nullable(),
  fees: z.string().nullable(),
  taxes: z.string().nullable(),
  currency: z.string().nullable(),
  fx_rate_to_eur: z.string().nullable(),
  account_id: z.number().nullable(),
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

/** `SELECT portfolio_income_transaction_snapshot(pt) AS snapshot`. */
export const portfolioTransactionSnapshotRowSchema = z
  .object({ snapshot: portfolioTransactionSnapshotSchema })
  .describe("portfolio transaction snapshot row");

// ---------------------------------------------------------------------------
// Income recognition journal
// ---------------------------------------------------------------------------

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** A `portfolio_import_income_recognition_journal` row (`SELECT r.*`). */
export const incomeRecognitionJournalRowSchema = z
  .object({
    id: pgBigint,
    batch_id: pgBigint,
    staging_row_id: pgBigint,
    unit_staging_row_id: pgBigint,
    income_transaction_id: pgInt,
    unit_transaction_id: pgInt,
    action: z.enum(["record", "restore"]),
    previous_entry_id: pgBigint.nullable(),
    /** CHECK jsonb_typeof = 'object' */
    income_data: jsonObjectSchema,
    unit_data: jsonObjectSchema,
    proof_data: jsonObjectSchema,
    created_at: pgTimestamptz,
  })
  .describe("income recognition journal row");

/** `readPairedIncomeRollbackBatchIds`. */
export const batchIdRowSchema = z
  .object({ batch_id: pgBigint })
  .describe("batch id row");

// ---------------------------------------------------------------------------
// Broker re-tag
// ---------------------------------------------------------------------------

/** A `portfolio_retag_audit` row as the repository projects it. */
export const portfolioRetagAuditRowSchema = z
  .object({
    id: pgBigint,
    /** UUID */
    idempotency_key: z.string(),
    request_fingerprint: z.string(),
    from_account_id: pgInt.nullable(),
    to_account_id: pgInt.nullable(),
    /** jsonb array (CHECK jsonb_typeof = 'array') of transaction ids. */
    transaction_ids: z.array(z.number()),
    previous_assignments: z.array(
      z.object({
        transaction_id: z.number(),
        account_id: z.number().nullable(),
      }),
    ),
    selected_count: pgInt,
    changed_count: pgInt,
    created_at: pgTimestamptz,
  })
  .describe("portfolio_retag_audit row");

/** `insertAudit`'s RETURNING list adds a formatted UTC timestamp. */
export const portfolioRetagAuditInsertedRowSchema = portfolioRetagAuditRowSchema
  .extend({ occurred_at: z.string() })
  .describe("portfolio_retag_audit inserted row");

/** `lockEligibleDestinationAccount`. */
export const retagDestinationAccountRowSchema = z
  .object({
    id: pgInt,
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
    id: pgInt,
    investment_id: pgInt,
    account_id: pgInt.nullable(),
  })
  .describe("retag locked transaction row");

/** `getUnitEventsForInvestments`' transaction projection. */
export const retagTransactionEventRowSchema = z
  .object({
    id: pgInt,
    investment_id: pgInt,
    /** `portfolio_txn_type` enum. */
    type: z.string(),
    date: pgDayString,
    amount: pgNumeric,
    units: pgNumeric,
    fees: pgNumeric,
    taxes: pgNumeric,
    currency: z.string(),
    fx_rate_to_eur: pgNumeric.nullable(),
    /** NULL when a non-EUR row has neither a stamped nor a stored rate. */
    fx_multiplier_eur: pgNumeric.nullable(),
    account_id: pgInt.nullable(),
    /** `asset_class` enum. */
    asset_class: z.string(),
    current_price: pgNumeric,
    interest_rate: pgNumeric,
  })
  .describe("retag transaction event row");

// ---------------------------------------------------------------------------
// Asset adjustments and transfers
// ---------------------------------------------------------------------------

/** `getEligibleYieldSources`: MIN over a BIGINT staging id. */
export const eligibleYieldSourceRowSchema = z
  .object({
    source_record_hash: z.string(),
    staging_row_id: pgBigint,
  })
  .describe("eligible yield source row");

/** `portfolio_asset_adjustments` with `date` re-projected as 'YYYY-MM-DD'. */
export const portfolioAssetAdjustmentRowSchema = z
  .object({
    id: pgBigint,
    investment_id: pgInt,
    account_id: pgInt,
    date: pgDayString,
    units: pgNumeric,
    adjustment_kind: z.enum(["yield_reversal", "asset_fee"]),
    basis_policy: z.enum(["zero_yield_only", "carried"]),
    eligible_source_record_hashes: z.array(z.string()),
    /** jsonb object, DEFAULT '{}'. */
    basis_allocations: jsonObjectSchema,
    import_batch_id: pgBigint,
    staging_row_id: pgBigint,
    source_record_hash: z.string(),
    dedup_fingerprint: z.string(),
    dedup_fingerprint_version: pgInt,
    created_at: pgTimestamptz,
  })
  .describe("portfolio_asset_adjustments row");

/** `portfolio_asset_transfers` with `date` re-projected as 'YYYY-MM-DD'. */
export const portfolioAssetTransferRowSchema = z
  .object({
    id: pgBigint,
    investment_id: pgInt,
    source_account_id: pgInt,
    destination_account_id: pgInt,
    date: pgDayString,
    units: pgNumeric,
    fee_units: pgNumeric,
    /** jsonb object, DEFAULT '{}'. */
    fee_basis_allocations: jsonObjectSchema,
    import_batch_id: pgBigint,
    staging_row_id: pgBigint,
    source_record_hash: z.string(),
    dedup_fingerprint: z.string(),
    dedup_fingerprint_version: pgInt,
    created_at: pgTimestamptz,
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
    investmentId: pgInt.nullable(),
    identifierType: z.string().nullable(),
    identifierValue: z.string().nullable(),
    identifierExchange: z.string().nullable(),
    issuerId: z.string(),
    issuerName: z.string(),
    sector: z.string().nullable(),
    issuerCountryCode: z.string().nullable(),
    sourceLabel: z.string(),
    createdAt: pgTimestamptz,
    updatedAt: pgTimestamptz,
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
    investmentId: pgInt,
    shareClassIdentifier: z.object({
      type: z.string(),
      value: z.string(),
      exchange: z.string().nullable().optional(),
    }),
    document: storedFundHoldingsDocumentSchema,
    sourceAsOfDate: pgDate,
    sourceSha256: z.string(),
    createdAt: pgTimestamptz,
    updatedAt: pgTimestamptz,
  })
  .describe("fund holdings document row");

/** `listExposureTargets`. */
export const exposureTargetRowSchema = z
  .object({ id: pgInt, assetClass: z.string() })
  .describe("exposure target row");

// ---------------------------------------------------------------------------
// Investments
// ---------------------------------------------------------------------------

/** A raw `investments` row (`SELECT i.*` / `RETURNING *`). */
export const investmentDbRowSchema = z
  .object({
    id: pgInt,
    name: z.string(),
    symbol: z.string().nullable(),
    /** `asset_class` enum. */
    asset_class: z.string(),
    currency: z.string(),
    /** NUMERIC(18,6) */
    current_price: pgNumeric.nullable(),
    interest_rate: pgNumeric.nullable(),
    maturity_date: pgDate.nullable(),
    location: z.string().nullable(),
    municipality: z.string().nullable(),
    cadastral_income: pgNumeric.nullable(),
    municipality_tax_rate: pgNumeric.nullable(),
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
    price_updated_at: pgTimestamptz.nullable(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
    /** `COALESCE(tp.show_in_ticker, true)` on the joined reads only. */
    show_in_ticker: z.boolean().optional(),
  })
  .describe("investments row");

/** `getAllWithCount`: the joined row plus `COUNT(*) OVER ()`. */
export const investmentCountedDbRowSchema = investmentDbRowSchema
  .extend({ total_count: pgBigint })
  .describe("investments counted row");

/**
 * `portfolioSummaryService`'s `SELECT i.*` with `currency`, `current_price`
 * and `interest_rate` re-projected through COALESCE (non-null).
 */
export const summaryInvestmentDbRowSchema = investmentDbRowSchema
  .extend({ current_price: pgNumeric, interest_rate: pgNumeric })
  .describe("portfolio summary investments row");

/** `getLatestPriceUpdatedAt`: MAX over zero rows is NULL. */
export const latestPriceUpdatedAtRowSchema = z
  .object({ latest: pgTimestamptz.nullable() })
  .describe("latest price updated row");

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

/** A raw `watchlist` row (`SELECT *` / `RETURNING *`). */
export const watchlistRowSchema = z
  .object({
    id: pgInt,
    name: z.string(),
    symbol: z.string().nullable(),
    /** `asset_class` enum. */
    asset_class: z.string(),
    /** NUMERIC(18,6) */
    target_price: pgNumeric,
    currency: z.string(),
    notes: z.string().nullable(),
    price_provider_id: z.string().nullable(),
    /** NUMERIC(18,6); NULL on rows predating migration 0058. */
    added_price: pgNumeric.nullable(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("watchlist row");

/** `getAllWithCount`. */
export const watchlistCountedRowSchema = watchlistRowSchema
  .extend({ total_count: pgBigint })
  .describe("watchlist counted row");

// ---------------------------------------------------------------------------
// Research provider tables
// ---------------------------------------------------------------------------

/** `instrument_provider_map` (migration 0042), the full table. */
export const instrumentProviderMapRowSchema = z
  .object({
    id: pgInt,
    instrument_key: z.string(),
    key_type: z.enum(["isin", "internal"]),
    provider: z.string(),
    provider_symbol: z.string().nullable(),
    resolved_name: z.string().nullable(),
    exchange: z.string().nullable(),
    currency: z.string().nullable(),
    status: z.enum(["confirmed", "auto", "failed"]),
    verified_at: pgTimestamptz.nullable(),
    created_at: pgTimestamptz,
    updated_at: pgTimestamptz,
  })
  .describe("instrument_provider_map row");

/** `provider_health` (migration 0010). */
export const providerHealthRowSchema = z
  .object({
    provider: z.string(),
    kind: z.string(),
    last_success_at: pgTimestamptz.nullable(),
    last_error_at: pgTimestamptz.nullable(),
    last_error: z.string().nullable(),
    consecutive_failures: pgInt,
    updated_at: pgTimestamptz,
  })
  .describe("provider_health row");

/** `provider_quota.count` (INTEGER). */
export const providerQuotaCountRowSchema = z
  .object({ count: pgInt })
  .describe("provider quota count row");

/** `provider_api_keys` (migration 0043). */
export const providerApiKeyRowSchema = z
  .object({
    provider: z.string(),
    api_key: z.string(),
    updated_at: pgTimestamptz,
  })
  .describe("provider_api_keys row");

// ---------------------------------------------------------------------------
// Prices (asset_price_history) and quote backfill
// ---------------------------------------------------------------------------

/** A full `asset_price_history` row. */
export const assetPriceHistoryRowSchema = z
  .object({
    id: pgInt,
    investment_id: pgInt,
    price_date: pgDate,
    /** NUMERIC(18,6) */
    close_price: pgNumeric,
    source: z.string(),
    fetched_at: pgTimestamptz,
    updated_at: pgTimestamptz,
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

/** `quoteBackfillService`'s HOLDING_WINDOW_SELECT. */
export const holdingWindowRowSchema = z
  .object({
    id: pgInt,
    asset_class: z.string(),
    currency: z.string(),
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
    tx_id: pgInt,
    /** `portfolio_txn_type` enum, filtered to buy|gift|sell. */
    tx_type: z.string(),
    tx_date: pgDayString,
    /** `COALESCE(pt.units, 0)` */
    tx_units: pgNumeric,
  })
  .describe("holding window row");

/** `getStoredPriceDates`. */
export const storedPriceDateRowSchema = z
  .object({ d: pgDayString })
  .describe("stored price date row");

// ---------------------------------------------------------------------------
// Snapshot builder and performance snapshots
// ---------------------------------------------------------------------------

/** `getFirstDataDate`: MIN over zero rows is NULL. */
export const firstDataDateRowSchema = z
  .object({ first_data_date: pgDate.nullable() })
  .describe("first data date row");

/** The day walk's unit-priced investment seed. */
export const snapshotUnitInvestmentRowSchema = z
  .object({
    id: pgInt,
    currency: z.string(),
    /** `COALESCE(i.current_price, 0)` */
    current_price: pgNumeric,
    asset_class: z.string(),
  })
  .describe("snapshot unit investment row");

/** The day walk's savings/bond/real_estate seed. */
export const snapshotNonUnitInvestmentRowSchema =
  snapshotUnitInvestmentRowSchema
    .extend({
      /** `COALESCE(interest_rate, 0)` */
      interest_rate: pgNumeric,
      /** `COALESCE(created_at::date, $1::date)::text` */
      active_from: pgDayString,
    })
    .describe("snapshot non-unit investment row");

/** The day walk's price history. */
export const snapshotPriceHistoryRowSchema = z
  .object({
    investment_id: pgInt,
    day: pgDayString,
    close_price: pgNumeric,
  })
  .describe("snapshot price history row");

/** The day walk's Belgian inflation series. */
export const snapshotInflationRowSchema = z
  .object({
    /** 'YYYY-MM' */
    month: z.string(),
    /** NUMERIC(10,8) */
    monthly_rate: pgNumeric,
  })
  .describe("snapshot inflation row");

/** `exchange_rates` `currency_code, rate_to_eur` (latest or point reads). */
export const fxRateRowSchema = z
  .object({ currency_code: z.string(), rate_to_eur: pgNumeric })
  .describe("fx rate row");

/** A single `rate_to_eur` lookup. */
export const rateToEurRowSchema = z
  .object({ rate_to_eur: pgNumeric })
  .describe("rate to eur row");

/** The day walk's FX history (`to_char(rate_date) AS day`). */
export const snapshotFxHistoryRowSchema = fxRateRowSchema
  .extend({ day: pgDayString })
  .describe("snapshot fx history row");

/** `SELECT * FROM portfolio_performance_snapshots`. */
export const portfolioPerformanceSnapshotRowSchema = z
  .object({
    id: pgInt,
    snapshot_date: pgDate,
    invested: pgNumeric,
    value: pgNumeric,
    stocks_etfs_value: pgNumeric,
    crypto_value: pgNumeric,
    metals_value: pgNumeric,
    cash_value: pgNumeric,
    gain_loss: pgNumeric,
    return_pct: pgNumeric,
    inflation_adjusted_value: pgNumeric,
    cumulative_inflation: pgNumeric,
    real_return_pct: pgNumeric,
    stocks_etfs_invested: pgNumeric,
    crypto_invested: pgNumeric,
    metals_invested: pgNumeric,
    currency: z.string(),
    computed_at: pgTimestamptz,
    /** NUMERIC(18,2), migration 0039; absent on un-migrated databases. */
    value_fx_neutral: pgNumeric.nullable().optional(),
  })
  .describe("portfolio_performance_snapshots row");

/** `portfolio_broker_snapshots` as `getBrokerSnapshots` projects it. */
export const brokerSnapshotRowSchema = z
  .object({
    snapshot_date: pgDate,
    currency: z.string(),
    account_key: z.string(),
    account_id: pgInt.nullable(),
    account_name: z.string(),
    value: pgNumeric,
    invested: pgNumeric,
    gain_loss: pgNumeric,
    computed_at: pgTimestamptz,
  })
  .describe("portfolio_broker_snapshots row");

/** `to_regclass(...) AS relation`: NULL when the table is missing. */
export const regclassRowSchema = z
  .object({ relation: z.string().nullable() })
  .describe("regclass row");

/** Broker snapshot account names: `COALESCE(NULLIF(display_name,''), name)`. */
export const accountDisplayNameRowSchema = z
  .object({ id: pgInt, display_name: z.string() })
  .describe("account display name row");

/** `SELECT CURRENT_DATE::text AS today`. */
export const currentDateRowSchema = z
  .object({ today: pgDayString })
  .describe("current date row");

/** `portfolioSummaryService`'s archived in-kind income read. */
export const archivedIncomeDbRowSchema = z
  .object({
    investment_id: pgInt,
    /** NUMERIC NOT NULL */
    amount: pgNumeric,
    currency: z.string(),
    date: pgDayString,
    fx_rate_to_eur: pgNumeric.nullable(),
  })
  .describe("archived income row");

/**
 * `getBrokerageCashFees`: source-owned brokerage cash fees. Both CTE branches
 * join on `account_id` equality, so it is never NULL here.
 */
export const brokerageCashFeeRowSchema = z
  .object({
    id: pgInt,
    account_id: pgInt,
    date: pgDayString,
    currency: z.string(),
    /** `(-t.amount)::text` */
    amount: z.string(),
  })
  .describe("brokerage cash fee row");

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

/** `exchange_rates` with `rate_date` formatted as 'YYYY-MM-DD'. */
export const historicalRateRowSchema = fxRateRowSchema
  .extend({ rate_date: pgDayString })
  .describe("historical rate row");

/** `listLatestStoredRates`. */
export const latestStoredRateRowSchema = fxRateRowSchema
  .extend({ rate_date: pgDate, fetched_at: pgTimestamptz })
  .describe("latest stored rate row");

/** A distinct (currency, transaction day) pair; `rate_date` is a pg DATE. */
export const currencyDatePairRowSchema = z
  .object({ currency_code: z.string(), rate_date: pgDate })
  .describe("currency date pair row");

/** `rate_date::text` existence check. */
export const currencyDayKeyRowSchema = z
  .object({ currency_code: z.string(), rate_date: pgDayString })
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
export type PortfolioTransactionSnapshotDb = z.output<
  typeof portfolioTransactionSnapshotSchema
>;
export type IncomeRecognitionJournalDbRow = z.output<
  typeof incomeRecognitionJournalRowSchema
>;
export type PortfolioRetagAuditDbRow = z.output<
  typeof portfolioRetagAuditRowSchema
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
export type WatchlistDbRow = z.output<typeof watchlistRowSchema>;
export type InstrumentProviderMapDbRow = z.output<
  typeof instrumentProviderMapRowSchema
>;
export type ProviderHealthDbRow = z.output<typeof providerHealthRowSchema>;
export type ProviderApiKeyDbRow = z.output<typeof providerApiKeyRowSchema>;
export type AssetPriceHistoryDbRow = z.output<
  typeof assetPriceHistoryRowSchema
>;
export type HoldingWindowDbRow = z.output<typeof holdingWindowRowSchema>;
export type SnapshotUnitInvestmentDbRow = z.output<
  typeof snapshotUnitInvestmentRowSchema
>;
export type SnapshotNonUnitInvestmentDbRow = z.output<
  typeof snapshotNonUnitInvestmentRowSchema
>;
export type SnapshotPriceHistoryDbRow = z.output<
  typeof snapshotPriceHistoryRowSchema
>;
export type SnapshotInflationDbRow = z.output<
  typeof snapshotInflationRowSchema
>;
export type FxRateDbRow = z.output<typeof fxRateRowSchema>;
export type SnapshotFxHistoryDbRow = z.output<
  typeof snapshotFxHistoryRowSchema
>;
export type PortfolioPerformanceSnapshotDbRow = z.output<
  typeof portfolioPerformanceSnapshotRowSchema
>;
export type BrokerSnapshotDbRow = z.output<typeof brokerSnapshotRowSchema>;
export type ArchivedIncomeDbRow = z.output<typeof archivedIncomeDbRowSchema>;
export type HistoricalRateDbRow = z.output<typeof historicalRateRowSchema>;
export type LatestStoredRateDbRow = z.output<typeof latestStoredRateRowSchema>;
export type CurrencyDatePairDbRow = z.output<typeof currencyDatePairRowSchema>;
