/** Complete synthetic Kinesis source; contains no supplied account data. */
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseKinesisTransactionHistory } from "../../src/services/portfolioImportPipeline/kinesisTransactionHistoryAdapter.ts";
import { captureKinesisSourceContext } from "../../src/services/portfolioKinesisAdoptionScope.ts";
import type { KinesisSourceContext } from "../../src/services/portfolioKinesisAdoptionScope.ts";
import type { ParsedPortfolioRow } from "../../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import { parsedDateToYmd } from "../../src/lib/importDates.ts";
import { toDecimal } from "../../src/lib/money.ts";
import type { DecimalInput } from "../../src/lib/money.ts";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "../../src/services/importIdentity.ts";

/** Batch `custom_config` exactly as the Kinesis stage records it. */
export interface SyntheticKinesisConfig {
  format: string;
  yield_basis_policy: "zero";
  source_columns: string[] | undefined;
  kinesis_source_context: KinesisSourceContext;
  /** Attached by reference-evidence fixtures (see kinesisYieldGroups.ts). */
  portfolio_performance_reference?: unknown;
  reference_blockers?: unknown;
}

/**
 * A staged Kinesis row as `portfolio_import_staging_rows` would hold it, with
 * the batch config joined in. NUMERIC columns are fixed-scale strings.
 */
export interface SyntheticKinesisRow {
  id: number;
  batch_id: number;
  row_index: number;
  status: string;
  route: string | null;
  type: string | null;
  type_raw: string;
  tx_date: string | undefined;
  investment_id: number | null;
  asset_class: string;
  account_id: number;
  symbol_raw: string | null;
  name_raw: string | null;
  source_account_identity: string | null | undefined;
  source_transaction_id: string | null | undefined;
  units: string | null;
  price_per_unit: string | null;
  amount: string | null;
  fees: string | null;
  taxes: string | null;
  currency: string | null;
  fx_rate_to_eur: string | null;
  note: string;
  raw_data: string;
  source_record_hash: string;
  dedup_fingerprint: string | null;
  dedup_fingerprint_version: number | null;
  dedup_occurrence: number;
  custom_config: SyntheticKinesisConfig;
  asset_transfer_details: ParsedPortfolioRow["assetTransfer"] | null;
  asset_adjustment_details: ParsedPortfolioRow["assetAdjustment"] | null;
  error_message?: string;
  /** Joined by the review reads; set by fixtures that model them. */
  resolved_investment_id?: number | null;
  user_override_investment_id?: number | null;
}

export interface SyntheticKinesisBatch {
  id: number;
  account_id: number;
  status: string;
  adapter_name: string;
  custom_config: SyntheticKinesisConfig;
  rows_total: number;
}

/** A `portfolio_import_reconciliations` receipt as the adoption fixtures build it. */
export interface SyntheticAdoptionReceipt {
  id: number | string;
  batch_id: number;
  staging_row_id: number;
  transaction_id: number;
  action?: string;
  policy: string;
  before_data: SyntheticKinesisManualRow;
  after_data: SyntheticKinesisManualRow;
}

export interface SyntheticKinesisAdoptionContext {
  sources: SyntheticKinesisRow[];
  batches: SyntheticKinesisBatch[];
  receipts: SyntheticAdoptionReceipt[];
}

export interface SyntheticKinesisScope {
  rows: SyntheticKinesisRow[];
  batches: SyntheticKinesisBatch[];
  history: SyntheticKinesisManualRow[];
  /** Attached by adoption fixtures: the prior batch being adopted from. */
  kinesisAdoptionContext?: SyntheticKinesisAdoptionContext;
  /** Attached by `attachKinesisYieldReference`. */
  referenceOriginalRows?: SyntheticKinesisRow[];
}

/** The staged columns `syntheticKinesisManual` reads. */
export type KinesisManualSource = Pick<
  SyntheticKinesisRow,
  | "investment_id"
  | "type"
  | "tx_date"
  | "amount"
  | "units"
  | "price_per_unit"
  | "fees"
  | "taxes"
  | "currency"
>;

/** A manual `portfolio_transactions` row (NUMERIC columns as strings). */
export interface SyntheticKinesisManualRow {
  id: number;
  investment_id: number | null;
  type: string | null;
  date: string | undefined;
  amount: string | null;
  units: string | null;
  price_per_unit: string | null;
  fees: string;
  taxes: string;
  currency: string;
  fx_rate_to_eur: string | null;
  account_id: number | null;
  note: string;
  dividend_amount_convention: string;
  is_recurring: boolean;
  recurrence_interval: string | null;
  recurrence_end_date: string | null;
  import_batch_id: string | null;
  source_record_hash: string | null;
  dedup_fingerprint: string | null;
  dedup_fingerprint_version: number | null;
}

