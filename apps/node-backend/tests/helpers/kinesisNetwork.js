import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseWithConfig } from "../../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "../../src/services/importIdentity.js";
import { parsedDateToYmd } from "../../src/lib/importDates.ts";

export function networkReceipt({
  kind = "asset_transfer_witness",
  asset = "KAG",
} = {}) {
  const host = `https://${asset.toLowerCase()}-mainnet.kinesisgroup.io`,
    source = "SYNTHETIC-SENDER",
    destination = "SYNTHETIC-DESTINATION";
  const opening = {
    hash: "a".repeat(64),
    successful: true,
    created_at: "2026-01-01T10:00:00Z",
    source_account: "SYNTHETIC-FUNDER",
    fee_account: "SYNTHETIC-FUNDER",
    fee_charged: "100",
    operation_count: 1,
    paging_token: "1",
  };
  const tx = {
    hash: "b".repeat(64),
    successful: true,
    created_at: "2026-01-02T10:00:00Z",
    source_account: source,
    fee_account: source,
    fee_charged: "1500",
    operation_count: 1,
    paging_token: "2",
  };
  const openOp = {
    type: "create_account",
    transaction_successful: true,
    transaction_hash: opening.hash,
    created_at: opening.created_at,
    source_account: opening.source_account,
    funder: opening.source_account,
    account: source,
    starting_balance: "1.0000000",
  };
  const op = {
    transaction_successful: true,
    transaction_hash: tx.hash,
    created_at: tx.created_at,
    source_account: source,
    ...(kind === "asset_fee"
      ? {
          type: "payment",
          asset_type: "native",
          from: source,
          to: destination,
          amount: "0.0300000",
        }
      : {
          type: "create_account",
          funder: source,
          account: destination,
          starting_balance: "0.0300000",
        }),
  };
  const url = `${host}/accounts/${source}/transactions?order=desc&limit=10`,
    next = `${host}/accounts/${source}/transactions?order=desc&limit=10&cursor=1`;
  return {
    version: 1,
    network: "kinesis",
    asset,
    transaction: tx,
    operation: op,
    sourceAccount: {
      account_id: source,
      balances: [{ asset_type: "native", balance: "0.9698500" }],
    },
    destinationAccount: {
      account_id: destination,
      balances: [{ asset_type: "native", balance: "0.0300000" }],
    },
    sourceHistoryPages: [
      {
        url,
        body: {
          _embedded: { records: [tx, opening] },
          _links: { next: { href: next } },
        },
      },
      { url: next, body: { _embedded: { records: [] } } },
      ...[
        [tx, op],
        [opening, openOp],
      ].map(([transaction, operation]) => ({
        url: `${host}/transactions/${transaction.hash}/operations`,
        body: { _embedded: { records: [operation] } },
      })),
    ],
  };
}
export const networkMapping = {
  date_format: "%Y-%m-%d",
  number_format: "decimal_dot",
  column_mapping: {
    date: "Date",
    type: "Type",
    symbol: "Symbol",
    units: "Units",
    currency: "Currency",
    source_id: "Source_ID",
    source_account: "Source_Account",
    note: "Note",
  },
};
export const networkCsv = (receipt, kind) =>
  [
    "Date,Type,Symbol,Units,Currency,Source_ID,Source_Account,Note,Receipt_JSON",
    [
      "2026-01-02",
      kind,
      receipt.asset,
      kind === "asset_fee" ? "0.0001500" : "0.0300000",
      receipt.asset,
      receipt.transaction.hash,
      receipt.sourceAccount.account_id,
      "Literal native receipt",
      JSON.stringify(receipt),
    ]
      .map((value) => `"${value.replaceAll('"', '""')}"`)
      .join(","),
  ].join("\n") + "\n";
export async function networkSource({
  kind = "asset_transfer_witness",
  asset = "KAG",
  batchId = 3,
  account = 8,
  investment = 1,
  rowId = 90,
} = {}) {
  const receipt = networkReceipt({ kind, asset }),
    directory = await mkdtemp(join(tmpdir(), "vision-native-test-"));
  try {
    const path = join(directory, "receipt.csv");
    await writeFile(path, networkCsv(receipt, kind));
    const parsed = await parseWithConfig(path, networkMapping),
      item = parsed[0],
      config = { ...networkMapping, source_columns: parsed.sourceColumns };
    const row = {
      id: rowId,
      batch_id: batchId,
      row_index: 0,
      status: "matched",
      route: kind === "asset_fee" ? "asset_adjustment" : "account_internal",
      type: null,
      type_raw: item.typeRaw,
      tx_date: parsedDateToYmd(item.date),
      symbol_raw: item.symbolRaw,
      investment_id: investment,
      account_id: account,
      units: String(item.units),
      amount: null,
      price_per_unit: null,
      fees: null,
      taxes: null,
      currency: item.currency,
      fx_rate_to_eur: null,
      note: item.note,
      raw_data: item.rawData,
      source_record_hash: createHash("sha256")
        .update(item.rawData)
        .digest("hex"),
      source_transaction_id: item.sourceId,
      source_account_identity: item.sourceAccountIdentity,
      asset_transfer_details: item.assetTransfer,
      asset_adjustment_details: item.assetAdjustment,
      custom_config: config,
    };
    Object.assign(row, {
      dedup_fingerprint: assignImportIdentities([row], (source) =>
        portfolioIdentityBase(source, { accountIdentity: "UNASSIGNED" }),
      )[0].fingerprint,
      dedup_fingerprint_version: 1,
      dedup_occurrence: 1,
    });
    return {
      receipt,
      rows: [row],
      batches: [
        {
          id: batchId,
          account_id: account,
          status: "awaiting_review",
          custom_config: config,
          rows_total: 1,
        },
      ],
      history: [],
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
