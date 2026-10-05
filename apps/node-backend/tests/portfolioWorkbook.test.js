import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockLogger } from "./helpers/mockLogger.js";
import {
  writeSyntheticWorkbook,
  syntheticSaxoWorkbook,
} from "./helpers/saxoWorkbook.js";
vi.mock("../src/config/logger.js", () => ({ logger: mockLogger() }));
import {
  assertPortfolioUploadSupported,
  detectPortfolioFileFormat,
  readPortfolioWorkbook,
  isLikelyPortfolioFile,
} from "../src/lib/portfolioUpload.js";
import { parseSaxoTransactionHistory } from "../src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.js";
import { parseWithConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.js";

let directory;
let file;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "vision-workbook-test-"));
  file = path.join(directory, "extensionless-upload");
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe("portfolio XLSX upload and reader", () => {
  it("accepts portfolio CSV/XLSX file types and rejects legacy Excel or other files", () => {
    expect(
      isLikelyPortfolioFile({
        originalname: "history.xlsx",
        mimetype:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe(true);
    expect(
      isLikelyPortfolioFile({
        originalname: "history.CSV",
        mimetype: "text/plain",
      }),
    ).toBe(true);
    expect(
      isLikelyPortfolioFile({
        originalname: "history.xls",
        mimetype: "application/vnd.ms-excel",
      }),
    ).toBe(false);
    expect(
      isLikelyPortfolioFile({
        originalname: "history.xlsx",
        mimetype: "text/html",
      }),
    ).toBe(false);
  });
  it("detects content without an extension and preserves typed dates and exact numeric XML", async () => {
    await writeSyntheticWorkbook(file);
    expect(await detectPortfolioFileFormat(file)).toBe("xlsx");
    const sheets = await readPortfolioWorkbook(file);
    expect(sheets.map((sheet) => sheet.sheet)).toEqual([
      "Transacties",
      "_Transacties",
      "Bookings",
    ]);
    expect(sheets[0].data[1][1]).toEqual(new Date("2025-01-10T00:00:00Z"));
    expect(sheets[0].data[1][7]).toEqual({ type: "number", raw: "101" });
    expect(sheets[0].sourceFileHash).toMatch(/^[a-f0-9]{64}$/);
    await assertPortfolioUploadSupported(file, {
      format: "saxo_transaction_history",
    });
    await expect(assertPortfolioUploadSupported(file, {})).rejects.toThrow(
      /require.*Saxo/,
    );
  });
  it("rejects unrelated workbooks, legacy XLS, malformed ZIP, and excessive expansion", async () => {
    await writeSyntheticWorkbook(file, [
      { sheet: "Sheet1", headers: ["Name"], records: [{ Name: "Example" }] },
    ]);
    await expect(
      assertPortfolioUploadSupported(file, {
        format: "saxo_transaction_history",
      }),
    ).rejects.toThrow(/requires one Transacties/);
    await fs.writeFile(
      file,
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    );
    await expect(detectPortfolioFileFormat(file)).rejects.toThrow(/Legacy XLS/);
    await fs.writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await expect(readPortfolioWorkbook(file)).rejects.toThrow(/Invalid XLSX/);
    const bytes = await writeSyntheticWorkbook(file);
    const firstEntry = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(200 * 1024 * 1024, firstEntry + 24);
    await fs.writeFile(file, bytes);
    await expect(readPortfolioWorkbook(file)).rejects.toThrow(/safe limits/);
    const forgedSize = await writeSyntheticWorkbook(file);
    const firstDirectoryEntry = forgedSize.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    );
    forgedSize.writeUInt32LE(1, firstDirectoryEntry + 24);
    await fs.writeFile(file, forgedSize);
    await expect(readPortfolioWorkbook(file)).rejects.toThrow(/declared size/);
  });
});

describe("Saxo detailed workbook economics", () => {
  it("joins complete details and preserves trade fees, exchange tax, gross dividend and both withholding taxes", async () => {
    await writeSyntheticWorkbook(file);
    const rows = await parseWithConfig(file, {
      format: "saxo_transaction_history",
    });
    expect(rows).toHaveLength(4);
    expect(rows.skipped).toBe(0);
    expect(rows[0]).toMatchObject({
      typeRaw: "Buy",
      units: 10,
      pricePerUnit: 18,
      amount: 180,
      fees: 1,
      taxes: 0.63,
      currency: "EUR",
      sourceId: "101",
      sourceAccountIdentity: "ACC-1",
    });
    expect(rows[1]).toMatchObject({
      typeRaw: "Dividend",
      amount: 10,
      fees: 0,
      taxes: 4.05,
      currency: "EUR",
      sourceId: "102",
    });
    expect(rows[2]).toMatchObject({
      typeRaw: "Deposit",
      amount: 500,
      symbolRaw: "",
      nameRaw: "",
    });
    expect(rows[3]).toMatchObject({ typeRaw: "Withdrawal", amount: 50 });
    const provenance = JSON.parse(rows[0].rawData);
    expect(provenance.records.map((record) => record.sheet)).toEqual([
      "Transacties",
      "_Transacties",
      "Bookings",
      "Bookings",
      "Bookings",
    ]);
    expect(rows[0].rawData).toContain("Koop 10 @ 20.00 USD");
    expect(rows[0].rawData).toContain('"raw":"200"');
    expect(provenance.records[0].cells[1]).toEqual({
      type: "date",
      value: "2025-01-10T00:00:00.000Z",
    });
    expect(rows[0].amount + rows[0].fees + rows[0].taxes).toBeCloseTo(
      181.63,
      8,
    );
    expect(rows[1].amount - rows[1].taxes).toBeCloseTo(5.95, 8);
  });
  it("uses booked gross and derives effective price when the export quote is rounded", async () => {
    const sheets = syntheticSaxoWorkbook();
    sheets[1].records[0]["Verhandelde waarde"] = 200.08;
    sheets[2].records[0].Boekingsbedrag = -180.072;
    sheets[0].records[0].Boekingsbedrag = -181.702;
    await writeSyntheticWorkbook(file, sheets);
    const [trade] = await parseSaxoTransactionHistory(file);
    expect(trade.amount).toBe(180.072);
    expect(trade.pricePerUnit).toBeCloseTo(18.0072, 8);
    expect(trade.rawData).toContain("Koop 10 @ 20.00 USD");
  });
  it.each([
    [
      "missing booking",
      (sheets) => sheets[2].records.shift(),
      /do not reconcile/,
    ],
    [
      "orphan booking",
      (sheets) => {
        sheets[2].records[0]["Bk Record Id"] = 999;
      },
      /orphaned/,
    ],
    [
      "duplicate main",
      (sheets) => sheets[0].records.push({ ...sheets[0].records[0] }),
      /duplicate transaction/,
    ],
    [
      "duplicate booking ID",
      (sheets) => {
        sheets[2].records[1]["Booking Id"] = "B-1";
      },
      /duplicate.*booking detail/,
    ],
    [
      "missing execution",
      (sheets) => {
        sheets[1].records = [];
      },
      /trade details are missing/,
    ],
    [
      "conflicting instrument",
      (sheets) => {
        sheets[2].records[0].Instrumentsymbool = "OTHER:xnas";
      },
      /conflict/,
    ],
    [
      "unsafe numeric identifier",
      (sheets) => {
        sheets[0].records[0]["Bk Record Id"] = {
          type: "number",
          raw: "9007199254740993",
        };
      },
      /unsafe numeric identifier/,
    ],
    [
      "bad date",
      (sheets) => {
        sheets[0].records[0].Transactiedatum = "invalid";
      },
      /invalid transaction date/,
    ],
  ])("rejects %s before returning rows", async (_label, mutate, error) => {
    const sheets = syntheticSaxoWorkbook();
    mutate(sheets);
    await writeSyntheticWorkbook(file, sheets);
    await expect(parseSaxoTransactionHistory(file)).rejects.toThrow(error);
  });
  it("keeps unsupported booking types visible for review", async () => {
    const sheets = syntheticSaxoWorkbook();
    sheets[2].records[0]["Amount Type"] = "Future corporate action";
    await writeSyntheticWorkbook(file, sheets);
    const rows = await parseSaxoTransactionHistory(file);
    expect(rows[0]).toMatchObject({
      typeRaw: "Unsupported Saxo event: booking detail",
      note: "Saxo workbook contains an unsupported booking amount type",
    });
  });
});
