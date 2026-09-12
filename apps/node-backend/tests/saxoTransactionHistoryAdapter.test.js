import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.js";

vi.mock("../src/config/logger.js", () => ({ logger: mockLogger() }));

import { parseSaxoTransactionHistory } from "../src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.js";
import { parseWithConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/portfolio/saxo-transaction-history.csv",
);

describe("Saxo transaction history portfolio adapter", () => {
  it("parses localized and English trades with account-currency conversion", async () => {
    const rows = await parseSaxoTransactionHistory(fixture);

    expect(rows).toHaveLength(6);
    expect(rows.skipped).toBe(0);
    expect(rows.slice(0, 2).map((row) => row.typeRaw)).toEqual(["Buy", "Sell"]);
    expect(rows[0]).toMatchObject({
      symbolRaw: "EXM",
      nameRaw: "Example Inc",
      units: 10,
      pricePerUnit: 20,
      amount: null,
      fees: expect.closeTo(1.111111, 6),
      currency: "USD",
      fxRateToEur: 0.9,
      sourceAccountIdentity: "ACC-1",
      sourceId: "TX-1",
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
      typeRaw: "Dividend",
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

    expect(rows[0].rawData).toContain("Koop 10 @ 20.00 USD");
    expect(rows[3].rawData).toContain('"1.234,56"');
  });

  it("rejects a different CSV schema", async () => {
    await expect(
      parseSaxoTransactionHistory(
        new URL("fixtures/portfolio/not-ibkr.csv", import.meta.url),
      ),
    ).rejects.toThrow(/missing columns/);
  });

  it("normalizes exporter whitespace in column names", async () => {
    const rows = await parseSaxoTransactionHistory(fixture);

    expect(rows[0].sourceId).toBe("TX-1");
  });
});
