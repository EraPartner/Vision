/**
 * Row schemas for the portfolio import pipeline, its review, reconciliation,
 * cash and duplicate-repair repositories (ADR-193).
 *
 * Same rules as `../rowSchemas.ts`: each schema describes what node-postgres
 * returns with its DEFAULT parsers (NUMERIC/BIGINT/`COUNT(*)` as strings,
 * DATE/TIMESTAMPTZ as `Date`, INTEGER as number, JSON parsed), only checks (no
 * transforms or coercion), and stays a plain `z.object` so `s.*` keeps working
 * when a migration adds a column. Column types were checked against the
 * migrated schema (information_schema, CHECK constraints and `\gdesc`).
 *
 * JSON payloads come in two kinds:
 *   - snapshots that SQL builds on every read (`jsonb_build_object`,
 *     `to_jsonb(s)`, `portfolio_income_transaction_snapshot`) are checked
 *     field by field: their shape is fixed by the SQL text next to the query;
 *   - adapter-specific JSON that Vision stored earlier (`custom_config`,
 *     `asset_transfer_details`, `asset_adjustment_details`, journal
 *     `before_data`/`after_data`) is checked as a JSON object only. Its static
 *     type names the fields the services read; old batches keep whatever keys
 *     their adapter version wrote, so a deep runtime check would block a valid
 *     historical import.
 */
import { z } from "zod";
import {
  pgBigint,
  pgDate,
  pgDayString,
  pgInt,
  pgNumeric,
  pgTimestamptz,
} from "../rowSchemas.ts";
import {
  portfolioAssetAdjustmentRowSchema,
  portfolioAssetTransferRowSchema,
  portfolioTransactionSnapshotSchema,
} from "./portfolio.ts";
import type { PortfolioParserConfig } from "../../services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import type { IbkrFundingSourceContext } from "../../services/portfolioImportPipeline/ibkrFundingHistoryAdapter.ts";
import type { IbkrSourceContext } from "../../services/portfolioIbkrPrimaryProof.ts";
import type { KinesisSourceContext } from "../../services/portfolioKinesisAdoptionScope.ts";
import type {
  KinesisNetworkBinding,
  KinesisNetworkReceipt,
  NativeGiftGroupReceipt,
} from "../../services/portfolioKinesisNetworkProof.ts";
import type { KinesisYieldGroupEvidence } from "../../services/portfolioKinesisYieldGroups.ts";
import type { IbkrCashEnvelope } from "../../repositories/portfolioImportCashRepository.ts";

// ---------------------------------------------------------------------------
// Stored JSON payloads
// ---------------------------------------------------------------------------

/** A parsed JSON object (not an array, not null). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored JSON object whose keys a writer elsewhere in Vision owns. Checked
 * as an object; `T` names the fields its readers rely on.
 */
function storedJsonObject<T extends object>(label: string) {
  return z.custom<T>(isJsonObject, { message: `expected ${label} object` });
}

/** One `routing` entry of a performance reference (per effective batch). */
export type PortfolioPerformanceReferenceRouting = {
  batchId: number;
  accountId: number;
  originAccountId?: number | null;
  destinationAccountId?: number | null;
};

/** A blocker a performance reference recorded against its own batch. */
export type PortfolioPerformanceReferenceBlocker = {
  reason: string;
  batchId?: number;
  rowOrdinal?: number;
};

/** `custom_config.portfolio_performance_reference`. */
export type PortfolioPerformanceReferenceConfig = {
  effectiveBatchIds: number[];
  stagingBinding: string;
  originalStagingBinding?: string;
  sourceHash?: string;
  /** e.g. 'adopt_existing_only' | 'correct_existing_only' */
  reconciliationScope?: string;
  originalBatchIds?: number[];
  routing?: PortfolioPerformanceReferenceRouting[];
  yieldGroupEvidence?: KinesisYieldGroupEvidence;
};

/**
 * `portfolio_import_batches.custom_config`: the parser definition the batch
 * ran on plus the keys stage and review add to it. Unknown keys stay readable
 * as `unknown`.
 */
export type PortfolioImportBatchConfig = PortfolioParserConfig & {
  /** stage: the statement's literal column names. */
  source_columns?: string[];
  /** stage: records left outside an `included_symbols` scope. */
  scope_excluded_rows?: number;
  kinesis_source_context?: KinesisSourceContext;
  ibkr_source_context?: IbkrSourceContext;
  ibkr_funding_source_context?: IbkrFundingSourceContext;
  portfolio_performance_reference?: PortfolioPerformanceReferenceConfig;
  reference_blockers?: PortfolioPerformanceReferenceBlocker[];
  [key: string]: unknown;
};

