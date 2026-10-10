import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseIbkrFundingHistory,
  getIbkrFundingPrimaryEvidence,
} from "../src/services/portfolioImportPipeline/ibkrFundingHistoryAdapter.ts";
import type { IbkrFundingSourceContext } from "../src/services/portfolioImportPipeline/ibkrFundingHistoryAdapter.ts";
import { assertPortfolioUploadSupported } from "../src/lib/portfolioUpload.ts";

const DEPOSIT_HEADERS = [
  "Request Date",
  "Reference Number",
  "Method",
  "Account ID",
  "Account Title",
  "Delivering Institution",
  "From Account Number",
  "Routing Number",
  "Date Received",
  "Date Available for Trading",
  "Date Available for Withdrawal - Original Bank",
  "Date Available for Withdrawal - Other Bank",
  "Amount",
  "Status",
];
const WITHDRAWAL_HEADERS = [
  "Request Date",
  "Reference Number",
  "Method",
  "Account ID",
  "Account Title",
  "Receiving Institution",
  "Date Processed",
  "Amount",
  "Status",
];
type SourceRecord = Record<string, unknown>;
type FundingRows = Awaited<ReturnType<typeof parseIbkrFundingHistory>>;
const deposit = (overrides: SourceRecord = {}): SourceRecord => ({
  "Request Date": "2025-01-02",
  "Reference Number": "SYNTHETIC-DEP-1",
  Method: "Wire",
  "Account ID": "SYNTHETIC-ACCOUNT",
  "Account Title": "Synthetic Owner",
  "Delivering Institution": "Synthetic Bank",
  "From Account Number": "SYNTHETIC-SOURCE",
  "Routing Number": "",
  "Date Received": "2025-01-02",
  "Date Available for Trading": "2025-01-02",
  "Date Available for Withdrawal - Original Bank": "2025-01-05",
  "Date Available for Withdrawal - Other Bank": "2025-02-01",
  Amount: "USD 1,234.56",
  Status: "Available",
  ...overrides,
});
const withdrawal = (overrides: SourceRecord = {}): SourceRecord => ({
  "Request Date": "2025-01-07",
  "Reference Number": "SYNTHETIC-WITH-1",
  Method: "Wire",
  "Account ID": "SYNTHETIC-ACCOUNT",
  "Account Title": "Synthetic Owner",
  "Receiving Institution": "Synthetic Bank",
  "Date Processed": "2025-01-08",
  Amount: "EUR 25.40",
  Status: "Sent",
  ...overrides,
});
const sheet = (name: string, headers: string[], records: SourceRecord[]) => ({
  name,
  headers,
  records,
});
const standardSheets = () => [
  sheet("Deposit", DEPOSIT_HEADERS, [deposit()]),
  sheet("Withdrawal", WITHDRAWAL_HEADERS, [withdrawal()]),
];
let directory: string;
let file: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "vision-ibkr-funding-test-"),
  );
  file = path.join(directory, "extensionless-upload");
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

async function writeWorkbook(
  sheets = standardSheets(),
  format: XLSX.BookType = "biff8",
  mutate?: (workbook: XLSX.WorkBook) => void,
) {
  const workbook = XLSX.utils.book_new();
  for (const source of sheets) {
    const cells = [
      source.headers,
      ...source.records.map((record) =>
        source.headers.map((key) => record[key] ?? ""),
      ),
    ];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(cells),
      source.name,
    );
  }
  mutate?.(workbook);
  await fs.writeFile(
    file,
    XLSX.write(workbook, { type: "buffer", bookType: format }),
  );
}

function stagingRow(parsed: FundingRows[number], rows: FundingRows) {
  return {
    custom_config: {
      format: "ibkr_funding_history",
      ibkr_funding_source_context: rows.ibkrFundingSourceContext,
    },
    route: "cash",
    type: null,
    type_raw: parsed.typeRaw,
    tx_date: parsed.date!.toISOString().slice(0, 10),
    currency: parsed.currency,
    amount: parsed.amount,
    units: null,
    price_per_unit: null,
    fees: null,
    taxes: null,
    source_account_identity: parsed.sourceAccountIdentity,
    source_transaction_id: parsed.sourceId,
    raw_data: parsed.rawData,
    source_record_hash: createHash("sha256")
      .update(parsed.rawData)
      .digest("hex"),
  };
}

