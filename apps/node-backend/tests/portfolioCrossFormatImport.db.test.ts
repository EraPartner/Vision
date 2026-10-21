/**
 * Real-PostgreSQL imports of one broker history through more than one export
 * (ADR-236 amendment): the Saxo CSV and detailed XLSX transaction histories,
 * the IBKR Transaction History CSV and its funding workbook (.xls and .xlsx),
 * and manual cash entries. Every order and overlap must record each event
 * once, keep the workbook's own currency, repeat as a no-op and roll back.
 * All values are synthetic.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.ts";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { runPortfolioImportPipeline } from "../src/services/portfolioImportPipeline/index.ts";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.ts";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.ts";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.ts";
import {
  syntheticSaxoWorkbook,
  writeSyntheticWorkbook,
} from "./helpers/saxoWorkbook.ts";
import type { SyntheticSheet } from "./helpers/saxoWorkbook.ts";

const pool = getTestPool()!;
const describeDb = hasTestDatabase() ? describe : describe.skip;
const owned = { accounts: [] as number[], investments: [] as number[] };
let directory: string;

async function account(institution: string): Promise<number> {
  const id = Number(
    (
      await pool.query(
        "INSERT INTO accounts(name,institution,type,currency) VALUES($1,$2,'brokerage','EUR') RETURNING id",
        [`${institution.toUpperCase()} SYNTHETIC ${owned.accounts.length + 1}`, institution],
      )
    ).rows[0].id,
  );
  owned.accounts.push(id);
  return id;
}

async function investment(symbol: string, currency = "USD"): Promise<number> {
  const id = Number(
    (
      await pool.query(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES($1,$1,'stock',$2) RETURNING id",
        [symbol, currency],
      )
    ).rows[0].id,
  );
  owned.investments.push(id);
  return id;
}

async function stage(
  filePath: string,
  format:
    | "saxo_transaction_history"
    | "ibkr_transaction_history"
    | "ibkr_funding_history",
  accountId: number,
): Promise<number> {
  const staged = await runPortfolioImportPipeline({
    filePath,
    adapterName: format,
    customConfig: { format },
    defaultAssetClass: "stock",
    isBrokerage: true,
    accountId,
  });
  return staged.batchId;
}

async function commit(...batchIds: number[]) {
  return commitReviewedPortfolioImports({ batchIds });
}

/** Commit with the owner's choice for every selected statement. */
async function commitChoosing(
  adoptPolicy: "prefer_source" | "preserve_existing",
  ...batchIds: number[]
) {
  return commitReviewedPortfolioImports({
    batchIds,
    batchPolicies: batchIds.map((batchId) => ({ batchId, adoptPolicy })),
  });
}

async function blockerReasons(...batchIds: number[]) {
  const preview = await previewPortfolioImportReconciliation({ batchIds });
  return {
    ready: preview.ready,
    reasons: [...new Set(preview.blockers.map((blocker) => blocker.reason))],
  };
}

// ── Saxo ─────────────────────────────────────────────────────────────────

/** The synthetic Saxo history restricted to these booking record ids. */
function saxoSheets(records: number[]): SyntheticSheet[] {
  return syntheticSaxoWorkbook().map((sheet) => ({
    ...sheet,
    records: sheet.records.filter((record) =>
      records.includes(Number(record["Bk Record Id"])),
    ),
  }));
}

/**
 * The deleted companion suite's 17 events: three trades, nine cash dividends
 * (which the CSV cannot read) and five deposits, each with its own ids.
 */
function saxoSeventeen(): SyntheticSheet[] {
  const templateOf = (index: number) => (index < 3 ? 101 : index < 12 ? 102 : 103);
  return syntheticSaxoWorkbook().map((sheet) => ({
    ...sheet,
    records: Array.from({ length: 17 }, (_, index) =>
      sheet.records
        .filter((record) => Number(record["Bk Record Id"]) === templateOf(index))
        .map((record) => ({
          ...record,
          "Bk Record Id": 1000 + index,
          "Transactie-ID": templateOf(index) === 101 ? `TX-${index}` : "0",
          ...(record["Booking Id"] ? { "Booking Id": `${String(record["Booking Id"])}-${index}` } : {}),
          ...(record["Corporate action-Id"]
            ? { "Corporate action-Id": `${String(record["Corporate action-Id"])}-${index}` }
            : {}),
        })),
    ).flat(),
  }));
}

async function saxoXlsx(name: string, records: number[], sheets = saxoSheets(records)) {
  const file = path.join(directory, `${name}.xlsx`);
  await writeSyntheticWorkbook(file, sheets);
  return file;
}

