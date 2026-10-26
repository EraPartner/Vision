import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ibkrFundingFactsFromRawData,
  parseIbkrFundingHistory,
} from "../src/services/portfolioImportPipeline/ibkrFundingHistoryAdapter.ts";
import { assertPortfolioUploadSupported } from "../src/services/portfolioImportPipeline/uploadSupport.ts";
import { must } from "./helpers/must.ts";

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
const deposit = (overrides: SourceRecord = {}): SourceRecord => ({
  "Request Date": "2025-01-02",
  "Reference Number": "SYNTHETIC-DEP-1",
  Method: "Wire",
  "Account ID": "U0000000",
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
  "Account ID": "U0000000",
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
  for (const source of sheets)
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        source.headers,
        ...source.records.map((record) =>
          source.headers.map((key) => record[key] ?? ""),
        ),
      ]),
      source.name,
    );
  mutate?.(workbook);
  // The xlsx typings declare `write` as returning `any`.
  const bytes: unknown = XLSX.write(workbook, {
    type: "buffer",
    bookType: format,
  });
  if (!Buffer.isBuffer(bytes)) throw new Error("Expected a buffer workbook");
  await fs.writeFile(file, bytes);
}

describe("IBKR funding history workbook", () => {
  it.each(["biff8", "xlsx"] as const)(
    "reads each movement in its own currency from %s",
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
        sourceAccountIdentity: "U0000000",
        sourceId: "SYNTHETIC-DEP-1",
        fxRateToEur: null,
      });
      expect(rows[1]).toMatchObject({
        typeRaw: "Withdrawal",
        amount: 25.4,
        currency: "EUR",
      });
      expect(must(rows[1], "rows[1]").date).toEqual(new Date("2025-01-07T00:00:00Z"));
      const envelope: unknown = JSON.parse(must(rows[0], "rows[0]").rawData);
      expect(envelope).toMatchObject({
        schema: "ibkr_funding_workbook_row",
        version: 1,
        sheet: "Deposit",
        row_number: 2,
        source_format: format === "biff8" ? "xls" : "xlsx",
        columns: DEPOSIT_HEADERS,
      });
      expect(ibkrFundingFactsFromRawData(must(rows[1], "rows[1]").rawData)).toMatchObject({
        type: "withdrawal",
        date: "2025-01-07",
        completedDate: "2025-01-08",
        amount: "25.4",
        currency: "EUR",
        sourceAccount: "U0000000",
        sourceId: "SYNTHETIC-WITH-1",
      });
    },
  );

  it("skips requests that never moved money and counts them", async () => {
    await writeWorkbook([
      sheet("Deposit", DEPOSIT_HEADERS, [
        deposit(),
        deposit({ "Reference Number": "SYNTHETIC-DEP-2", Status: "Pending" }),
        deposit({ "Reference Number": "SYNTHETIC-DEP-3", Status: "Rejected" }),
      ]),
    ]);
    const rows = await parseIbkrFundingHistory(file);
    expect(rows.map((row) => row.sourceId)).toEqual(["SYNTHETIC-DEP-1"]);
    expect(rows.skipped).toBe(2);
  });

  it("accepts any funding method, a masked account and a blank bank", async () => {
    await writeWorkbook([
      sheet("Deposit", DEPOSIT_HEADERS, [
        deposit({
          Method: "ACH",
          "Account ID": "U***0000",
          "Delivering Institution": "",
          "Date Received": "",
        }),
      ]),
    ]);
    const [row] = await parseIbkrFundingHistory(file);
    expect(ibkrFundingFactsFromRawData(must(row, "row").rawData)).toMatchObject({
      method: "ACH",
      sourceAccount: "U***0000",
      institution: undefined,
      completedDate: "2025-01-02",
    });
  });

  it.each([
    [{ Status: "Mystery" }, /unknown funding status/],
    [{ Amount: "1234.56" }, /amount with its currency/],
    [{ Amount: "$ 1,234.56" }, /amount with its currency/],
    [{ Amount: "ZZZ 1,234.56" }, /amount with its currency/],
    [{ Amount: "USD 1.234,56" }, /amount with its currency/],
    [{ Amount: "USD -1.00" }, /amount with its currency/],
    [{ Amount: "USD 0.00" }, /funding amount/],
    [{ "Request Date": "2025-02-30" }, /invalid calendar/],
    [{ "Date Received": "2025-01-01" }, /inconsistent request/],
    [{ "Account ID": "" }, /missing Account ID/],
    [{ "Reference Number": "" }, /missing Reference Number/],
  ])("rejects a row it cannot read safely", async (fields, error) => {
    await writeWorkbook([sheet("Deposit", DEPOSIT_HEADERS, [deposit(fields)])]);
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow(error);
  });

  it("rejects duplicate references and mixed accounts", async () => {
    await writeWorkbook([sheet("Deposit", DEPOSIT_HEADERS, [deposit(), deposit()])]);
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow(/duplicate/);
    await writeWorkbook([
      sheet("Deposit", DEPOSIT_HEADERS, [
        deposit(),
        deposit({ "Reference Number": "SYNTHETIC-DEP-2", "Account ID": "U0000001" }),
      ]),
    ]);
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow(/one broker account/);
  });

  it("rejects changed headers, formulas, hidden sheets and unrelated files", async () => {
    await writeWorkbook([
      sheet("Deposit", [...DEPOSIT_HEADERS.slice(0, -1), "Amount"], [deposit()]),
    ]);
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow(/complete header/);
    await writeWorkbook([sheet("Unrelated", DEPOSIT_HEADERS, [deposit()])]);
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow();
    await writeWorkbook(undefined, "xlsx", (workbook) => {
      must(workbook.Sheets.Deposit, "workbook.Sheets.Deposit").M2 = { t: "s", v: "USD 1,234.56", f: '"USD 1,234.56"' };
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
    await expect(parseIbkrFundingHistory(file)).rejects.toThrow();
    await fs.writeFile(file, "<html>not a native workbook</html>");
    await expect(
      assertPortfolioUploadSupported(file, { format: "ibkr_funding_history" }),
    ).rejects.toThrow(/XLS/);
  });
});
