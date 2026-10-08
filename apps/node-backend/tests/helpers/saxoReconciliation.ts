/** Synthetic retained XLSX records; never contains supplied account data. */
import { createHash } from "node:crypto";
import { syntheticSaxoWorkbook } from "./saxoWorkbook.ts";
import type { SyntheticSheet } from "./saxoWorkbook.ts";

export const saxoHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const normalize = (value: string) => value.trim().replaceAll("\u00a0", " ");

export function syntheticSaxoPrimaryRawData(
  index = 0,
  sheets: SyntheticSheet[] = syntheticSaxoWorkbook(),
): string {
  const main = sheets[0].records[index];
  return JSON.stringify({
    format: "saxo_xlsx_v1",
    sourceFileHash: "a".repeat(64),
    records: sheets.flatMap((sheet) =>
      sheet.records.flatMap((record, row) => {
        if (
          record["Bk Record Id"] !== main["Bk Record Id"] ||
          record["Rekening-ID"] !== main["Rekening-ID"]
        )
          return [];
        return [
          {
            sheet: sheet.sheet,
            row: row + 2,
            headers: sheet.headers,
            cells: sheet.headers.map((header) => {
              const value = record[normalize(header)] ?? "";
              if (value instanceof Date)
                return { type: "date", value: value.toISOString() };
              return typeof value === "number"
                ? { type: "number", raw: String(value) }
                : value;
            }),
          },
        ];
      }),
    ),
  });
}

export function syntheticSaxoStaging(overrides: Record<string, unknown> = {}) {
  const raw = syntheticSaxoPrimaryRawData();
  return {
    id: 20,
    batch_id: 2,
    row_index: 0,
    status: "matched",
    route: "portfolio",
    type: "buy",
    tx_date: "2025-01-10",
    investment_id: 1,
    asset_class: "stock",
    account_id: 7,
    symbol_raw: "EXM",
    name_raw: "Example Inc",
    source_account_identity: "ACC-1",
    source_transaction_id: "101",
    units: "10.00000000",
    price_per_unit: "18.000000",
    amount: "180.0000",
    fees: "1.0000",
    taxes: "0.6300",
    currency: "EUR",
    fx_rate_to_eur: null,
    raw_data: raw,
    source_record_hash: saxoHash(raw),
    dedup_fingerprint: "b".repeat(64),
    dedup_fingerprint_version: 1,
    custom_config: { format: "saxo_transaction_history" },
    ...overrides,
  };
}

export function syntheticSaxoCsvRecord(
  index = 0,
  sheets: SyntheticSheet[] = syntheticSaxoWorkbook(),
): { raw: string; headers: string[] } {
  const { headers, records } = sheets[0];
  const quote = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  const raw = headers
    .map((header) => {
      const value = records[index][normalize(header)] ?? "";
      return quote(
        value instanceof Date
          ? value.toISOString().slice(0, 10).replaceAll("-", "/")
          : value,
      );
    })
    .join(",");
  return { raw, headers };
}

export function syntheticSaxoCsvStaging(
  index = 0,
  overrides: Record<string, unknown> = {},
) {
  const { raw, headers } = syntheticSaxoCsvRecord(index);
  return syntheticSaxoStaging({
    id: 30 + index,
    batch_id: 3,
    row_index: index,
    raw_data: raw,
    source_record_hash: saxoHash(raw),
    dedup_fingerprint: "d".repeat(64),
    source_transaction_id: String(101 + index),
    type_raw: index === 0 ? "Buy" : "Unsupported Saxo event: Cashdividend",
    custom_config: {
      format: "saxo_transaction_history",
      source_columns: headers,
    },
    currency: index === 0 ? "USD" : "EUR",
    amount: index === 0 ? null : "5.9500",
    price_per_unit: index === 0 ? "20.000000" : null,
    units: index === 0 ? "10.00000000" : null,
    fees: index === 0 ? "2.3111" : "0.0000",
    taxes: null,
    fx_rate_to_eur: index === 0 ? "0.9000000000" : null,
    ...(index === 1
      ? {
          status: "error",
          type: null,
          route: null,
          dedup_fingerprint: null,
          dedup_fingerprint_version: null,
          error_message:
            'unknown transaction type "Unsupported Saxo event: Cashdividend"',
          investment_id: null,
        }
      : {}),
    ...overrides,
  });
}
