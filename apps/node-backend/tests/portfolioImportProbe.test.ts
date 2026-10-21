import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import { probePortfolioImport } from "../src/services/portfolioImportProbe.ts";

const files: string[] = [];
afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => fs.unlink(file)));
});
async function probe(
  bytes: string | Buffer,
  name = "synthetic.csv",
  options = {},
) {
  const file = path.join(os.tmpdir(), `vision-probe-${crypto.randomUUID()}`);
  files.push(file);
  await fs.writeFile(file, bytes);
  return probePortfolioImport(file, name, {
    encoding: "utf-8",
    skipRows: 0,
    ...options,
  });
}
const headers = [
  "DateTime",
  "HIN",
  "Currency_Code",
  "Transaction_Type",
  "Transaction_ID",
  "Order_ID",
  "Starting_Balance",
  "Closing_Balance",
];
const fundingHeaders = [
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
function fundingWorkbook(
  type: "xls" | "xlsx",
  mutate?: (sheet: XLSX.WorkSheet, workbook: XLSX.WorkBook) => void,
) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    fundingHeaders,
    [
      "2026-01-01",
      "SYNTHETIC1",
      "Wire",
      "UDEMO1",
      "Synthetic account",
      "Synthetic Bank",
      "",
      "",
      "2026-01-02",
      "",
      "",
      "",
      "EUR 10.00",
      "Available",
    ],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Deposit");
  mutate?.(sheet, workbook);
  return XLSX.write(workbook, { type: "buffer", bookType: type }) as Buffer;
}
describe("read-only native statement probe", () => {
  it("detects every source account beyond the header preview prefix", async () => {
    const rows = Array.from(
      { length: 800 },
      (_, index) => `2026-01-01,HIN_DEMO_A,USD,buy,T${index},O${index},10,11`,
    );
    rows.push("2026-01-02,HIN_DEMO_B,USD,buy,T-last,O-last,10,11");
    const result = await probe([headers.join(","), ...rows].join("\n"));
    expect(result.detected).toEqual({
      source: "kinesis",
      sourceAccountIdentities: ["HIN_DEMO_A", "HIN_DEMO_B"],
    });
    expect(result.preview?.rows).toHaveLength(5);
    expect(result.detectionError).toBeNull();
  });
  it("keeps format detection independent of pinned CSV separator and row skip", async () => {
    const result = await probe(
      headers.join(",") + "\nD,DEMO,USD,buy,T,O,10,11",
      "synthetic.csv",
      { separator: ";", skipRows: 1 },
    );
    expect(result.detected?.source).toBe("kinesis");
    expect(result.preview?.headers).toEqual(["D,DEMO,USD,buy,T,O,10,11"]);
    expect(result.separator).toBe(";");
  });
  it("sniffs delimiters and retains quoted multiline cells like the web preview", async () => {
    const result = await probe(
      'Date;Type;Note\n2026-01-01;buy;"first\nsecond"\n2026-01-02;sell;"quote ""inside"""',
    );
    expect(result.detected).toBeNull();
    expect(result.separator).toBe(";");
    expect(result.preview).toEqual({
      headers: ["Date", "Type", "Note"],
      rows: [
        ["2026-01-01", "buy", "first\nsecond"],
        ["2026-01-02", "sell", 'quote "inside"'],
      ],
    });
  });
  it("decodes explicit Latin-1 without replacing raw accented bytes", async () => {
    const result = await probe(
      Buffer.from("Date,Note\n2026-01-01,caf\xe9", "latin1"),
      "synthetic.csv",
      { encoding: "latin1" },
    );
    expect(result.preview?.rows[0]?.[1]).toBe("café");
  });
  it("reports independent detection failure while a bounded truncated preview stays usable", async () => {
    const result = await probe('Date,Note\n2026-01-01,"open quote');
    expect(result.detected).toBeNull();
    expect(result.detectionError).toBe("parse_error");
    expect(result.previewError).toBeNull();
    expect(result.preview?.rows[0]).toEqual(["2026-01-01", "open quote"]);
  });
  it.each(["xls", "xlsx"] as const)(
    "detects text-only original IBKR funding %s",
    async (type) => {
      const result = await probe(fundingWorkbook(type), `synthetic.${type}`);
      expect(result.detected).toEqual({
        source: "ibkr",
        sourceAccountIdentities: ["UDEMO1"],
        presetKey: "ibkr_funding_history",
      });
    },
  );
  it("refuses formula-bearing IBKR funding even when the cached value looks valid", async () => {
    const result = await probe(
      fundingWorkbook("xlsx", (sheet) => {
        sheet["M2"] = { t: "s", v: "EUR 10.00", f: '"EUR 10.00"' };
      }),
      "synthetic.xlsx",
    );
    expect(result.detected).toBeNull();
  });
  it("refuses hidden primary funding sheets", async () => {
    const result = await probe(
      fundingWorkbook("xlsx", (_, workbook) => {
        workbook.Workbook = { Sheets: [{ name: "Deposit", Hidden: 1 }] };
      }),
      "synthetic.xlsx",
    );
    expect(result.detected).toBeNull();
  });
  it("does not detect an unreadable legacy OLE2 workbook", async () => {
    const result = await probe(
      Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.alloc(504),
      ]),
      "synthetic.xls",
    );
    expect(result.detected).toBeNull();
  });
  it("does not treat an arbitrary ZIP as a workbook", async () => {
    const result = await probe(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      "synthetic.xlsx",
    );
    expect(result.detected).toBeNull();
    expect(result.detectionError).toBe("parse_error");
  });
});