/** The object form of `custom_config` that stage writes. */
export const portfolioImportBatchConfigSchema =
  storedJsonObject<PortfolioImportBatchConfig>("batch config");

/**
 * `custom_config` as a column read returns it. Stage writes an object, but
 * the readers still accept a JSON string (they parse it, or treat it as a
 * config without keys), so the check accepts one too: a check tighter than the
 * readers would turn tolerated data into a 500. NULL is handled per column.
 */
export const storedBatchConfigSchema = z.union([
  portfolioImportBatchConfigSchema,
  z.string(),
]);
export type StoredPortfolioImportBatchConfig = z.output<
  typeof storedBatchConfigSchema
>;

/**
 * The fields a reader can see on a stored config: the object itself, no
 * fields for a JSON string (reading a key of a string gave undefined), and
 * undefined for NULL. Readers that parse the text keep doing so themselves.
 */
export function batchConfigFields(
  config: StoredPortfolioImportBatchConfig | null | undefined,
): PortfolioImportBatchConfig | undefined {
  if (config == null) return undefined;
  return typeof config === "string" ? {} : config;
}

/**
 * `portfolio_import_staging_rows.asset_transfer_details` (JSON): stage writes
 * `ParsedPortfolioRow.assetTransfer`; review retains a network binding or a
 * native gift receipt on it.
 */
export type StagedAssetTransferDetails = {
  direction?: string;
  basisStatus?: string;
  feeUnits?: string;
  receivedUnits?: string;
  networkReceipt?: KinesisNetworkReceipt;
  networkBinding?: KinesisNetworkBinding;
  nativeGiftGroupReceipt?: NativeGiftGroupReceipt;
  [key: string]: unknown;
};

/** `portfolio_import_staging_rows.asset_adjustment_details` (JSON). */
export type StagedAssetAdjustmentDetails = {
  kind?: string;
  basisPolicy?: string;
  accountId?: number;
  eligibleSourceRecordHashes?: string[];
  networkReceipt?: KinesisNetworkReceipt;
  [key: string]: unknown;
};

export const stagedAssetTransferDetailsSchema =
  storedJsonObject<StagedAssetTransferDetails>("asset transfer details");
export const stagedAssetAdjustmentDetailsSchema =
  storedJsonObject<StagedAssetAdjustmentDetails>("asset adjustment details");

// ---------------------------------------------------------------------------
// portfolio_import_batches
// ---------------------------------------------------------------------------

/** CHECK portfolio_import_batches_status_check. */
const batchStatusSchema = z.enum([
  "pending",
  "staging",
  "validating",
  "matching",
  "awaiting_review",
  "committing",
  "complete",
  "complete_with_errors",
  "failed",
  "aborted",
]);

/**
 * A row of `portfolio_import_batches` (migration 0040; `account_id` added by
 * 0057, `is_brokerage` by 0060, the 'complete_with_errors' status by 0081).
 */
export const portfolioImportBatchRowSchema = z
  .object({
    id: pgBigint,
    adapter_name: z.string(),
    source_filename: z.string().nullable(),
    source_size_bytes: pgBigint.nullable(),
    custom_config: storedBatchConfigSchema.nullable(),
    /** `asset_class` enum. */
    default_asset_class: z.string().nullable(),
    /** `portfolio_txn_type` enum. */
    default_type: z.string().nullable(),
    status: batchStatusSchema,
    rows_total: pgInt,
    rows_imported: pgInt,
    rows_duplicate: pgInt,
    rows_error: pgInt,
    error_summary: z.string().nullable(),
    started_at: pgTimestamptz,
    completed_at: pgTimestamptz.nullable(),
    account_id: pgInt.nullable(),
    is_brokerage: z.boolean(),
  })
  .describe("portfolio_import_batches row");
export type PortfolioImportBatchRow = z.output<
  typeof portfolioImportBatchRowSchema
>;

