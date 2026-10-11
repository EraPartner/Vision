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
import { syntheticKinesisManual } from "./kinesisAdoptionScope.ts";
export async function nativeGiftFixture({
  account = 8,
  investment = 1,
  batchId = 3,
} = {}) {
  const host = "https://kau-mainnet.kinesisgroup.io",
    recipient = "SYNTHETIC-RECIPIENT";
  const txs = ["a", "b", "c"].map((letter, index) => ({
    hash: letter.repeat(64),
    successful: true,
    created_at: index
      ? `2026-01-02T${index === 1 ? "10" : "11"}:00:00Z`
      : "2026-01-01T10:00:00Z",
    source_account: `SYNTHETIC-DONOR-${index}`,
    fee_account: `SYNTHETIC-DONOR-${index}`,
    fee_charged: "100",
    operation_count: 1,
    paging_token: String(index + 1),
  }));
  const ops = txs.map((tx, index) => ({
    transaction_successful: true,
    transaction_hash: tx.hash,
    created_at: tx.created_at,
    source_account: tx.source_account,
    ...(index
      ? {
          type: "payment",
          asset_type: "native",
          from: tx.source_account,
          to: recipient,
          amount: "0.4000000",
        }
      : {
          type: "create_account",
          funder: tx.source_account,
          account: recipient,
          starting_balance: "0.2500000",
        }),
  }));
  const url = `${host}/accounts/${recipient}/transactions?order=desc&limit=10`,
    next = url + "&cursor=1";
  const pages = [
    {
      url,
      body: {
        _embedded: { records: [...txs].reverse() },
        _links: { next: { href: next } },
      },
    },
    { url: next, body: { _embedded: { records: [] } } },
    ...txs.map((tx, index) => ({
      url: `${host}/transactions/${tx.hash}/operations`,
      body: { _embedded: { records: [ops[index]] } },
    })),
  ];
  const receipts = txs.slice(1).map((tx, index) => ({
    version: 1,
    network: "kinesis",
    asset: "KAU",
    transaction: tx,
    operation: ops[index + 1],
    destinationAccount: {
      account_id: recipient,
      balances: [{ asset_type: "native", balance: "1.0500000" }],
    },
    sourceHistoryPages: pages,
    recordedBasisWitness: {
      id: `SYNTHETIC-BASIS-${index}`,
      date: "2026-01-01",
      sourceHash: "f".repeat(64),
      literal: {
        transactionId: `SYNTHETIC-BASIS-${index}`,
        date: "2026-01-01T00:00",
        type: "DELIVERY_INBOUND",
        currency: "USD",
        amountMinor: "725",
        sharesMinor: "40000000",
        securityId: "SYNTHETIC-SECURITY",
        units: [],
      },
    },
  }));
  const columns = [
    "Date",
    "Type",
    "Symbol",
    "Units",
    "Amount",
    "Currency",
    "Source_ID",
    "Source_Account",
    "Note",
    "Receipt_JSON",
  ];
  const csv =
    [
      columns.join(","),
      ...receipts.map((receipt) =>
        [
          "2026-01-02",
          "gift",
          "KAU",
          "0.4",
          "7.25",
          "USD",
          receipt.transaction.hash,
          receipt.transaction.source_account,
          "Literal native gift",
          JSON.stringify(receipt),
        ]
          .map((value) => '"' + value.replaceAll('"', '""') + '"')
          .join(","),
      ),
    ].join("\n") + "\n";
  const mapping = {
    date_format: "%Y-%m-%d",
    number_format: "decimal_dot",
    column_mapping: {
      date: "Date",
      type: "Type",
      symbol: "Symbol",
      units: "Units",
      amount: "Amount",
      currency: "Currency",
      source_id: "Source_ID",
      source_account: "Source_Account",
      note: "Note",
    },
  };
  const dir = await mkdtemp(join(tmpdir(), "vision-native-gifts-"));
  try {
    const path = join(dir, "gifts.csv");
    await writeFile(path, csv);
    const parsed = await parseWithConfig(path, mapping),
      config = { ...mapping, source_columns: parsed.sourceColumns };
    const rows = parsed.map((item, index) => ({
      id: 90 + index,
      batch_id: batchId,
      row_index: index,
      status: "matched",
      route: "portfolio",
      type: "gift",
      type_raw: item.typeRaw,
      tx_date: parsedDateToYmd(item.date),
      symbol_raw: item.symbolRaw,
      investment_id: investment,
      asset_class: "metals",
      account_id: account,
      units: String(item.units),
      amount: String(item.amount),
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
      asset_transfer_details: null,
      asset_adjustment_details: null,
      custom_config: config,
    }));
    const identities = assignImportIdentities(rows, (row) =>
      portfolioIdentityBase(row, { accountIdentity: "UNASSIGNED" }),
    );
    rows.forEach((row, index) =>
      Object.assign(row, {
        dedup_fingerprint: identities[index]!.fingerprint,
        dedup_fingerprint_version: 1,
        dedup_occurrence: identities[index]!.occurrence,
      }),
    );
    return {
      rows,
      batches: [
        {
          id: batchId,
          account_id: account,
          status: "awaiting_review",
          adapter_name: "portfolio_generic",
          rows_total: 2,
          custom_config: config,
        },
      ],
      history: [
        {
          ...syntheticKinesisManual(rows[0]!),
          account_id: account,
          fx_rate_to_eur: "0.9200000000",
        },
      ],
      receipts,
      csv,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