export interface SyntheticKinesisScopeOptions {
  batchId?: number;
  account?: number;
  investment?: number | null;
  rowStart?: number;
  singleGift?: boolean;
  sourcePath?: string;
}

export const kinesisHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const fixed = (value: DecimalInput, places: number) =>
  value == null
    ? null
    : toDecimal(value).toDecimalPlaces(places, 4).toFixed(places);

export async function syntheticKinesisScope({
  batchId = 2,
  account = 7,
  investment = 1,
  rowStart = 20,
  singleGift = false,
  sourcePath = undefined,
}: SyntheticKinesisScopeOptions = {}): Promise<SyntheticKinesisScope> {
  const path =
    sourcePath ??
    fileURLToPath(
      new URL(
        `../fixtures/portfolio/${singleGift ? "kinesis-adoption-only.csv" : "kinesis-transaction-history.csv"}`,
        import.meta.url,
      ),
    );
  const parsed = await parseKinesisTransactionHistory(path, {
    yield_basis_policy: "zero",
  });
  const config: SyntheticKinesisConfig = {
    format: "kinesis_transaction_history",
    yield_basis_policy: "zero",
    source_columns: parsed.sourceColumns,
    kinesis_source_context: await captureKinesisSourceContext(path, parsed),
  };
  const rows = parsed.map((item, index): SyntheticKinesisRow => {
    const type = ["Buy", "Sell", "Gift", "Dividend"].includes(item.typeRaw)
      ? item.typeRaw.toLowerCase()
      : null;
    const route = type
      ? "portfolio"
      : item.typeRaw === "AssetAdjustment"
        ? "asset_adjustment"
        : ["Deposit", "Withdrawal"].includes(item.typeRaw)
          ? "cash"
          : null;
    return {
      id: rowStart + index,
      batch_id: batchId,
      row_index: index,
      status: route ? "matched" : "error",
      route,
      type,
      type_raw: item.typeRaw,
      tx_date: parsedDateToYmd(item.date),
      investment_id: item.symbolRaw ? investment : null,
      asset_class: "crypto",
      account_id: account,
      symbol_raw: item.symbolRaw || null,
      name_raw: item.nameRaw || null,
      source_account_identity: item.sourceAccountIdentity,
      source_transaction_id: item.sourceId,
      units: fixed(item.units, 8),
      price_per_unit: fixed(item.pricePerUnit, 6),
      amount: fixed(item.amount, 4),
      fees: fixed(item.fees, 4),
      taxes: fixed(item.taxes, 4),
      currency: item.currency,
      fx_rate_to_eur: null,
      note: item.note,
      raw_data: item.rawData,
      source_record_hash: kinesisHash(item.rawData),
      dedup_fingerprint: route
        ? kinesisHash(`${batchId}:${item.sourceId}:${index}`)
        : null,
      dedup_fingerprint_version: route ? 1 : null,
      dedup_occurrence: 1,
      custom_config: config,
      asset_transfer_details: item.assetTransfer || null,
      asset_adjustment_details: item.assetAdjustment || null,
      ...(route ? {} : { error_message: "Unsupported synthetic event" }),
    };
  });
  const identities = assignImportIdentities(rows, (row) =>
    portfolioIdentityBase(row, { accountIdentity: "UNASSIGNED" }),
  );
  rows.forEach((row, index) => {
    if (row.route) row.dedup_fingerprint = identities[index]!.fingerprint;
  });
  const batch: SyntheticKinesisBatch = {
    id: batchId,
    account_id: account,
    status: "awaiting_review",
    adapter_name: config.format,
    custom_config: config,
    rows_total: rows.length,
  };
  return { rows, batches: [batch], history: [] };
}

/** The manual `portfolio_transactions` row an adoption would preserve for `row`. */
export function syntheticKinesisManual(
  row: KinesisManualSource,
  id = 40,
): SyntheticKinesisManualRow {
  return {
    id,
    investment_id: row.investment_id,
    type: row.type,
    date: row.tx_date,
    amount:
      row.amount ??
      // A row without an amount always carries a unit price (buy/sell legs).
      fixed(toDecimal(row.units).times(row.price_per_unit!), 4),
    units: row.units,
    price_per_unit: row.price_per_unit,
    fees: row.fees ?? "0.0000",
    taxes: row.taxes ?? "0.0000",
    currency: row.currency ?? "EUR",
    fx_rate_to_eur: null,
    account_id: null,
    note: "Keep the original manual note",
    dividend_amount_convention: "unknown",
    is_recurring: false,
    recurrence_interval: null,
    recurrence_end_date: null,
    import_batch_id: null,
    source_record_hash: null,
    dedup_fingerprint: null,
    dedup_fingerprint_version: null,
  };
}