/** `BATCH_COLUMNS` of the review/history list and detail reads. */
export const portfolioImportBatchSummaryRowSchema =
  portfolioImportBatchRowSchema
    .pick({
      id: true,
      adapter_name: true,
      source_filename: true,
      source_size_bytes: true,
      default_asset_class: true,
      default_type: true,
      status: true,
      account_id: true,
      rows_total: true,
      rows_imported: true,
      rows_duplicate: true,
      rows_error: true,
      error_summary: true,
      started_at: true,
      completed_at: true,
    })
    .describe("portfolio import batch summary row");
export type PortfolioImportBatchSummaryRow = z.output<
  typeof portfolioImportBatchSummaryRowSchema
>;

/** `lockBatchForUpdate`. */
export const portfolioImportBatchLockRowSchema = portfolioImportBatchRowSchema
  .pick({
    status: true,
    is_brokerage: true,
    adapter_name: true,
    custom_config: true,
    account_id: true,
  })
  .describe("portfolio import batch lock row");
export type PortfolioImportBatchLockRow = z.output<
  typeof portfolioImportBatchLockRowSchema
>;

/** `SELECT COUNT(*)::int AS total`. */
export const intTotalRowSchema = z
  .object({ total: pgInt })
  .describe("portfolio import total row");

/** `finalizeAdoptionOnlyBatch`'s `RETURNING id,status` (id is BIGINT). */
export const batchIdStatusRowSchema = portfolioImportBatchRowSchema
  .pick({ id: true, status: true })
  .describe("portfolio import batch id/status row");

/** `SELECT is_brokerage` (pipeline review gate). */
export const batchBrokerageRowSchema = portfolioImportBatchRowSchema
  .pick({ is_brokerage: true })
  .describe("portfolio import batch brokerage row");

/** The scope columns reconciliation reads for a set of batches. */
export const reconciliationBatchScopeRowSchema = portfolioImportBatchRowSchema
  .pick({
    id: true,
    account_id: true,
    status: true,
    custom_config: true,
    adapter_name: true,
    rows_total: true,
  })
  .describe("reconciliation batch scope row");
export type ReconciliationBatchScopeRow = z.output<
  typeof reconciliationBatchScopeRowSchema
>;

/** Commit's batch read: the scope plus the brokerage flag and broker label. */
export const commitBatchRowSchema = reconciliationBatchScopeRowSchema
  .extend({
    is_brokerage: z.boolean(),
    /** LEFT JOIN accounts */
    account_institution: z.string().nullable(),
    account_name: z.string().nullable(),
  })
  .describe("portfolio import commit batch row");
export type CommitBatchRow = z.output<typeof commitBatchRowSchema>;

/** Validate's batch read, joined to the account's import identity. */
export const validateBatchRowSchema = portfolioImportBatchRowSchema
  .pick({
    default_asset_class: true,
    default_type: true,
    custom_config: true,
    is_brokerage: true,
    adapter_name: true,
  })
  .extend({
    /** `a.import_identity::text` over a LEFT JOIN (NULL without an account). */
    account_import_identity: z.string().nullable(),
  })
  .describe("portfolio import validate batch row");
export type ValidateBatchRow = z.output<typeof validateBatchRowSchema>;

/** `SELECT DISTINCT b.account_id` (only batches with an account match). */
export const batchAccountIdRowSchema = z
  .object({ account_id: pgInt })
  .describe("portfolio import batch account row");

/** `SELECT DISTINCT batch_id` / `SELECT id` over portfolio import batches. */
export const batchIdOnlyRowSchema = z
  .object({ batch_id: pgBigint })
  .describe("portfolio import batch_id row");

// ---------------------------------------------------------------------------
// portfolio_import_staging_rows
// ---------------------------------------------------------------------------

/** CHECK portfolio_import_staging_rows_status_check. */
const stagingStatusSchema = z.enum([
  "pending",
  "validated",
  "matched",
  "committed",
  "duplicate",
  "error",
]);

/** CHECK chk_portfolio_import_staging_rows_route. */
const stagingRouteSchema = z.enum([
  "cash",
  "portfolio",
  "asset_transfer",
  "asset_adjustment",
  "account_internal",
]);

/**
 * A row of `portfolio_import_staging_rows` selected raw (migration 0040;
 * `route` added by 0060). Every parsed field is nullable: STAGE writes what
 * the adapter produced and VALIDATE rejects rows. `tx_date` is a DATE, so a
 * raw select hands back a local-midnight `Date`; `match_similarity` is REAL,
 * so a number. Columns marked optional are not selected by every projection.
 */