/** The Transacties sheet as Saxo's CSV export writes it. */
async function saxoCsv(name: string, records: number[], sheets = saxoSheets(records)) {
  const [main] = sheets;
  const normalize = (header: string) => header.trim().replaceAll(" ", " ");
  const value = (cell: unknown) =>
    cell instanceof Date
      ? cell.toISOString().slice(0, 10).replaceAll("-", "/")
      : String(cell ?? "");
  const quote = (cell: string) => `"${cell.replaceAll('"', '""')}"`;
  const lines = [
    main!.headers.map((header) => quote(normalize(header))).join(","),
    ...main!.records.map((record) =>
      main!.headers
        .map((header) => quote(value(record[normalize(header)])))
        .join(","),
    ),
  ];
  const file = path.join(directory, `${name}.csv`);
  await fs.writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

// ── IBKR ─────────────────────────────────────────────────────────────────

const IBKR_HEADER =
  "Transaction History,Header,Date,Account,Description,Transaction Type,Symbol,Quantity,Price,Price Currency,Gross Amount ,Commission,Net Amount,Exchange Rate,Transaction Fees,Sub Type,Multiplier";
const IBKR_LINES = {
  buy: "Transaction History,Data,2026-01-02,U0000000,Example Corp purchase,Buy,EXM,2.0,10.0,USD,-17.0,-0.85,-17.85,0.85,-0.17,-,1",
  // 100 USD credited to a EUR-base account at 0.85.
  deposit:
    "Transaction History,Data,2026-01-05,U0000000,Cash deposit,Deposit,-,-,-,-,85.0,-,85.0,0.85,-,-,1",
  // The same 100 USD, booked three days after the workbook's request and receipt.
  depositLate:
    "Transaction History,Data,2026-01-08,U0000000,Cash deposit,Deposit,-,-,-,-,85.0,-,85.0,0.85,-,-,1",
  // Fifteen days later: too far to be the same movement.
  depositFar:
    "Transaction History,Data,2026-01-20,U0000000,Cash deposit,Deposit,-,-,-,-,85.0,-,85.0,0.85,-,-,1",
  // The deleted funding-lifecycle suite's values: 100 USD booked as 80 EUR.
  deposit80:
    "Transaction History,Data,2026-01-05,U0000000,Cash deposit,Deposit,-,-,-,-,80.0,-,80.0,0.8,-,-,1",
  withdrawal:
    "Transaction History,Data,2026-01-06,U0000000,Cash withdrawal,Withdrawal,-,-,-,-,-25.0,-,-25.0,1.0,-,-,1",
};

/** IBKR identifies history by its own account ID, across Vision accounts. */
async function ibkrCsv(
  name: string,
  lines: (keyof typeof IBKR_LINES)[],
  brokerAccount = "U0000000",
) {
  const file = path.join(directory, `${name}.csv`);
  await fs.writeFile(
    file,
    [
      "Statement,Header,Field Name,Field Value",
      "Statement,Data,Title,Transaction History",
      "Summary,Header,Field Name,Field Value",
      "Summary,Data,Base Currency,EUR",
      IBKR_HEADER,
      ...lines.map((line) => IBKR_LINES[line].replace("U0000000", brokerAccount)),
    ].join("\n") + "\n",
  );
  return file;
}

const DEPOSIT_HEADER = [
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
const WITHDRAWAL_HEADER = [
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
const deposit = (date: string, reference: string, amount: string, status = "Available") => [
  date,
  reference,
  "Wire",
  "U0000000",
  "Synthetic Owner",
  "Synthetic Bank",
  null,
  null,
  date,
  null,
  null,
  null,
  amount,
  status,
];
const FUNDING = {
  usd: deposit("2026-01-05", "REF-1", "USD 100.00"),
  chf: deposit("2026-01-20", "REF-3", "CHF 50.00"),
  pending: deposit("2026-01-25", "REF-4", "USD 999.00", "Pending"),
  eur: [
    "2026-01-06",
    "REF-2",
    "Wire",
    "U0000000",
    "Synthetic Owner",
    "Synthetic Bank",
    "2026-01-06",
    "EUR 25.00",
    "Sent",
  ],
};

async function fundingWorkbook(
  name: string,
  bookType: "xls" | "xlsx",
  deposits: (keyof typeof FUNDING)[],
  withdrawals: (keyof typeof FUNDING)[],
  brokerAccount = "U0000000",
) {
  const row = (key: keyof typeof FUNDING) =>
    FUNDING[key].map((cell) => (cell === "U0000000" ? brokerAccount : cell));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([DEPOSIT_HEADER, ...deposits.map(row)]),
    "Deposit",
  );
  if (withdrawals.length > 0)
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        WITHDRAWAL_HEADER,
        ...withdrawals.map(row),
      ]),
      "Withdrawal",
    );
  const file = path.join(directory, `${name}.${bookType}`);
  await fs.writeFile(
    file,
    XLSX.write(workbook, { type: "buffer", bookType }) as Buffer,
  );
  return file;
}

// ── Ledger reads ─────────────────────────────────────────────────────────

async function cash(accountId: number) {
  return (
    await pool.query(
      `SELECT to_char(date,'YYYY-MM-DD') AS date, amount::text AS amount, currency
         FROM transactions WHERE account_id=$1 ORDER BY date, id`,
      [accountId],
    )
  ).rows;
}

async function cashTotals(accountId: number) {
  return Object.fromEntries(
    (
      await pool.query(
        `SELECT currency, SUM(amount)::text AS total FROM transactions
          WHERE account_id=$1 GROUP BY currency ORDER BY currency`,
        [accountId],
      )
    ).rows.map((row) => [row.currency, row.total]),
  );
}

async function portfolio(investmentId: number) {
  return (
    await pool.query(
      `SELECT type, to_char(date,'YYYY-MM-DD') AS date, units::text AS units,
          amount::text AS amount, fees::text AS fees, taxes::text AS taxes, currency
         FROM portfolio_transactions WHERE investment_id=$1 ORDER BY date, id`,
      [investmentId],
    )
  ).rows;
}

async function batchState(batchId: number) {
  return (
    await pool.query(
      "SELECT status, rows_imported, rows_duplicate, rows_error FROM portfolio_import_batches WHERE id=$1",
      [batchId],
    )
  ).rows[0];
}

async function cleanup() {
  if (owned.investments.length)
    await pool.query(
      "DELETE FROM portfolio_transactions WHERE investment_id=ANY($1::integer[])",
      [owned.investments],
    );
  if (owned.accounts.length) {
    const batches = `SELECT id FROM portfolio_import_batches WHERE account_id=ANY($1::integer[])`;
    await pool.query(
      `DELETE FROM portfolio_import_reconciliation_journal WHERE previous_entry_id IS NOT NULL AND batch_id IN (${batches})`,
      [owned.accounts],
    );
    await pool.query(
      `DELETE FROM portfolio_import_reconciliation_journal WHERE batch_id IN (${batches})`,
      [owned.accounts],
    );
    await pool.query(
      "DELETE FROM transactions WHERE account_id=ANY($1::integer[])",
      [owned.accounts],
    );
    await pool.query(
      "DELETE FROM portfolio_import_batches WHERE account_id=ANY($1::integer[])",
      [owned.accounts],
    );
  }
  if (owned.investments.length)
    await pool.query("DELETE FROM investments WHERE id=ANY($1::integer[])", [
      owned.investments,
    ]);
  if (owned.accounts.length)
    await pool.query("DELETE FROM accounts WHERE id=ANY($1::integer[])", [
      owned.accounts,
    ]);
  owned.accounts.length = 0;
  owned.investments.length = 0;
}

// The synthetic Saxo history: 101 buy, 102 dividend, 103 deposit, 104 withdrawal.
const ALL = [101, 102, 103, 104];
const XLSX_BUY = {
  type: "buy",
  date: "2025-01-10",
  units: "10.00000000",
  amount: "180.0000",
  fees: "1.0000",
  taxes: "0.6300",
  currency: "EUR",
};
const CSV_BUY = {
  type: "buy",
  date: "2025-01-10",
  units: "10.00000000",
  currency: "USD",
};
const DIVIDEND = {
  type: "dividend",
  date: "2025-01-10",
  units: null,
  amount: "10.0000",
  fees: "0.0000",
  taxes: "4.0500",
  currency: "EUR",
};
const SAXO_CASH = [
  { date: "2025-01-10", amount: "500.0000", currency: "EUR" },
  { date: "2025-01-10", amount: "-50.0000", currency: "EUR" },
];

