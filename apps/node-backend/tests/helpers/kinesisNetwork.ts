import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseWithConfig } from "../../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "../../src/services/importIdentity.ts";
import { parsedDateToYmd } from "../../src/lib/importDates.ts";
import type { ParsedPortfolioRow } from "../../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";

export interface NetworkReceiptOptions {
  kind?: string;
  asset?: string;
}

export interface NetworkSourceOptions extends NetworkReceiptOptions {
  batchId?: number;
  account?: number;
  investment?: number | null;
  rowId?: number;
}

/** The staged row `networkSource` builds; identity columns are assigned after construction. */
export interface NetworkSourceRow {
  id: number;
  batch_id: number;
  row_index: number;
  status: string;
  route: string;
  type: null;
  type_raw: string;
  tx_date: string | undefined;
  symbol_raw: string;
  investment_id: number | null;
  account_id: number;
  units: string;
  amount: null;
  price_per_unit: null;
  fees: null;
  taxes: null;
  currency: string | null;
  fx_rate_to_eur: null;
  note: string;
  raw_data: string;
  source_record_hash: string;
  source_transaction_id: string | null | undefined;
  source_account_identity: string | null | undefined;
  asset_transfer_details: ParsedPortfolioRow["assetTransfer"];
  asset_adjustment_details: ParsedPortfolioRow["assetAdjustment"];
  custom_config: typeof networkMapping & {
    source_columns: string[] | undefined;
  };
  dedup_fingerprint?: string;
  dedup_fingerprint_version?: number;
  dedup_occurrence?: number;
  /** Joined by the review reads; set by fixtures that model them. */
  resolved_investment_id?: number | null;
  user_override_investment_id?: number | null;
}

export function networkReceipt({
  kind = "asset_transfer_witness",
  asset = "KAG",
}: NetworkReceiptOptions = {}) {
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
      ...(
        [
          [tx, op],
          [opening, openOp],
        ] as const
      ).map(([transaction, operation]) => ({
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
export type NetworkReceipt = ReturnType<typeof networkReceipt>;

export const networkCsv = (receipt: NetworkReceipt, kind: string) =>
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
}: NetworkSourceOptions = {}) {
  const receipt = networkReceipt({ kind, asset }),
    directory = await mkdtemp(join(tmpdir(), "vision-native-test-"));
  try {
    const path = join(directory, "receipt.csv");
    await writeFile(path, networkCsv(receipt, kind));
    const parsed = await parseWithConfig(path, networkMapping),
      item = parsed[0]!,
      config = { ...networkMapping, source_columns: parsed.sourceColumns };
    const row: NetworkSourceRow = {
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
      )[0]!.fingerprint,
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