export const portfolioImportStagingRowSchema = z
  .object({
    id: pgBigint,
    batch_id: pgBigint,
    row_index: pgInt,
    status: stagingStatusSchema,
    tx_date: pgDate.nullable(),
    /** the CSV's own type label, pre-normalization */
    type_raw: z.string().nullable(),
    /** `portfolio_txn_type` enum, stamped by VALIDATE */
    type: z.string().nullable(),
    symbol_raw: z.string().nullable(),
    name_raw: z.string().nullable(),
    units: pgNumeric.nullable(),
    price_per_unit: pgNumeric.nullable(),
    amount: pgNumeric.nullable(),
    fees: pgNumeric.nullable(),
    taxes: pgNumeric.nullable(),
    currency: z.string().nullable(),
    fx_rate_to_eur: pgNumeric.nullable(),
    note: z.string().nullable(),
    raw_data: z.string().nullable(),
    source_transaction_id: z.string().nullable().optional(),
    source_account_identity: z.string().nullable().optional(),
    source_record_hash: z.string().nullable().optional(),
    dedup_fingerprint: z.string().nullable().optional(),
    /** SMALLINT */
    dedup_fingerprint_version: pgInt.nullable().optional(),
    dedup_occurrence: pgInt.nullable().optional(),
    resolved_investment_id: pgInt.nullable(),
    user_override_investment_id: pgInt.nullable(),
    match_source: z.enum(["symbol", "name_exact"]).nullable(),
    /** REAL: a number, not a string. */
    match_similarity: z.number().nullable(),
    /** A `transactions.id` on a cash row, else a portfolio transaction id. */
    committed_txn_id: pgInt.nullable(),
    error_message: z.string().nullable(),
    route: stagingRouteSchema.nullable().optional(),
    asset_transfer_details: stagedAssetTransferDetailsSchema
      .nullable()
      .optional(),
    asset_adjustment_details: stagedAssetAdjustmentDetailsSchema
      .nullable()
      .optional(),
    created_at: pgTimestamptz,
  })
  .describe("portfolio_import_staging_rows row");
export type PortfolioImportStagingRow = z.output<
  typeof portfolioImportStagingRowSchema
>;

/** Review preview: staging rows joined to their effective investment. */
export const portfolioImportPreviewRowSchema = z
  .object({
    id: pgBigint,
    row_index: pgInt,
    status: z.string(),
    route: z.string().nullable(),
    /** `to_char(tx_date, 'YYYY-MM-DD')` */
    tx_date: pgDayString.nullable(),
    type: z.string().nullable(),
    type_raw: z.string().nullable(),
    symbol_raw: z.string().nullable(),
    name_raw: z.string().nullable(),
    units: pgNumeric.nullable(),
    price_per_unit: pgNumeric.nullable(),
    amount: pgNumeric.nullable(),
    fees: pgNumeric.nullable(),
    taxes: pgNumeric.nullable(),
    currency: z.string().nullable(),
    fx_rate_to_eur: pgNumeric.nullable(),
    note: z.string().nullable(),
    match_source: z.string().nullable(),
    error_message: z.string().nullable(),
    resolved_investment_id: pgInt.nullable(),
    user_override_investment_id: pgInt.nullable(),
    effective_investment_id: pgInt.nullable(),
    /** LEFT JOIN investments */
    investment_name: z.string().nullable(),
    investment_symbol: z.string().nullable(),
    investment_asset_class: z.string().nullable(),
  })
  .describe("portfolio import preview row");
export type PortfolioImportPreviewRow = z.output<
  typeof portfolioImportPreviewRowSchema
>;

/** `SELECT row_index` (readiness and manual-overlap problems). */
export const stagingRowIndexRowSchema = z
  .object({ row_index: pgInt })
  .describe("portfolio import row_index row");

/** `overrideInvestment`'s pre-update status. */
export const stagingOldStatusRowSchema = z
  .object({ old_status: z.string() })
  .describe("portfolio import old status row");

/** `lockInvestmentResolutionRows`. */
export const investmentResolutionRowSchema = z
  .object({
    id: pgBigint,
    status: z.string(),
    route: z.string().nullable(),
    error_message: z.string().nullable(),
    user_override_investment_id: pgInt.nullable(),
  })
  .describe("portfolio import investment resolution row");
export type InvestmentResolutionRow = z.output<
  typeof investmentResolutionRowSchema