describeDb("one broker history through more than one export", () => {
  beforeAll(async () => {
    await acquireDbSuiteLock();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "vision-cross-format-"));
  }, 180000);
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await fs.rm(directory, { recursive: true, force: true });
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  describe("Saxo CSV and XLSX", () => {
    it("imports the XLSX alone and repeats it as a no-op", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      const file = await saxoXlsx("saxo-all", ALL);
      expect(await commit(await stage(file, "saxo_transaction_history", sleeve))).toMatchObject({
        imported: 4,
        errors: 0,
      });
      expect(await portfolio(exm)).toEqual([XLSX_BUY, DIVIDEND]);
      expect(await cash(sleeve)).toEqual(SAXO_CASH);
      const repeat = await stage(file, "saxo_transaction_history", sleeve);
      expect(await commit(repeat)).toMatchObject({ imported: 0, duplicates: 4 });
      expect(await portfolio(exm)).toEqual([XLSX_BUY, DIVIDEND]);
      expect(await cashTotals(sleeve)).toEqual({ EUR: "450.0000" });
    });

    it("keeps a CSV dividend blocked until its workbook is imported", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      const csv = await stage(await saxoCsv("saxo-all", ALL), "saxo_transaction_history", sleeve);
      // The unsupported dividend row is reported, not dropped.
      await expect(commit(csv)).rejects.toMatchObject({
        details: { reason: "incomplete_source" },
      });
      expect(await portfolio(exm)).toEqual([]);
      expect(await cash(sleeve)).toEqual([]);
    });

    it("records each event once when the CSV comes first and the XLSX second", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      const csvFile = await saxoCsv("saxo-no-dividend", [101, 103, 104]);
      await commit(await stage(csvFile, "saxo_transaction_history", sleeve));
      const xlsxFile = await saxoXlsx("saxo-all", ALL);
      const workbook = await stage(xlsxFile, "saxo_transaction_history", sleeve);
      const preview = await previewPortfolioImportReconciliation({ batchIds: [workbook] });
      expect(preview).toMatchObject({ ready: true, summary: { insert: 1, duplicate: 3, cash: 0 } });
      expect(await commit(workbook)).toMatchObject({ imported: 1, duplicates: 3, errors: 0 });
      // The CSV buy stays as recorded; the workbook adds only the dividend.
      expect(await portfolio(exm)).toEqual([
        expect.objectContaining(CSV_BUY),
        DIVIDEND,
      ]);
      expect(await cash(sleeve)).toEqual(SAXO_CASH);
      // Both files again, in either order, change nothing.
      await commit(await stage(xlsxFile, "saxo_transaction_history", sleeve));
      await commit(await stage(csvFile, "saxo_transaction_history", sleeve));
      expect(await portfolio(exm)).toHaveLength(2);
      expect(await cashTotals(sleeve)).toEqual({ EUR: "450.0000" });
    });

    describe("a CSV batch recorded before batches kept their source columns", () => {
      const forgetColumns = (batchId: number) =>
        pool.query(
          "UPDATE portfolio_import_batches SET custom_config = custom_config - 'source_columns' WHERE id=$1",
          [batchId],
        );

      it("recognises the workbook's events by the CSV's booking record ids", async () => {
        const sleeve = await account("Saxo");
        const exm = await investment("EXM");
        const csv = await stage(await saxoCsv("saxo-no-dividend", [101, 103, 104]), "saxo_transaction_history", sleeve);
        await commit(csv);
        await forgetColumns(csv);
        const workbook = await stage(await saxoXlsx("saxo-all", ALL), "saxo_transaction_history", sleeve);
        expect(await blockerReasons(workbook)).toEqual({ ready: true, reasons: [] });
        expect(await commit(workbook)).toMatchObject({ imported: 1, duplicates: 3, errors: 0 });
        expect(await portfolio(exm)).toEqual([expect.objectContaining(CSV_BUY), DIVIDEND]);
        expect(await cash(sleeve)).toEqual(SAXO_CASH);
      });

      it("keeps asking about cash rows whose CSV id is their Booking Id", async () => {
        const sleeve = await account("Saxo");
        const blank = saxoSheets([103, 104]).map((sheet) => ({
          ...sheet,
          records: sheet.records.map((record) => ({ ...record, "Bk Record Id": "", "Transactie-ID": "" })),
        }));
        const csv = await stage(await saxoCsv("cash-blank", [], blank), "saxo_transaction_history", sleeve);
        await commit(csv);
        await forgetColumns(csv);
        const workbook = await stage(await saxoXlsx("cash", [103, 104]), "saxo_transaction_history", sleeve);
        expect(await blockerReasons(workbook)).toEqual({
          ready: false,
          reasons: ["cross_format_identity_missing"],
        });
        expect(await cash(sleeve)).toEqual(SAXO_CASH);
      });

      it("keeps asking when the workbook's record id is also its Transactie-ID", async () => {
        const sleeve = await account("Saxo");
        await investment("EXM");
        const sameIds = (blankRecord: boolean) =>
          saxoSheets([101]).map((sheet) => ({
            ...sheet,
            records: sheet.records.map((record) => ({
              ...record,
              "Transactie-ID": "101",
              ...(blankRecord ? { "Bk Record Id": "" } : {}),
            })),
          }));
        // The CSV's id is its Transactie-ID; nothing shows it is the record.
        const csv = await stage(await saxoCsv("trade", [], sameIds(true)), "saxo_transaction_history", sleeve);
        await commit(csv);
        await forgetColumns(csv);
        const workbook = await stage(await saxoXlsx("trade", [], sameIds(false)), "saxo_transaction_history", sleeve);
        expect(await blockerReasons(workbook)).toEqual({
          ready: false,
          reasons: ["cross_format_identity_missing"],
        });
      });
    });

    it("records each event once when the XLSX comes first and the CSV second", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      const xlsxFile = await saxoXlsx("saxo-all", ALL);
      const workbook = await stage(xlsxFile, "saxo_transaction_history", sleeve);
      await commit(workbook);
      const csvFile = await saxoCsv("saxo-all", ALL);
      const csv = await stage(csvFile, "saxo_transaction_history", sleeve);
      // The unsupported CSV dividend is the workbook's dividend, not an error.
      expect(await commit(csv)).toMatchObject({ imported: 0, duplicates: 4, errors: 0 });
      expect(await batchState(csv)).toEqual({
        status: "complete",
        rows_imported: 0,
        rows_duplicate: 4,
        rows_error: 0,
      });
      expect(await portfolio(exm)).toEqual([XLSX_BUY, DIVIDEND]);
      expect(await cash(sleeve)).toEqual(SAXO_CASH);
      await commit(await stage(csvFile, "saxo_transaction_history", sleeve));
      expect(await portfolio(exm)).toEqual([XLSX_BUY, DIVIDEND]);
      // Rolling back the CSV removes nothing it did not record.
      await rollbackBatch(csv);
      expect(await portfolio(exm)).toEqual([XLSX_BUY, DIVIDEND]);
      await rollbackBatch(workbook);
      expect(await portfolio(exm)).toEqual([]);
      expect(await cash(sleeve)).toEqual([]);
    });

    it("prefers the workbook when both exports are committed together", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      const csv = await stage(await saxoCsv("saxo-all", ALL), "saxo_transaction_history", sleeve);
      const workbook = await stage(await saxoXlsx("saxo-all", ALL), "saxo_transaction_history", sleeve);
      const preview = await previewPortfolioImportReconciliation({ batchIds: [csv, workbook] });
      expect(preview).toMatchObject({
        ready: true,
        summary: { insert: 2, cash: 2, duplicate_source: 4 },
      });
      const result = await commit(csv, workbook);
      expect(result).toMatchObject({ imported: 4, duplicates: 4, errors: 0 });
      expect(result.batches.find((item) => item.batch_id === csv)).toMatchObject({
        imported: 0,
        duplicates: 4,
      });
      expect(await portfolio(exm)).toEqual([XLSX_BUY, DIVIDEND]);
      expect(await cash(sleeve)).toEqual(SAXO_CASH);
    });

    it("records a partial-period overlap once", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      await commit(
        await stage(await saxoCsv("saxo-early", [101, 103]), "saxo_transaction_history", sleeve),
      );
      await commit(
        await stage(await saxoXlsx("saxo-late", [102, 103, 104]), "saxo_transaction_history", sleeve),
      );
      expect(await portfolio(exm)).toEqual([
        expect.objectContaining(CSV_BUY),
        DIVIDEND,
      ]);
      expect(await cash(sleeve)).toEqual(SAXO_CASH);
    });

    it("settles all 17 CSV companion records with nine cleared errors and no extra financial rows", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      const sheets = saxoSeventeen();
      const stageBoth = async (name: string) => ({
        csvBatch: await stage(await saxoCsv(name, [], sheets), "saxo_transaction_history", sleeve),
        bookBatch: await stage(await saxoXlsx(name, [], sheets), "saxo_transaction_history", sleeve),
      });
      const { csvBatch, bookBatch } = await stageBoth("saxo-17");
      expect(await batchState(csvBatch)).toMatchObject({ rows_error: 9 });
      await expect(commit(csvBatch)).rejects.toMatchObject({ details: { reason: "incomplete_source" } });
      const preview = await previewPortfolioImportReconciliation({ batchIds: [csvBatch, bookBatch] });
      expect(preview).toMatchObject({ ready: true, summary: { insert: 12, cash: 5, duplicate_source: 17 } });
      const committed = await commit(csvBatch, bookBatch);
      expect(committed).toMatchObject({ imported: 17, duplicates: 17, adopted: 0, errors: 0 });
      expect(committed.batches.find((row) => row.batch_id === csvBatch)).toMatchObject({
        imported: 0,
        duplicates: 17,
        errors: 0,
      });
      expect(await batchState(csvBatch)).toEqual({
        status: "complete",
        rows_imported: 0,
        rows_duplicate: 17,
        rows_error: 0,
      });
      expect(
        (
          await pool.query(
            "SELECT status,committed_txn_id,error_message FROM portfolio_import_staging_rows WHERE batch_id=$1",
            [csvBatch],
          )
        ).rows.every(
          (row) => row.status === "duplicate" && row.committed_txn_id == null && row.error_message == null,
        ),
      ).toBe(true);
      const portfolioRows = await portfolio(exm);
      const cashRows = await cash(sleeve);
      expect(portfolioRows).toHaveLength(12);
      expect(cashRows).toHaveLength(5);
      const fresh = await stageBoth("saxo-17-again");
      const freshPreview = await previewPortfolioImportReconciliation({
        batchIds: [fresh.csvBatch, fresh.bookBatch],
      });
      expect(freshPreview).toMatchObject({ ready: true, summary: { insert: 0, duplicate: 17, cash: 0, duplicate_source: 17 } });
      expect(await commit(fresh.csvBatch, fresh.bookBatch)).toMatchObject({
        imported: 0,
        duplicates: 34,
        adopted: 0,
        errors: 0,
      });
      await rollbackBatch(csvBatch);
      expect(await portfolio(exm)).toEqual(portfolioRows);
      expect(await cash(sleeve)).toEqual(cashRows);
    });

    it("restores all companion statuses and error counters when a workbook insert fails", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      const sheets = saxoSeventeen();
      const csvBatch = await stage(await saxoCsv("saxo-17", [], sheets), "saxo_transaction_history", sleeve);
      const bookBatch = await stage(await saxoXlsx("saxo-17", [], sheets), "saxo_transaction_history", sleeve);
      const rows = async () =>
        (
          await pool.query(
            "SELECT to_jsonb(s) AS data FROM portfolio_import_staging_rows s WHERE batch_id=$1 ORDER BY row_index",
            [csvBatch],
          )
        ).rows;
      const before = await rows();
      const spy = vi
        .spyOn(portfolioTransactionService, "create")
        .mockRejectedValue(new Error("Synthetic companion sibling failure"));
      try {
        await expect(commit(csvBatch, bookBatch)).rejects.toMatchObject({
          details: { reason: "atomic_import_failed" },
        });
      } finally {
        spy.mockRestore();
      }
      expect(await rows()).toEqual(before);
      expect(await batchState(csvBatch)).toEqual({
        status: "awaiting_review",
        rows_imported: 0,
        rows_duplicate: 0,
        rows_error: 9,
      });
      expect(await portfolio(exm)).toEqual([]);
      expect(await cash(sleeve)).toEqual([]);
    });

    it("adopts a manual deposit instead of duplicating it and restores it on rollback", async () => {
      const sleeve = await account("Saxo");
      await investment("EXM");
      const manual = Number(
        (
          await pool.query(
            `INSERT INTO transactions(date,amount,currency,memo,account_id,recipient_id,is_active)
             VALUES('2025-01-10',500,'EUR','Manual deposit',$1,(SELECT id FROM recipients ORDER BY id LIMIT 1),true) RETURNING id`,
            [sleeve],
          )
        ).rows[0].id,
      );
      const file = await saxoXlsx("saxo-all", ALL);
      const workbook = await stage(file, "saxo_transaction_history", sleeve);
      expect(await commit(workbook)).toMatchObject({ imported: 3, adopted: 1 });
      expect(await cash(sleeve)).toEqual(SAXO_CASH);
      expect(
        (await pool.query("SELECT memo, dedup_fingerprint IS NOT NULL AS owned FROM transactions WHERE id=$1", [manual]))
          .rows[0],
      ).toEqual({ memo: "Manual deposit", owned: true });
      await commit(await stage(file, "saxo_transaction_history", sleeve));
      expect(await cashTotals(sleeve)).toEqual({ EUR: "450.0000" });
      await rollbackBatch(workbook);
      expect(
        (await pool.query("SELECT amount::text AS amount, dedup_fingerprint FROM transactions WHERE account_id=$1", [sleeve]))
          .rows,
      ).toEqual([{ amount: "500.0000", dedup_fingerprint: null }]);
    });
  });

  describe("IBKR Transaction History and funding workbook", () => {
    const NATIVE = [
      { date: "2026-01-05", amount: "100.0000", currency: "USD" },
      { date: "2026-01-06", amount: "-25.0000", currency: "EUR" },
      { date: "2026-01-20", amount: "50.0000", currency: "CHF" },
    ];

    it("corrects CSV deposits to their own currency and rolls the correction back", async () => {
      const sleeve = await account("IBKR");
      const exm = await investment("EXM");
      const csvFile = await ibkrCsv("ibkr", ["buy", "deposit", "withdrawal"]);
      const csv = await stage(csvFile, "ibkr_transaction_history", sleeve);
      await commit(csv);
      // IBKR trades stay in the portfolio ledger; only funding is cash.
      expect(await cash(sleeve)).toEqual([
        { date: "2026-01-05", amount: "85.0000", currency: "EUR" },
        { date: "2026-01-06", amount: "-25.0000", currency: "EUR" },
      ]);
      const fundingFile = await fundingWorkbook("funding", "xls", ["usd", "chf", "pending"], ["eur"]);
      const funding = await stage(fundingFile, "ibkr_funding_history", sleeve);
      expect(await commit(funding)).toMatchObject({ imported: 1, adopted: 2, errors: 0 });
      expect(await cash(sleeve)).toEqual(NATIVE);
      // Either file again is a no-op.
      expect(await commit(await stage(fundingFile, "ibkr_funding_history", sleeve))).toMatchObject({ imported: 0 });
      expect(await commit(await stage(csvFile, "ibkr_transaction_history", sleeve))).toMatchObject({ imported: 0 });
      expect(await cash(sleeve)).toEqual(NATIVE);
      expect(await portfolio(exm)).toHaveLength(1);
      // The CSV cannot be undone underneath the correction.
      await expect(rollbackBatch(csv)).rejects.toMatchObject({
        details: { reason: "stale_reconciliation_plan" },
      });
      await rollbackBatch(funding);
      expect(await cash(sleeve)).toEqual([
        { date: "2026-01-05", amount: "85.0000", currency: "EUR" },
        { date: "2026-01-06", amount: "-25.0000", currency: "EUR" },
      ]);
    });

    it("recognises CSV movements already recorded from an XLSX funding workbook", async () => {
      const sleeve = await account("IBKR");
      const exm = await investment("EXM");
      const fundingFile = await fundingWorkbook("funding", "xlsx", ["usd", "chf"], ["eur"]);
      expect(await commit(await stage(fundingFile, "ibkr_funding_history", sleeve))).toMatchObject({
        imported: 3,
      });
      const csvFile = await ibkrCsv("ibkr", ["buy", "deposit", "withdrawal"]);
      const csv = await stage(csvFile, "ibkr_transaction_history", sleeve);
      const preview = await previewPortfolioImportReconciliation({ batchIds: [csv] });
      expect(preview).toMatchObject({ ready: true, summary: { duplicate: 2 } });
      // The buy is new; the deposit and withdrawal are the workbook's rows.
      expect(await commit(csv)).toMatchObject({ imported: 1, duplicates: 2 });
      expect(await cash(sleeve)).toEqual(NATIVE);
      expect(await portfolio(exm)).toHaveLength(1);
      await commit(await stage(csvFile, "ibkr_transaction_history", sleeve));
      await commit(await stage(fundingFile, "ibkr_funding_history", sleeve));
      expect(await cash(sleeve)).toEqual(NATIVE);
      expect(await portfolio(exm)).toHaveLength(1);
    });

    it("corrects 80 EUR to USD 100 with truthful counts, keeps the comment and restores it", async () => {
      const sleeve = await account("IBKR");
      const csv = await stage(await ibkrCsv("ibkr80", ["deposit80"]), "ibkr_transaction_history", sleeve);
      await commit(csv);
      const [{ id }] = (await pool.query("SELECT id FROM transactions WHERE account_id=$1", [sleeve])).rows;
      await pool.query("UPDATE transactions SET comment='Keep user comment' WHERE id=$1", [id]);
      const fundingFile = await fundingWorkbook("funding80", "xls", ["usd"], []);
      const funding = await stage(fundingFile, "ibkr_funding_history", sleeve);
      expect((await previewPortfolioImportReconciliation({ batchIds: [funding] })).summary).toMatchObject({
        adopt: 1,
        insert: 0,
        cash: 0,
      });
      expect(await commit(funding)).toMatchObject({ adopted: 1, imported: 0, duplicates: 0, errors: 0 });
      expect(await batchState(funding)).toEqual({
        status: "complete",
        rows_imported: 0,
        rows_duplicate: 1,
        rows_error: 0,
      });
      const image = async () =>
        (
          await pool.query(
            "SELECT amount::text AS amount, currency, comment FROM transactions WHERE id=$1",
            [id],
          )
        ).rows[0];
      expect(await image()).toEqual({ amount: "100.0000", currency: "USD", comment: "Keep user comment" });
      // A repeat settles without a second journal entry and undoes cleanly.
      const repeated = await stage(fundingFile, "ibkr_funding_history", sleeve);
      expect(await commit(repeated)).toMatchObject({ adopted: 0, duplicates: 1, imported: 0 });
      expect(await rollbackBatch(repeated)).toMatchObject({ deleted: 0 });
      expect(await image()).toEqual({ amount: "100.0000", currency: "USD", comment: "Keep user comment" });
      await expect(rollbackBatch(csv)).rejects.toMatchObject({ status: 409 });
      expect(await image()).toEqual({ amount: "100.0000", currency: "USD", comment: "Keep user comment" });
      expect(await rollbackBatch(funding)).toMatchObject({ deleted: 0 });
      expect(await image()).toEqual({ amount: "80.0000", currency: "EUR", comment: "Keep user comment" });
      expect(await batchState(csv)).toMatchObject({ status: "complete", rows_imported: 1 });
    });

    it("neither overwrites nor duplicates a CSV deposit edited after import", async () => {
      const sleeve = await account("IBKR");
      await commit(await stage(await ibkrCsv("ibkr80", ["deposit80"]), "ibkr_transaction_history", sleeve));
      await pool.query("UPDATE transactions SET amount=81 WHERE account_id=$1", [sleeve]);
      const funding = await stage(
        await fundingWorkbook("funding80", "xlsx", ["usd"], []),
        "ibkr_funding_history",
        sleeve,
      );
      const preview = await previewPortfolioImportReconciliation({ batchIds: [funding] });
      expect(preview.ready).toBe(false);
      expect(JSON.stringify(preview.blockers)).toContain("cross_format_source_conflict");
      await expect(commit(funding)).rejects.toMatchObject({ status: 409 });
      expect(await cash(sleeve)).toEqual([{ date: "2026-01-05", amount: "81.0000", currency: "EUR" }]);
      expect(await batchState(funding)).toMatchObject({ rows_imported: 0, rows_duplicate: 0 });
    });

    it("rolls back every correction when a later cash update fails", async () => {
      const sleeves = [await account("IBKR"), await account("IBKR")];
      const fundings: number[] = [];
      for (const [index, sleeve] of sleeves.entries()) {
        const brokerAccount = `U000000${index + 1}`;
        await commit(
          await stage(
            await ibkrCsv(`ibkr80-${sleeve}`, ["deposit80"], brokerAccount),
            "ibkr_transaction_history",
            sleeve,
          ),
        );
        fundings.push(
          await stage(
            await fundingWorkbook(`funding80-${sleeve}`, "xls", ["usd"], [], brokerAccount),
            "ibkr_funding_history",
            sleeve,
          ),
        );
      }
      await pool.query(`CREATE FUNCTION synthetic_funding_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.account_id=${Number(sleeves[1])} AND NEW.currency='USD' THEN RAISE EXCEPTION 'Forced synthetic correction failure'; END IF; RETURN NEW; END $$`);
      await pool.query(
        "CREATE TRIGGER synthetic_funding_failure BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION synthetic_funding_failure()",
      );
      try {
        await expect(commit(...fundings)).rejects.toThrow("Forced synthetic correction failure");
      } finally {
        await pool.query(
          "DROP TRIGGER IF EXISTS synthetic_funding_failure ON transactions; DROP FUNCTION IF EXISTS synthetic_funding_failure()",
        );
      }
      for (const [index, sleeve] of sleeves.entries()) {
        expect(await cash(sleeve)).toEqual([{ date: "2026-01-05", amount: "80.0000", currency: "EUR" }]);
        expect(
          Number(
            (
              await pool.query(
                "SELECT count(*) AS count FROM portfolio_import_reconciliation_journal WHERE batch_id=$1",
                [fundings[index]],
              )
            ).rows[0].count,
          ),
        ).toBe(0);
        expect(await batchState(fundings[index]!)).toMatchObject({ rows_duplicate: 0 });
      }
    });

    it("prefers the funding workbook when both are committed together", async () => {
      const sleeve = await account("IBKR");
      await investment("EXM");
      const csv = await stage(await ibkrCsv("ibkr", ["deposit", "withdrawal"]), "ibkr_transaction_history", sleeve);
      const funding = await stage(
        await fundingWorkbook("funding", "xls", ["usd", "chf"], ["eur"]),
        "ibkr_funding_history",
        sleeve,
      );
      expect(await commit(csv, funding)).toMatchObject({ imported: 3, duplicates: 2 });
      expect(await cash(sleeve)).toEqual(NATIVE);
      expect(await cashTotals(sleeve)).toEqual({
        CHF: "50.0000",
        EUR: "-25.0000",
        USD: "100.0000",
      });
    });

    it("records a partial funding workbook beside the CSV once", async () => {
      const sleeve = await account("IBKR");
      await investment("EXM");
      await commit(
        await stage(await fundingWorkbook("funding", "xlsx", ["usd"], []), "ibkr_funding_history", sleeve),
      );
      await commit(
        await stage(await ibkrCsv("ibkr", ["deposit", "withdrawal"]), "ibkr_transaction_history", sleeve),
      );
      expect(await cash(sleeve)).toEqual([
        { date: "2026-01-05", amount: "100.0000", currency: "USD" },
        { date: "2026-01-06", amount: "-25.0000", currency: "EUR" },
      ]);
    });
  });

  describe("IBKR movements dated outside the workbook's request window", () => {
    const USD = { date: "2026-01-05", amount: "100.0000", currency: "USD" };
    const LATE_EUR = { date: "2026-01-08", amount: "85.0000", currency: "EUR" };
    const stageBoth = async (sleeve: number, format: "xls" | "xlsx" = "xls") => ({
      csv: await stage(await ibkrCsv("late", ["depositLate"]), "ibkr_transaction_history", sleeve),
      funding: await stage(
        await fundingWorkbook("late-funding", format, ["usd"], []),
        "ibkr_funding_history",
        sleeve,
      ),
    });

    it("blocks a near match in one review until the owner chooses", async () => {
      const sleeve = await account("IBKR");
      const { csv, funding } = await stageBoth(sleeve);
      expect(await blockerReasons(csv, funding)).toEqual({
        ready: false,
        reasons: ["funding_date_mismatch"],
      });
      await expect(commit(csv, funding)).rejects.toMatchObject({ status: 409 });
      expect(await cash(sleeve)).toEqual([]);
    });

    it("records one movement in its own currency when the owner pairs them", async () => {
      const sleeve = await account("IBKR");
      const { csv, funding } = await stageBoth(sleeve);
      const preview = await previewPortfolioImportReconciliation({
        batchIds: [csv, funding],
        batchPolicies: [
          { batchId: csv, adoptPolicy: "prefer_source" },
          { batchId: funding, adoptPolicy: "prefer_source" },
        ],
      });
      expect(preview).toMatchObject({ ready: true, summary: { duplicate_source: 1 } });
      expect(
        preview.actions.find((action) => action.action === "duplicate_source"),
      ).toMatchObject({ policy: "prefer_source", crossFormat: true });
      expect(await commitChoosing("prefer_source", csv, funding)).toMatchObject({
        imported: 1,
        duplicates: 1,
      });
      expect(await cash(sleeve)).toEqual([USD]);
      // The choice holds for repeats, with no policy given again.
      expect(
        await commit(
          await stage(await ibkrCsv("late", ["depositLate"]), "ibkr_transaction_history", sleeve),
        ),
      ).toMatchObject({ imported: 0, duplicates: 1 });
      expect(
        await commit(
          await stage(await fundingWorkbook("late-funding", "xlsx", ["usd"], []), "ibkr_funding_history", sleeve),
        ),
      ).toMatchObject({ imported: 0 });
      expect(await cash(sleeve)).toEqual([USD]);
    });

    it("records both movements when the owner keeps them apart", async () => {
      const sleeve = await account("IBKR");
      const { csv, funding } = await stageBoth(sleeve, "xlsx");
      expect(await commitChoosing("preserve_existing", csv, funding)).toMatchObject({
        imported: 2,
        duplicates: 0,
      });
      expect(await cash(sleeve)).toEqual([USD, LATE_EUR]);
      const repeats = [
        await stage(await ibkrCsv("late", ["depositLate"]), "ibkr_transaction_history", sleeve),
        await stage(await fundingWorkbook("late-funding", "xls", ["usd"], []), "ibkr_funding_history", sleeve),
      ];
      expect(await commit(...repeats)).toMatchObject({ imported: 0 });
      expect(await cash(sleeve)).toEqual([USD, LATE_EUR]);
    });

    it("blocks the funding workbook after the CSV, then corrects the CSV deposit on the pair choice", async () => {
      const sleeve = await account("IBKR");
      await commit(await stage(await ibkrCsv("late", ["depositLate"]), "ibkr_transaction_history", sleeve));
      const funding = await stage(
        await fundingWorkbook("late-funding", "xls", ["usd"], []),
        "ibkr_funding_history",
        sleeve,
      );
      expect(await blockerReasons(funding)).toEqual({
        ready: false,
        reasons: ["funding_date_mismatch"],
      });
      await expect(commit(funding)).rejects.toMatchObject({ status: 409 });
      expect(await cash(sleeve)).toEqual([LATE_EUR]);
      expect(await commitChoosing("prefer_source", funding)).toMatchObject({
        imported: 0,
        adopted: 1,
      });
      expect(await cash(sleeve)).toEqual([{ ...USD, date: "2026-01-08" }]);
      await rollbackBatch(funding);
      expect(await cash(sleeve)).toEqual([LATE_EUR]);
    });

    it("blocks the CSV after the funding workbook, then settles it on the pair choice", async () => {
      const sleeve = await account("IBKR");
      await commit(
        await stage(await fundingWorkbook("late-funding", "xlsx", ["usd"], []), "ibkr_funding_history", sleeve),
      );
      const csv = await stage(await ibkrCsv("late", ["depositLate"]), "ibkr_transaction_history", sleeve);
      expect(await blockerReasons(csv)).toEqual({
        ready: false,
        reasons: ["funding_date_mismatch"],
      });
      expect(await commitChoosing("prefer_source", csv)).toMatchObject({
        imported: 0,
        duplicates: 1,
      });
      expect(await cash(sleeve)).toEqual([USD]);
    });

    it("keeps the CSV beside the funding workbook on the keep choice", async () => {
      const sleeve = await account("IBKR");
      await commit(
        await stage(await fundingWorkbook("late-funding", "xlsx", ["usd"], []), "ibkr_funding_history", sleeve),
      );
      const csv = await stage(await ibkrCsv("late", ["depositLate"]), "ibkr_transaction_history", sleeve);
      expect(await commitChoosing("preserve_existing", csv)).toMatchObject({ imported: 1 });
      expect(await cash(sleeve)).toEqual([USD, LATE_EUR]);
    });

    it("treats movements more than ten days apart as separate", async () => {
      const sleeve = await account("IBKR");
      const csv = await stage(await ibkrCsv("far", ["depositFar"]), "ibkr_transaction_history", sleeve);
      const funding = await stage(
        await fundingWorkbook("far-funding", "xls", ["usd"], []),
        "ibkr_funding_history",
        sleeve,
      );
      expect(await blockerReasons(csv, funding)).toEqual({ ready: true, reasons: [] });
      expect(await commit(csv, funding)).toMatchObject({ imported: 2 });
    });
  });

  describe("Saxo CSV and XLSX rows without a booking record id", () => {
    /**
     * The CSV trade with zero Bk Record Id and Transactie-ID: no source
     * identity. The workbook always carries one, since it joins its sheets on it.
     */
    const unidentified = () =>
      saxoSheets([101]).map((sheet) => ({
        ...sheet,
        records: sheet.records.map((record) => ({
          ...record,
          "Bk Record Id": 0,
          "Transactie-ID": "0",
        })),
      }));
    const stageBoth = async (sleeve: number) => ({
      csv: await stage(await saxoCsv("zero", [], unidentified()), "saxo_transaction_history", sleeve),
      workbook: await stage(await saxoXlsx("zero", [101]), "saxo_transaction_history", sleeve),
    });

    it("blocks an otherwise identical pair in one review until the owner chooses", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      const { csv, workbook } = await stageBoth(sleeve);
      expect(await blockerReasons(csv, workbook)).toEqual({
        ready: false,
        reasons: ["cross_format_identity_missing"],
      });
      await expect(commit(csv, workbook)).rejects.toMatchObject({ status: 409 });
      expect(await portfolio(exm)).toEqual([]);
    });

    it("records the workbook trade once on the pair choice and keeps that choice for repeats", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      const { csv, workbook } = await stageBoth(sleeve);
      expect(await commitChoosing("prefer_source", csv, workbook)).toMatchObject({
        imported: 1,
        duplicates: 1,
      });
      expect(await portfolio(exm)).toEqual([XLSX_BUY]);
      expect(
        await commit(await stage(await saxoCsv("zero", [], unidentified()), "saxo_transaction_history", sleeve)),
      ).toMatchObject({ imported: 0, duplicates: 1 });
      expect(await portfolio(exm)).toEqual([XLSX_BUY]);
    });

    it("records both trades on the keep choice", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      const { csv, workbook } = await stageBoth(sleeve);
      expect(await commitChoosing("preserve_existing", csv, workbook)).toMatchObject({ imported: 2 });
      const trades = await portfolio(exm);
      expect(trades).toHaveLength(2);
      expect(trades).toEqual(expect.arrayContaining([expect.objectContaining(CSV_BUY), XLSX_BUY]));
    });

    it("blocks the CSV after the workbook, then settles it on the pair choice", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      await commit(await stage(await saxoXlsx("zero", [101]), "saxo_transaction_history", sleeve));
      const csv = await stage(await saxoCsv("zero", [], unidentified()), "saxo_transaction_history", sleeve);
      expect(await blockerReasons(csv)).toEqual({
        ready: false,
        reasons: ["cross_format_identity_missing"],
      });
      expect(await commitChoosing("prefer_source", csv)).toMatchObject({ imported: 0, duplicates: 1 });
      expect(await portfolio(exm)).toEqual([XLSX_BUY]);
    });

    it("blocks the workbook after the CSV, then records both on the keep choice", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      await commit(await stage(await saxoCsv("zero", [], unidentified()), "saxo_transaction_history", sleeve));
      const workbook = await stage(await saxoXlsx("zero", [101]), "saxo_transaction_history", sleeve);
      expect(await blockerReasons(workbook)).toEqual({
        ready: false,
        reasons: ["cross_format_identity_missing"],
      });
      expect(await commitChoosing("preserve_existing", workbook)).toMatchObject({ imported: 1 });
      expect(await portfolio(exm)).toHaveLength(2);
    });
  });

  describe("a later trade of the same size", () => {
    /** The 101 buy again as booking record 201, three days later. */
    const secondBuy = () =>
      saxoSheets([101]).map((sheet) => ({
        ...sheet,
        records: sheet.records.map((record) => ({
          ...record,
          "Bk Record Id": 201,
          "Transactie-ID": "TX-201",
          Transactiedatum: new Date("2025-01-13T00:00:00Z"),
          ...(record["Booking Id"] ? { "Booking Id": `${String(record["Booking Id"])}-201` } : {}),
        })),
      }));
    const SECOND_BUY = { ...XLSX_BUY, date: "2025-01-13" };

    it("imports a regular purchase beside an earlier one of the same size", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      await commit(await stage(await saxoXlsx("first", [101]), "saxo_transaction_history", sleeve));
      const second = await stage(await saxoXlsx("second", [], secondBuy()), "saxo_transaction_history", sleeve);
      expect(await blockerReasons(second)).toEqual({ ready: true, reasons: [] });
      expect(await commit(second)).toMatchObject({ imported: 1, duplicates: 0 });
      expect(await portfolio(exm)).toEqual([XLSX_BUY, SECOND_BUY]);
      // The same statement again is still recorded once.
      expect(
        await commit(await stage(await saxoXlsx("second", [], secondBuy()), "saxo_transaction_history", sleeve)),
      ).toMatchObject({ imported: 0, duplicates: 1 });
      expect(await portfolio(exm)).toHaveLength(2);
    });

    it("ignores a similar trade recorded on another account", async () => {
      const first = await account("Saxo");
      const other = await account("Saxo");
      const exm = await investment("EXM");
      await commit(await stage(await saxoXlsx("first", [101]), "saxo_transaction_history", first));
      const second = await stage(await saxoXlsx("second", [], secondBuy()), "saxo_transaction_history", other);
      expect(await blockerReasons(second)).toEqual({ ready: true, reasons: [] });
      expect(await commit(second)).toMatchObject({ imported: 1 });
      expect(await portfolio(exm)).toHaveLength(2);
    });

    it("asks about a similar trade the account already holds and follows the owner's choice", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      // A trade typed by hand on this account: no source id to tell them apart.
      await pool.query(
        `INSERT INTO portfolio_transactions(investment_id,account_id,type,date,units,price_per_unit,amount,fees,taxes,currency)
         VALUES($1,$2,'buy','2025-01-12',10,18,180,1,0.63,'EUR')`,
        [exm, sleeve],
      );
      const [{ id: manual }] = (
        await pool.query("SELECT id FROM portfolio_transactions WHERE investment_id=$1", [exm])
      ).rows;
      const second = await stage(await saxoXlsx("second", [], secondBuy()), "saxo_transaction_history", sleeve);
      const preview = await previewPortfolioImportReconciliation({ batchIds: [second] });
      expect(preview.blockers).toEqual([
        expect.objectContaining({
          reason: "existing_assigned_or_imported_history",
          candidateTransactionIds: [manual],
        }),
      ]);
      await expect(commit(second)).rejects.toMatchObject({ status: 409 });
      const rowId = preview.blockers[0]!.rowId;
      expect(
        await commitReviewedPortfolioImports({
          batchIds: [second],
          rowChoices: [{ batchId: second, rowId, choice: "same_transaction" }],
        }),
      ).toMatchObject({ imported: 0, duplicates: 1 });
      expect(await portfolio(exm)).toHaveLength(1);

      const again = await stage(await saxoXlsx("second", [], secondBuy()), "saxo_transaction_history", sleeve);
      const [blocker] = (await previewPortfolioImportReconciliation({ batchIds: [again] })).blockers;
      expect(
        await commitReviewedPortfolioImports({
          batchIds: [again],
          rowChoices: [{ batchId: again, rowId: blocker!.rowId, choice: "keep_both" }],
        }),
      ).toMatchObject({ imported: 1, duplicates: 0 });
      expect(await portfolio(exm)).toHaveLength(2);
    });

    it("asks about a Saxo trade that a generic CSV with its own ids carries again", async () => {
      const sleeve = await account("Saxo");
      const exm = await investment("EXM");
      await commit(await stage(await saxoXlsx("first", [101]), "saxo_transaction_history", sleeve));
      const [{ id: recorded }] = (
        await pool.query("SELECT id FROM portfolio_transactions WHERE investment_id=$1", [exm])
      ).rows;
      const file = path.join(directory, "tracker.csv");
      await fs.writeFile(
        file,
        "Id,Date,Type,Symbol,Units,Price,Amount,Fees,Taxes,Currency\nT-9,2025-01-10,buy,EXM,10,18,180,1,0.63,EUR\n",
      );
      const generic = (
        await runPortfolioImportPipeline({
          filePath: file,
          adapterName: "portfolio_generic",
          customConfig: {
            date_format: "%Y-%m-%d",
            column_mapping: {
              date: "Date",
              type: "Type",
              symbol: "Symbol",
              units: "Units",
              price: "Price",
              amount: "Amount",
              fees: "Fees",
              taxes: "Taxes",
              currency: "Currency",
              source_id: "Id",
            },
          },
          defaultAssetClass: "stock",
          isBrokerage: true,
          accountId: sleeve,
        })
      ).batchId;
      const preview = await previewPortfolioImportReconciliation({ batchIds: [generic] });
      expect(preview.summary.insert).toBe(0);
      expect(preview.blockers).toEqual([
        expect.objectContaining({
          reason: "existing_assigned_or_imported_history",
          candidateTransactionIds: [Number(recorded)],
        }),
      ]);
      await expect(commit(generic)).rejects.toMatchObject({ status: 409 });
      expect(await portfolio(exm)).toHaveLength(1);
    });
  });

  describe("Saxo CSV deposits and withdrawals without a booking record id", () => {
    /** The CSV cash rows with a blank Bk Record Id, optionally keeping Booking Id. */
    const blankRecord = (keepBookingId: boolean) =>
      saxoSheets([103, 104]).map((sheet) => ({
        ...sheet,
        records: sheet.records.map((record) => ({
          ...record,
          "Bk Record Id": "",
          "Transactie-ID": "",
          ...(keepBookingId ? {} : { "Booking Id": "" }),
        })),
      }));

    for (const [variant, keepBookingId] of [
      ["every id blank", false],
      ["only a Booking Id", true],
    ] as const) {
      it(`never records the movements twice after the workbook (${variant})`, async () => {
        const sleeve = await account("Saxo");
        expect(
          await commit(await stage(await saxoXlsx("cash", [103, 104]), "saxo_transaction_history", sleeve)),
        ).toMatchObject({ imported: 2 });
        const csv = await stage(
          await saxoCsv("cash-blank", [], blankRecord(keepBookingId)),
          "saxo_transaction_history",
          sleeve,
        );
        expect(await blockerReasons(csv)).toEqual({
          ready: false,
          reasons: ["cross_format_identity_missing"],
        });
        await expect(commit(csv)).rejects.toMatchObject({ status: 409 });
        expect(await cash(sleeve)).toEqual(SAXO_CASH);
        expect(await commitChoosing("prefer_source", csv)).toMatchObject({
          imported: 0,
          duplicates: 2,
        });
        expect(await cash(sleeve)).toEqual(SAXO_CASH);
      });
    }

    it("blocks the pair in one review and records the workbook once on the pair choice", async () => {
      const sleeve = await account("Saxo");
      const csv = await stage(
        await saxoCsv("cash-blank", [], blankRecord(true)),
        "saxo_transaction_history",
        sleeve,
      );
      const workbook = await stage(
        await saxoXlsx("cash", [103, 104]),
        "saxo_transaction_history",
        sleeve,
      );
      expect(await blockerReasons(csv, workbook)).toEqual({
        ready: false,
        reasons: ["cross_format_identity_missing"],
      });
      expect(await commitChoosing("prefer_source", csv, workbook)).toMatchObject({
        imported: 2,
        duplicates: 2,
      });
      expect(await cash(sleeve)).toEqual(SAXO_CASH);
    });

    it("records both on the keep choice", async () => {
      const sleeve = await account("Saxo");
      await commit(await stage(await saxoXlsx("cash", [103, 104]), "saxo_transaction_history", sleeve));
      const csv = await stage(
        await saxoCsv("cash-blank", [], blankRecord(false)),
        "saxo_transaction_history",
        sleeve,
      );
      expect(await commitChoosing("preserve_existing", csv)).toMatchObject({ imported: 2 });
      expect(await cash(sleeve)).toHaveLength(4);
    });
  });
});
