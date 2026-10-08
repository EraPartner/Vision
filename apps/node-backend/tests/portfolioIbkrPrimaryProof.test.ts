import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { loose } from "./helpers/partial.ts";
import { mockTxConnection } from "./helpers/repoMocks.ts";
import {
  getIbkrPrimaryReconciliationEvidence,
  ibkrPrimaryEvidenceIdentifiesLegacy,
} from "../src/services/portfolioIbkrPrimaryProof.ts";
vi.mock("../src/config/logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/database/connection.ts", () =>
  mockTxConnection(undefined, { query: vi.fn(async () => ({ rows: [] })) }),
);
import { query } from "../src/database/connection.ts";
import { parseIbkrTransactionHistory } from "../src/services/portfolioImportPipeline/ibkrTransactionHistoryAdapter.ts";
import {
  applyPortfolioAssetScope,
  stageBatch,
} from "../src/services/portfolioImportPipeline/stage.ts";

type ScopeRow = Parameters<typeof ibkrPrimaryEvidenceIdentifiesLegacy>[0];

const hash = (raw: string | Buffer) =>
  createHash("sha256").update(raw).digest("hex");
const columns = [
  "Date",
  "Account",
  "Description",
  "Transaction Type",
  "Symbol",
  "Quantity",
  "Price",
  "Price Currency",
  "Gross Amount",
  "Commission",
  "Net Amount",
  "Exchange Rate",
  "Transaction Fees",
  "Sub Type",
  "Multiplier",
];
const record = (type: string, gross: string, net: string, extra = {}) =>
  Object.fromEntries(
    columns.map((key) => [
      key,
      {
        Date: "2026-01-01",
        Account: "U0000000",
        Description: "Synthetic event",
        "Transaction Type": type,
        Symbol: "EXM",
        Quantity: "-",
        Price: "-",
        "Price Currency": "-",
        "Gross Amount": gross,
        Commission: "0",
        "Net Amount": net,
        "Exchange Rate": "0.85",
        "Transaction Fees": "0",
        "Sub Type": "-",
        Multiplier: "1",
        ...extra,
      }[key],
    ]),
  );
const raw = (r: Record<string, string | undefined>, order = columns) =>
  ["Transaction History", "Data", ...order.map((key) => r[key])].join(",");
function fixtures() {
  const records = [
    record("Sell", "17", "16.15", {
      Quantity: "2",
      Price: "10",
      "Price Currency": "USD",
      Commission: "0.85",
    }),
    record("Dividend", "3.3333333", "3.3333333"),
    record("Foreign Tax Withholding", "-0.3333333", "-0.3333333"),
  ];
  const context = {
    version: 1,
    source_file_hash: "a".repeat(64),
    source_columns: columns,
    base_currency: "EUR",
    header_record: ["Transaction History", "Header", ...columns].join(","),
    summary_base_currency_record: "Summary,Data,Base Currency,EUR",
    record_hashes: records.map((r) => hash(raw(r))),
  };
  // The synthetic staging rows carry numeric ids where pg returns BIGINT text.
  const rows = loose<(ScopeRow & { id: number })[]>(
    records.map((record, index) => ({
      id: index + 1,
      batch_id: 7,
      investment_id: 1,
      route: "portfolio",
      type: ["sell", "dividend", "tax"][index],
      type_raw: ["Sell", "Dividend", "tax"][index],
      tx_date: "2026-01-01",
      symbol_raw: "EXM",
      source_account_identity: "U0000000",
      raw_data: raw(record),
      source_record_hash: hash(raw(record)),
      custom_config: {
        format: "ibkr_transaction_history",
        ibkr_source_context: structuredClone(context),
      },
      currency: index === 0 ? "USD" : "EUR",
      units: index === 0 ? "2" : null,
      price_per_unit: index === 0 ? "10" : null,
      amount: index === 0 ? null : index === 1 ? "3.3333" : "0.3333",
      fees: index === 0 ? "1" : "0",
      taxes: "0",
      fx_rate_to_eur: index === 0 ? "0.85" : null,
    })),
  );
  const sources = rows.map((row) => ({
    type: row.type,
    date: row.tx_date,
    currency: row.currency,
    amount: row.type === "sell" ? "20" : row.amount,
    units: row.units,
    price_per_unit: row.price_per_unit,
    fees: row.fees,
    taxes: "0",
    fx_rate_to_eur: row.fx_rate_to_eur,
  }));
  const legacy = (type: string, over = {}) => ({
    id: 20,
    investment_id: 1,
    type,
    date: "2026-01-01",
    account_id: null,
    import_batch_id: null,
    dedup_fingerprint: null,
    currency: type === "sell" ? "EUR" : "USD",
    amount: type === "sell" ? "20" : "3.33",
    units: type === "sell" ? "2" : null,
    price_per_unit: type === "sell" ? "10" : null,
    fees: "0",
    taxes: type === "sell" ? "0" : "0.33",
    ...over,
  });
  return { records, context, rows, sources, legacy };
}