>;

/** `overrideInvestments`' counts: every column is cast `::int`. */
export const overrideInvestmentsSummaryRowSchema = z
  .object({
    requested_count: pgInt,
    eligible_count: pgInt,
    updated_count: pgInt,
    reset_error_count: pgInt,
  })
  .describe("portfolio import override summary row");

/** `getRowForInvestmentCreation`. */
export const investmentCreationRowSchema = z
  .object({
    symbol_raw: z.string().nullable(),
    name_raw: z.string().nullable(),
    currency: z.string().nullable(),
    default_asset_class: z.string().nullable(),
    custom_config: storedBatchConfigSchema.nullable(),
  })
  .describe("portfolio import investment creation row");
export type InvestmentCreationRow = z.output<
  typeof investmentCreationRowSchema
>;

/** `getCommittedRows`: `id` is `committed_txn_id` (INTEGER). */
export const committedStagingRowSchema = z
  .object({
    id: pgInt,
    route: z.string().nullable(),
    /** LEFT JOIN portfolio_transactions: NULL for cash rows. */
    investment_id: pgInt.nullable(),
  })
  .describe("portfolio import committed row");
export type CommittedStagingRow = z.output<typeof committedStagingRowSchema>;

/** Commit's drain projection (see `MatchedPortfolioStagingRow`). */
export const matchedPortfolioStagingRowSchema = portfolioImportStagingRowSchema
  .pick({
    id: true,
    status: true,
    type: true,
    type_raw: true,
    units: true,
    price_per_unit: true,
    amount: true,
    fees: true,
    taxes: true,
    currency: true,
    fx_rate_to_eur: true,
    note: true,
  })
  .extend({
    route: stagingRouteSchema.nullable(),
    source_record_hash: z.string().nullable(),
    source_transaction_id: z.string().nullable(),
    dedup_fingerprint: z.string().nullable(),
    dedup_fingerprint_version: pgInt.nullable(),
    dedup_occurrence: pgInt.nullable(),
    asset_transfer_details: stagedAssetTransferDetailsSchema.nullable(),
    asset_adjustment_details: stagedAssetAdjustmentDetailsSchema.nullable(),
    /** `to_char(tx_date, 'YYYY-MM-DD')` */
    tx_date: pgDayString.nullable(),
    /** COALESCE(user_override_investment_id, resolved_investment_id) */
    investment_id: pgInt.nullable(),
    /** LEFT JOIN investments */
    asset_class: z.string().nullable(),
    investment_currency: z.string().nullable(),
  })
  .describe("portfolio import matched staging row");
export type MatchedPortfolioStagingRow = z.output<
  typeof matchedPortfolioStagingRowSchema
>;

/**
 * Validate's pending-row read. `tx_date` is the raw DATE (a local-midnight
 * `Date`) except for IBKR funding batches, which project it as 'YYYY-MM-DD'.
 */
export const pendingPortfolioStagingRowSchema = portfolioImportStagingRowSchema
  .pick({
    id: true,
    row_index: true,
    status: true,
    type_raw: true,
    symbol_raw: true,
    name_raw: true,
    units: true,
    price_per_unit: true,
    amount: true,
    fees: true,
    taxes: true,
    currency: true,
    note: true,
    raw_data: true,
  })
  .extend({
    tx_date: z.union([pgDate, pgDayString]).nullable(),
    source_transaction_id: z.string().nullable(),
    source_account_identity: z.string().nullable(),
    asset_transfer_details: stagedAssetTransferDetailsSchema.nullable(),
    asset_adjustment_details: stagedAssetAdjustmentDetailsSchema.nullable(),
  })
  .describe("portfolio import pending staging row");
export type PendingPortfolioStagingDbRow = z.output<
  typeof pendingPortfolioStagingRowSchema
>;

/** Match's validated-row read. */
export const matchableStagingRowSchema = portfolioImportStagingRowSchema
  .pick({ id: true, symbol_raw: true, name_raw: true })
  .describe("portfolio import matchable row");

/** `SELECT LOWER(symbol|name) AS match_key, MIN(id) AS id, COUNT(*)::int`. */
export const investmentMatchKeyRowSchema = z
  .object({
    match_key: z.string(),
    /** MIN over INTEGER ids of a non-empty group. */
    id: pgInt,
    count: pgInt,
  })
  .describe("investment match key row");

