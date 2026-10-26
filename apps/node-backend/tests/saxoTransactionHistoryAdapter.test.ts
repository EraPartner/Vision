import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));

import { parseSaxoTransactionHistory } from "../src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.ts";
import { parseWithConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import { must } from "./helpers/must.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/portfolio/saxo-transaction-history.csv",
);

describe("Saxo transaction history portfolio adapter", () => {
  it("parses localized and English trades with account-currency conversion", async () => {
    const rows = await parseSaxoTransactionHistory(fixture);

    expect(rows).toHaveLength(6);
    expect(rows.skipped).toBe(0);
    expect(rows.sourceColumns).toContain("Bk\u00a0Record\u00a0Id");
    expect(rows.slice(0, 2).map((row) => row.typeRaw)).toEqual(["Buy", "Sell"]);
    expect(rows[0]).toMatchObject({
      symbolRaw: "EXM",
      nameRaw: "Example Inc",
      units: 10,
      pricePerUnit: 20,
      amount: null,
      fees: expect.closeTo(1.111111, 6) as unknown,
      currency: "USD",
      fxRateToEur: 0.9,
      sourceAccountIdentity: "ACC-1",
      sourceId: "101",
    });
    expect(rows[1]).toMatchObject({
      typeRaw: "Sell",
      units: 2,
      pricePerUnit: 25,
    });
  });

  it("maps dividends and cash movements without inventing instruments", async () => {
    const rows = await parseSaxoTransactionHistory(fixture);

    expect(rows[2]).toMatchObject({
      typeRaw: "Unsupported Saxo event: Cashdividend",
      symbolRaw: "EXM",
      amount: 4.5,
      currency: "EUR",
    });
    expect(rows[3]).toMatchObject({
      typeRaw: "Deposit",
      symbolRaw: "",
      nameRaw: "",
      amount: 1234.56,
      currency: "EUR",
    });
    expect(rows[4]).toMatchObject({
      typeRaw: "Withdrawal",
      symbolRaw: "",
      amount: 50,
    });
    expect(rows[5]).toMatchObject({
      typeRaw: "Unsupported Saxo event: Stock dividend",
      note: "Unsupported Saxo transaction type",
    });
  });

  it("retains literal provenance and is selected by the format contract", async () => {
    const rows = await parseWithConfig(fixture, {
      format: "saxo_transaction_history",
      encoding: "utf-8",
    });

    expect(must(rows[0], "rows[0]").rawData).toContain("Koop 10 @ 20.00 USD");
    expect(must(rows[3], "rows[3]").rawData).toContain('"1.234,56"');
  });

  it("rejects a different CSV schema", async () => {
    await expect(
      parseSaxoTransactionHistory(
        fileURLToPath(
          new URL("fixtures/portfolio/not-ibkr.csv", import.meta.url),
        ),
      ),
    ).rejects.toThrow(/missing columns/);
  });

  it("normalizes exporter whitespace in column names", async () => {
    const rows = await parseSaxoTransactionHistory(fixture);

    expect(must(rows[0], "rows[0]").sourceId).toBe("101");
  });
});

describe("Saxo CSV number conventions", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "vision-saxo-numbers-"));
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  const header = must(readFileSync(fixture, "utf8").split("\n", 1)[0], "readFileSync result");
  const trade = (action: string, booked: string, rate: string, costs: string) =>
    `synthetic,2026/01/02,2026/01/04,ACC-1,TX-1,POS-1,,101,BK-1,Transactie,${action},${booked},EUR,${rate},0,${costs},,, ,,,Example Inc,EXM:xnas,XX0000000001,USD,Stock,Synthetic exchange,false,`;
  const deposit = (booked: string) =>
    `synthetic,2026/01/05,2026/01/05,ACC-1,,,,104,BK-4,Storting/opname,Storting,${booked},EUR,1,0,0,,, ,,,,,,EUR,Cash,,false,`;
  const write = async (...lines: string[]) => {
    const file = path.join(directory, "saxo.csv");
    await fs.writeFile(file, [header, ...lines].join("\n") + "\n");
    return parseSaxoTransactionHistory(file);
  };

  it("reads a thousands-separated quantity in the decimal convention the file shows", async () => {
    const rows = await write(
      trade('"Koop 1,500 @ 20.00 USD"', "-27002.08", "0.9", "-2.08"),
    );

    expect(rows[0]).toMatchObject({
      typeRaw: "Buy",
      units: 1500,
      pricePerUnit: 20,
    });
  });

  it("reads the same quantity in a decimal-comma file", async () => {
    const rows = await write(
      trade('"Koop 1.500 @ 20,00 USD"', '"-27002,08"', '"0,9"', '"-2,08"'),
    );

    expect(rows[0]).toMatchObject({ units: 1500, pricePerUnit: 20 });
  });

  it("surfaces a number the file never shows how to read", async () => {
    const rows = await write(deposit('"1,500"'));

    expect(must(rows[0], "rows[0]").typeRaw).toBe("Unsupported Saxo event: Storting");
    expect(must(rows[0], "rows[0]").note).toMatch(/reads differently/);
    expect(must(rows[0], "rows[0]").amount).toBeNull();
  });

  it("holds back a trade whose quantity and price do not explain its booked amount", async () => {
    const rows = await write(
      trade('"Koop 1,500 @ 20.00 USD"', "-28.08", "0.9", "-1.08"),
    );

    expect(must(rows[0], "rows[0]").typeRaw).toBe(
      "Unsupported Saxo event: Koop 1,500 @ 20.00 USD",
    );
    expect(must(rows[0], "rows[0]").note).toMatch(/does not agree with its booked amount/);
    expect(must(rows[0], "rows[0]").units).toBeNull();
  });
});