describe("IBKR native funding history workbook", () => {
  it.each(["biff8", "xlsx"] as const)(
    "preserves native currency, request date and literal proof from %s",
    async (format) => {
      await writeWorkbook(undefined, format);
      await assertPortfolioUploadSupported(file, {
        format: "ibkr_funding_history",
      });
      const rows = await parseIbkrFundingHistory(file);
      expect(rows).toHaveLength(2);
      expect(rows.skipped).toBe(0);
      expect(rows[0]).toMatchObject({
        typeRaw: "Deposit",
        amount: 1234.56,
        currency: "USD",
        fees: null,
        taxes: null,
        sourceAccountIdentity: "SYNTHETIC-ACCOUNT",
        sourceId: "SYNTHETIC-DEP-1",
        fxRateToEur: null,
      });
      expect(rows[1]).toMatchObject({
        typeRaw: "Withdrawal",
        amount: 25.4,
        currency: "EUR",
      });
      expect(rows[1]!.date).toEqual(new Date("2025-01-07T00:00:00Z"));
      const envelope = JSON.parse(rows[0]!.rawData);
      expect(envelope).toMatchObject({
        schema: "ibkr_funding_workbook_row",
        version: 1,
        sheet: "Deposit",
        header_row: 1,
        row_number: 2,
        source_format: format === "biff8" ? "xls" : "xlsx",
        columns: DEPOSIT_HEADERS,
      });
      expect(envelope.cells[12]).toEqual({
        type: "text",
        value: "USD 1,234.56",
      });
      expect(envelope.source_file_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(rows.ibkrFundingSourceContext.record_hashes).toHaveLength(2);
      expect(
        getIbkrFundingPrimaryEvidence(stagingRow(rows[0]!, rows)),
      ).toMatchObject({
        type: "deposit",
        direction: "in",
        date: "2025-01-02",
        completedDate: "2025-01-02",
        amount: "1234.56",
        currency: "USD",
        sourceAccount: "SYNTHETIC-ACCOUNT",
        sourceId: "SYNTHETIC-DEP-1",
        institution: "Synthetic Bank",
        status: "Available",
      });
    },
  );

  it("does not require a bank name that the source leaves absent", async () => {
    await writeWorkbook([
      sheet("Deposit", DEPOSIT_HEADERS, [
        deposit({ "Delivering Institution": "" }),
      ]),
    ]);
    const rows = await parseIbkrFundingHistory(file);
    expect(
      getIbkrFundingPrimaryEvidence(stagingRow(rows[0]!, rows))?.institution,
    ).toBeUndefined();
  });

  it.each([
    [{ Status: "Pending" }, /completed status/],
    [{ Status: "Cancelled" }, /completed status/],
    [{ Method: "Unknown" }, /funding method/],
    [{ Amount: "1234.56" }, /explicit native currency/],
    [{ Amount: "$ 1,234.56" }, /explicit native currency/],
    [{ Amount: "ZZZ 1,234.56" }, /explicit native currency/],
    [{ Amount: "USD 1.234,56" }, /explicit native currency/],
    [{ Amount: "USD 12,34.56" }, /explicit native currency/],
    [{ Amount: "USD -1.00" }, /explicit native currency/],
    [{ Amount: "USD 0.00" }, /funding amount/],
    [{ "Request Date": "2025-02-30" }, /invalid calendar/],
    [{ "Date Received": "2025-01-01" }, /inconsistent request/],
    [{ "Account ID": "" }, /required field/],
    [{ "Reference Number": "" }, /required field/],
    [{ "Reference Number": 12345 }, /literal text/],
  ])("rejects unsupported or unproved native fields", async (fields, error) => {
    await writeWorkbook([sheet("Deposit", DEPOSIT_HEADERS, [deposit(fields)])]);
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow(error);
  });

  it("rejects duplicate references, mixed accounts and ownership labels", async () => {
    for (const rows of [
      [deposit(), deposit()],
      [
        deposit(),
        deposit({
          "Reference Number": "SYNTHETIC-DEP-2",
          "Account ID": "SYNTHETIC-OTHER",
        }),
      ],
      [
        deposit(),
        deposit({
          "Reference Number": "SYNTHETIC-DEP-2",
          "Account Title": "Different Owner",
        }),
      ],
    ]) {
      await writeWorkbook([sheet("Deposit", DEPOSIT_HEADERS, rows)]);
      await expect(parseIbkrFundingHistory(file)).rejects.toThrow(
        /duplicate|unambiguous|ownership/,
      );
    }
  });

  it("rejects changed headers, formulas, hidden sheets and unrelated workbooks", async () => {
    await writeWorkbook([
      sheet(
        "Deposit",
        [...DEPOSIT_HEADERS.slice(0, -1), "Amount"],
        [deposit()],
      ),
    ]);
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow(
      /complete header/,
    );
    await writeWorkbook([sheet("Unrelated", DEPOSIT_HEADERS, [deposit()])]);
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow(
      /original Deposit/,
    );
    await writeWorkbook(undefined, "xlsx", (workbook) => {
      workbook.Sheets.Deposit!.M2 = {
        t: "s",
        v: "USD 1,234.56",
        f: '"USD 1,234.56"',
      };
    });
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow(/formulas/);
    await writeWorkbook(undefined, "xlsx", (workbook) => {
      workbook.Workbook = {
        Sheets: [
          { name: "Deposit", Hidden: 1 },
          { name: "Withdrawal", Hidden: 0 },
        ],
      };
    });
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow(
      /unsupported sheets/,
    );
    await fs.writeFile(file, "<html>not a native workbook</html>");
    await expect(
      assertPortfolioUploadSupported(file, { format: "ibkr_funding_history" }),
    ).rejects.toThrow(/original XLS/);
  });

  it("rejects excessive cell bounds before enumerating rows", async () => {
    await writeWorkbook(undefined, "xlsx", (workbook) => {
      workbook.Sheets.Deposit!["!ref"] = "A1:N50000";
    });
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow(/cell limits/);
  });

  it("requires full literal context and staging equality for primary evidence", async () => {
    await writeWorkbook();
    const rows = await parseIbkrFundingHistory(file);
    const base = stagingRow(rows[0]!, rows);
    expect(getIbkrFundingPrimaryEvidence(base)).toBeDefined();
    for (const fields of [
      { amount: 1234.55 },
      { currency: "EUR" },
      { tx_date: "2025-01-03" },
      { type_raw: "Withdrawal" },
      { route: "portfolio" },
      { type: "buy" },
      { source_transaction_id: "OTHER" },
      { source_account_identity: "OTHER" },
      { fees: 1 },
      { taxes: 1 },
      { units: 1 },
      { source_record_hash: "a".repeat(64) },
    ])
      expect(
        getIbkrFundingPrimaryEvidence({ ...base, ...fields }),
      ).toBeUndefined();
    for (const mutate of [
      (context: IbkrFundingSourceContext) => {
        context.source_file_hash = "a".repeat(64);
      },
      (context: IbkrFundingSourceContext) => {
        context.record_hashes = [];
      },
      (context: IbkrFundingSourceContext) => {
        context.sheets[0]!.records[0]!.row_number = 3;
      },
      (context: IbkrFundingSourceContext) => {
        context.sheets[0]!.source_columns[0] = "Changed";
      },
      (context: IbkrFundingSourceContext) => {
        context.sheets[0]!.records[0]!.source_id = "OTHER";
      },
    ]) {
      const value = structuredClone(base);
      mutate(value.custom_config.ibkr_funding_source_context);
      expect(getIbkrFundingPrimaryEvidence(value)).toBeUndefined();
    }
    const wrapped = {
      ...base,
      raw_data: JSON.stringify({ primaryRawData: base.raw_data }),
    };
    expect(getIbkrFundingPrimaryEvidence(wrapped)).toBeDefined();
  });
});