/** Active crypto/Kinesis holdings the provider-alias match considers. */
export const aliasInvestmentRowSchema = z
  .object({
    id: pgInt,
    symbol: z.string().nullable(),
    name: z.string(),
    /** `asset_class` enum */
    asset_class: z.string(),
    /** `price_provider` enum */
    price_provider: z.string(),
    price_provider_id: z.string().nullable(),
  })
  .describe("alias investment row");

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * `readReconciliationSources`: `s.*` with `tx_date` re-projected as
 * 'YYYY-MM-DD' (node-postgres keeps the later duplicate column), joined to the
 * effective investment (LEFT JOIN) and the batch.
 */
export const reconciliationSourceRowSchema = portfolioImportStagingRowSchema
  .extend({
    tx_date: pgDayString.nullable(),
    route: z.string().nullable(),
    source_transaction_id: z.string().nullable(),
    source_account_identity: z.string().nullable(),
    source_record_hash: z.string().nullable(),
    dedup_fingerprint: z.string().nullable(),
    dedup_fingerprint_version: pgInt.nullable(),
    dedup_occurrence: pgInt.nullable(),
    asset_transfer_details: stagedAssetTransferDetailsSchema.nullable(),
    asset_adjustment_details: stagedAssetAdjustmentDetailsSchema.nullable(),
    investment_id: pgInt.nullable(),
    asset_class: z.string().nullable(),
    investment_currency: z.string().nullable(),
    account_id: pgInt.nullable(),
    custom_config: storedBatchConfigSchema.nullable(),
    adapter_name: z.string(),
    batch_status: z.string(),
  })
  .describe("reconciliation source row");
export type ReconciliationSourceRow = z.output<
  typeof reconciliationSourceRowSchema
>;

/**
 * The receipt shape of a portfolio transaction
 * (`portfolio_income_transaction_snapshot(pt)`): NUMERIC columns as exact
 * text, dates as 'YYYY-MM-DD'.
 */
export type PortfolioTransactionSnapshot = z.output<
  typeof portfolioTransactionSnapshotSchema
>;

/** `SELECT portfolio_income_transaction_snapshot(pt) AS snapshot`. */
export const reconciliationSnapshotRowSchema = z
  .object({ snapshot: portfolioTransactionSnapshotSchema })
  .describe("reconciliation transaction snapshot row");

/** `SELECT t.*, to_char(t.date, ...) AS date FROM portfolio_asset_transfers`. */
export const reconciliationTransferRowSchema = portfolioAssetTransferRowSchema;
/** `SELECT a.*, to_char(a.date, ...) AS date FROM portfolio_asset_adjustments`. */
export const reconciliationAdjustmentRowSchema =
  portfolioAssetAdjustmentRowSchema;

/** CHECK portfolio_import_reconciliation_journal_{action,policy}_check. */
const reconciliationActionSchema = z.enum(["adopt", "restore"]);
const reconciliationPolicySchema = z.enum([
  "exact",
  "preserve_existing",
  "prefer_source",
]);

/** Columns every `portfolio_import_reconciliation_journal` read shares. */
const reconciliationJournalBaseSchema = z.object({
  id: pgBigint,
  batch_id: pgBigint,
  staging_row_id: pgBigint,
  transaction_id: pgInt,
  action: reconciliationActionSchema,
  policy: reconciliationPolicySchema,
  previous_entry_id: pgBigint.nullable(),
  created_at: pgTimestamptz,
});

/**
 * A portfolio-ledger receipt (`SELECT a.*`). `before_data`/`after_data` are
 * the snapshots the adoption wrote (CHECK jsonb_typeof = 'object').
 */
export const reconciliationJournalRowSchema = reconciliationJournalBaseSchema
  .extend({
    before_data: storedJsonObject<PortfolioTransactionSnapshot>("receipt"),
    after_data: storedJsonObject<PortfolioTransactionSnapshot>("receipt"),
  })
  .describe("reconciliation journal row");
export type ReconciliationJournalRow = z.output<
  typeof reconciliationJournalRowSchema
>;

/** An IBKR cash-correction receipt (`after_data->>'ledgerKind' = 'cash'`). */
export const ibkrCashReceiptRowSchema = reconciliationJournalBaseSchema
  .extend({
    before_data: storedJsonObject<IbkrCashEnvelope>("cash receipt"),
    after_data: storedJsonObject<IbkrCashEnvelope>("cash receipt"),
  })
  .describe("ibkr cash receipt row");
