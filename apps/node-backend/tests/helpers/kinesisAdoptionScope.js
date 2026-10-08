/** Complete synthetic Kinesis source; contains no supplied account data. */
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseKinesisTransactionHistory } from "../../src/services/portfolioImportPipeline/kinesisTransactionHistoryAdapter.js";
import { captureKinesisSourceContext } from "../../src/services/portfolioKinesisAdoptionScope.js";
import { parsedDateToYmd } from "../../src/lib/importDates.ts";
import { toDecimal } from "../../src/lib/money.ts";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "../../src/services/importIdentity.js";

export const kinesisHash = (value) =>
  createHash("sha256").update(value).digest("hex");
const fixed = (value, places) =>
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
} = {}) {
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
  const config = {
    format: "kinesis_transaction_history",
    yield_basis_policy: "zero",
    source_columns: parsed.sourceColumns,
    kinesis_source_context: await captureKinesisSourceContext(path, parsed),
  };
  const rows = parsed.map((item, index) => {
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
    if (row.route) row.dedup_fingerprint = identities[index].fingerprint;
  });
  const batch = {
    id: batchId,
    account_id: account,
    status: "awaiting_review",
    adapter_name: config.format,
    custom_config: config,
    rows_total: rows.length,
  };
  return { rows, batches: [batch], history: [] };
}

export function syntheticKinesisManual(row, id = 40) {
  return {
    id,
    investment_id: row.investment_id,
    type: row.type,
    date: row.tx_date,
    amount:
      row.amount ?? fixed(toDecimal(row.units).times(row.price_per_unit), 4),
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