describe("literal IBKR primary context and transcription proof", () => {
  it("proves a quoted native sale copied into the base currency label without inventing FX", () => {
    const { rows, sources, legacy } = fixtures();
    expect(
      ibkrPrimaryEvidenceIdentifiesLegacy(
        rows[0],
        sources[0],
        legacy("sell"),
        rows,
      ),
    ).toBe(true);
    expect(
      ibkrPrimaryEvidenceIdentifiesLegacy(
        rows[0],
        sources[0],
        legacy("sell", { amount: "17", price_per_unit: "8.5" }),
        rows,
      ),
    ).toBe(false);
  });
  it("proves base-currency gross income with separate withholding and copied cent values", () => {
    const { rows, sources, legacy } = fixtures();
    expect(
      ibkrPrimaryEvidenceIdentifiesLegacy(
        rows[1],
        sources[1],
        legacy("dividend"),
        rows,
      ),
    ).toBe(true);
    expect(sources[1].taxes).toBe("0");
    expect(getIbkrPrimaryReconciliationEvidence(rows[2])!.amount).toBe(
      "0.3333333",
    );
  });
  it("permits income without withholding only when the legacy tax is zero", () => {
    const { rows, sources, legacy } = fixtures();
    expect(
      ibkrPrimaryEvidenceIdentifiesLegacy(
        rows[1],
        sources[1],
        legacy("dividend", { taxes: "0" }),
        rows.slice(0, 2),
      ),
    ).toBe(true);
    expect(
      ibkrPrimaryEvidenceIdentifiesLegacy(
        rows[1],
        sources[1],
        legacy("dividend"),
        rows.slice(0, 2),
      ),
    ).toBe(false);
  });
  it.each([
    "missing context",
    "wrong base",
    "wrong header",
    "changed source hash",
    "outside source file",
    "different date",
    "changed fee",
    "changed FX",
    "changed units",
  ])("rejects %s", (kind) => {
    const { rows } = fixtures();
    const row = rows[0];
    if (kind === "missing context")
      delete row.custom_config.ibkr_source_context;
    if (kind === "wrong base")
      row.custom_config.ibkr_source_context.base_currency = "USD";
    if (kind === "wrong header")
      row.custom_config.ibkr_source_context.header_record =
        "Transaction History,Header,Unknown";
    if (kind === "changed source hash") row.source_record_hash = "b".repeat(64);
    if (kind === "outside source file")
      row.custom_config.ibkr_source_context.record_hashes = [];
    if (kind === "different date") row.tx_date = "2026-01-02";
    if (kind === "changed fee") row.fees = "1.1";
    if (kind === "changed FX") row.fx_rate_to_eur = "0.86";
    if (kind === "changed units") row.units = "3";
    expect(getIbkrPrimaryReconciliationEvidence(row)).toBeUndefined();
  });
  it("uses actual reordered header columns rather than a presumed schema order", () => {
    const { rows, records } = fixtures();
    const row = rows[0];
    const order = columns.toReversed();
    row.raw_data = raw(records[0], order);
    row.source_record_hash = hash(row.raw_data);
    Object.assign(row.custom_config.ibkr_source_context, {
      source_columns: order,
      header_record: ["Transaction History", "Header", ...order].join(","),
      record_hashes: [row.source_record_hash],
    });
    expect(getIbkrPrimaryReconciliationEvidence(row)?.currency).toBe("USD");
  });
  it("binds the unchanged primary record beneath optional XML evidence", () => {
    const { rows } = fixtures();
    rows[0].raw_data = JSON.stringify({ primaryRawData: rows[0].raw_data });
    expect(getIbkrPrimaryReconciliationEvidence(rows[0])).toBeDefined();
  });
  it("rejects nearby dates, double withholding, non-cent legacy values and an ambiguous tax pair", () => {
    const { rows, sources, legacy } = fixtures();
    expect(
      ibkrPrimaryEvidenceIdentifiesLegacy(
        rows[1],
        sources[1],
        legacy("dividend", { date: "2026-01-02" }),
        rows,
      ),
    ).toBe(false);
    expect(
      ibkrPrimaryEvidenceIdentifiesLegacy(
        rows[1],
        { ...sources[1], taxes: "0.33" },
        legacy("dividend"),
        rows,
      ),
    ).toBe(false);
    expect(
      ibkrPrimaryEvidenceIdentifiesLegacy(
        rows[1],
        sources[1],
        legacy("dividend", { amount: "3.331" }),
        rows,
      ),
    ).toBe(false);
    expect(
      ibkrPrimaryEvidenceIdentifiesLegacy(
        rows[1],
        sources[1],
        legacy("dividend"),
        [...rows, { ...rows[2], id: 4 }],
      ),
    ).toBe(false);
  });
  it("captures literal context and original file hash, preserving primary raw records through scope and staging", async () => {
    // The file readers accept the fixture's file URL as well as a path.
    const path = loose<string>(
      new URL(
        "fixtures/portfolio/ibkr-transaction-history.csv",
        import.meta.url,
      ),
    );
    const parsed = await parseIbkrTransactionHistory(path);
    const context = parsed.ibkrSourceContext!;
    expect(context.source_file_hash).toBe(hash(await readFile(path)));
    expect(context.base_currency).toBe("EUR");
    expect(context.header_record).toContain("Transaction History,Header");
    expect(context.record_hashes).toEqual(parsed.map((r) => hash(r.rawData)));
    const scoped = applyPortfolioAssetScope(parsed, ["EXM"]);
    expect(scoped.ibkrSourceContext).toEqual(context);
    expect(scoped[0].rawData).toBe(parsed[0].rawData);
    vi.mocked(query).mockClear();
    await stageBatch({
      batchId: 1,
      filePath: path,
      customConfig: { format: "ibkr_transaction_history" },
    });
    expect(
      vi
        .mocked(query)
        .mock.calls.some(
          ([sql, params]) =>
            sql.includes("ibkr_source_context") &&
            JSON.parse(params![1] as string).source_file_hash ===
              context.source_file_hash,
        ),
    ).toBe(true);
  });
});