export type IbkrCashReceipt = z.output<typeof ibkrCashReceiptRowSchema>;

/** `RETURNING id` over a BIGSERIAL key (journals, batches). */
export const bigintIdRowSchema = z
  .object({ id: pgBigint })
  .describe("portfolio import bigint id row");

/** `RETURNING id` / `SELECT ... AS id` over an INTEGER key. */
export const intIdRowSchema = z
  .object({ id: pgInt })
  .describe("portfolio import int id row");

// ---------------------------------------------------------------------------
// Cash ledger images
// ---------------------------------------------------------------------------

/**
 * CASH_SNAPSHOT_SQL: a full `transactions` after-image as jsonb (NUMERIC as
 * exact text, `date` as 'YYYY-MM-DD', BIGINT `import_batch_id` as a JSON
 * number).
 */
export const cashTransactionSnapshotSchema = z.object({
  id: z.number(),
  date: z.string(),
  amount: z.string(),
  currency: z.string(),
  memo: z.string().nullable(),
  comment: z.string().nullable(),
  balance: z.string().nullable(),
  account_id: z.number().nullable(),
  recipient_id: z.number(),
  recipient_bank_account_id: z.number().nullable(),
  category_id: z.number().nullable(),
  is_active: z.boolean(),
  import_batch_id: z.number().nullable(),
  source_record_hash: z.string().nullable(),
  dedup_fingerprint: z.string().nullable(),
  dedup_fingerprint_version: z.number().nullable(),
  is_transfer: z.boolean(),
  transfer_source: z.string().nullable(),
  transfer_peer_id: z.number().nullable(),
});
export type CashTransactionSnapshot = z.output<
  typeof cashTransactionSnapshotSchema
>;

export const cashSnapshotRowSchema = z
  .object({ snapshot: cashTransactionSnapshotSchema })
  .describe("cash transaction snapshot row");

/** IBKR_CASH_SNAPSHOT_SQL: the image without categorization and pairing. */
export const ibkrCashSnapshotSchema = cashTransactionSnapshotSchema.omit({
  category_id: true,
  is_transfer: true,
  transfer_source: true,
  transfer_peer_id: true,
});
export type IbkrCashSnapshot = z.output<typeof ibkrCashSnapshotSchema>;

export const ibkrCashSnapshotRowSchema = z
  .object({ snapshot: ibkrCashSnapshotSchema })
  .describe("ibkr cash snapshot row");

/** `to_jsonb(s)` of `account_statement_balances` (NUMERIC as a JSON number). */
export const statementBalanceSnapshotSchema = z.object({
  account_id: z.number(),
  currency: z.string(),
  balance: z.number(),
  /** DATE in JSON: 'YYYY-MM-DD' */
  balance_date: z.string(),
});
export type StatementBalanceSnapshot = z.output<
  typeof statementBalanceSnapshotSchema
>;

export const statementBalanceSnapshotRowSchema = z
  .object({ snapshot: statementBalanceSnapshotSchema })
  .describe("statement balance snapshot row");

/** `SELECT institution,name FROM accounts`. */
export const accountLabelRowSchema = z
  .object({ institution: z.string().nullable(), name: z.string() })
  .describe("portfolio import account label row");

// ---------------------------------------------------------------------------
// Duplicate repair
// ---------------------------------------------------------------------------

/** FULL_TRANSACTION: the reconciliation snapshot plus its timestamps as text. */
export const repairTransactionSnapshotSchema =
  portfolioTransactionSnapshotSchema.extend({
    created_at: z.string(),
    updated_at: z.string(),
  });
export type RepairTransactionSnapshot = z.output<
  typeof repairTransactionSnapshotSchema
>;

/** STAGING: `to_jsonb(s)` with BIGINT ids and NUMERIC columns as exact text. */
export const repairStagingSnapshotSchema = z.object({
  id: z.string(),
  batch_id: z.string(),
  row_index: z.number(),
  status: z.string(),
  /** DATE in JSON: 'YYYY-MM-DD' */
  tx_date: z.string().nullable(),
  type_raw: z.string().nullable(),
  type: z.string().nullable(),
  route: z.string().nullable(),
  symbol_raw: z.string().nullable(),
  name_raw: z.string().nullable(),
  units: z.string().nullable(),
  price_per_unit: z.string().nullable(),
  amount: z.string().nullable(),
  fees: z.string().nullable(),
  taxes: z.string().nullable(),
  currency: z.string().nullable(),
  fx_rate_to_eur: z.string().nullable(),
  note: z.string().nullable(),
  raw_data: z.string().nullable(),
  source_transaction_id: z.string().nullable(),
  source_account_identity: z.string().nullable(),
  source_record_hash: z.string().nullable(),
  dedup_fingerprint: z.string().nullable(),
  dedup_fingerprint_version: z.number().nullable(),
  dedup_occurrence: z.number().nullable(),
  resolved_investment_id: z.number().nullable(),
  user_override_investment_id: z.number().nullable(),
  match_source: z.string().nullable(),
  match_similarity: z.number().nullable(),
  committed_txn_id: z.number().nullable(),
  error_message: z.string().nullable(),
  asset_transfer_details: z.unknown(),
  asset_adjustment_details: z.unknown(),
  /** TIMESTAMPTZ in JSON: ISO text */
  created_at: z.string(),
  updated_at: z.string(),
});
export type RepairStagingSnapshot = z.output<
  typeof repairStagingSnapshotSchema
>;

/** BATCH: `to_jsonb(b)` with BIGINT columns as text. */
export const repairBatchSnapshotSchema = z.object({
  id: z.string(),
  adapter_name: z.string(),
  source_filename: z.string().nullable(),
  source_size_bytes: z.string().nullable(),
  custom_config: z.unknown(),
  default_asset_class: z.string().nullable(),
  default_type: z.string().nullable(),
  status: z.string(),
  rows_total: z.number(),
  rows_imported: z.number(),
  rows_duplicate: z.number(),
  rows_error: z.number(),
  error_summary: z.string().nullable(),
  /** TIMESTAMPTZ in JSON: ISO text */
  started_at: z.string(),
  completed_at: z.string().nullable(),
  account_id: z.number().nullable(),
  is_brokerage: z.boolean(),
});
export type RepairBatchSnapshot = z.output<typeof repairBatchSnapshotSchema>;

export const repairTransactionSnapshotRowSchema = z
  .object({ snapshot: repairTransactionSnapshotSchema })
  .describe("repair transaction snapshot row");
export const repairStagingSnapshotRowSchema = z
  .object({ snapshot: repairStagingSnapshotSchema })
  .describe("repair staging snapshot row");
export const repairBatchSnapshotRowSchema = z
  .object({ snapshot: repairBatchSnapshotSchema })
  .describe("repair batch snapshot row");

/**
 * A stored repair state. The journal's CHECK constraints fix its outline
 * (`legacy`/`originalBatch` objects, `imported` object or null,
 * `originalStaging` an array); the snapshots inside are the images the repair
 * captured.
 */
export const duplicateRepairStateSchema = z.object({
  legacy: storedJsonObject<RepairTransactionSnapshot>("legacy snapshot"),
  imported:
    storedJsonObject<RepairTransactionSnapshot>("imported snapshot").nullable(),
  originalBatch: storedJsonObject<RepairBatchSnapshot>("batch snapshot"),
  originalStaging: z.array(
    storedJsonObject<RepairStagingSnapshot>("staging snapshot"),
  ),
});
export type DuplicateRepairState = z.output<typeof duplicateRepairStateSchema>;

/** A `portfolio_import_duplicate_repair_journal` row (`SELECT a.*`). */
export const duplicateRepairJournalRowSchema = z
  .object({
    id: pgBigint,
    batch_id: pgBigint,
    staging_row_id: pgBigint,
    original_import_batch_id: pgBigint,
    legacy_transaction_id: pgInt,
    imported_transaction_id: pgInt,
    action: z.enum(["repair", "restore"]),
    policy: z.enum(["preserve_existing", "prefer_source"]),
    before_data: duplicateRepairStateSchema,
    after_data: duplicateRepairStateSchema,
    previous_entry_id: pgBigint.nullable(),
    created_at: pgTimestamptz,
  })
  .describe("duplicate repair journal row");
export type DuplicateRepairJournalRow = z.output<
  typeof duplicateRepairJournalRowSchema
>;

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/** `SELECT COUNT(*)::int AS n` (commit's occurrence dedup probes). */
export const intCountNRowSchema = z
  .object({ n: pgInt })
  .describe("portfolio import count row");
