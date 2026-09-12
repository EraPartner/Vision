import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.js";

vi.mock("../src/config/logger.js", () => ({ logger: mockLogger() }));

import { parseNexoTransactionHistory } from "../src/services/portfolioImportPipeline/nexoTransactionHistoryAdapter.js";
import { parseWithConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/portfolio/nexo-transaction-history.csv",
);

describe("Nexo transaction history portfolio adapter", () => {
  it("parses conversions and preserves lifecycle rows for explicit review", async () => {
    const rows = await parseNexoTransactionHistory(fixture);

    expect(rows).toHaveLength(13);
    expect(rows.skipped).toBe(0);
    expect(rows.filter((row) => row.typeRaw === "Buy")).toHaveLength(1);
    expect(rows.filter((row) => row.typeRaw === "Sell")).toHaveLength(1);
    expect(rows.find((row) => row.sourceId === "NX-TRADE-1")).toMatchObject({
      typeRaw: "Buy",
      symbolRaw: "EURX",
      units: 0.05,
      pricePerUnit: 2000,
      amount: 100,
      fees: 0.01,
      currency: "USD",
      sourceId: "NX-TRADE-1",
    });
    expect(rows.find((row) => row.sourceId === "NX-TRADE-2")).toMatchObject({
      typeRaw: "Sell",
      symbolRaw: "BTC",
      units: 0.01,
      pricePerUnit: 25000,
      fees: 1,
      sourceId: "NX-TRADE-2",
    });
    expect(
      rows.filter(
        (row) =>
          row.sourceId?.startsWith("NX-DUP") ||
          row.sourceId?.startsWith("NX-MOVE"),
      ),
    ).toHaveLength(4);
    expect(rows.find((row) => row.sourceId === "NX-DUP-1")).toMatchObject({
      typeRaw: "Unsupported Nexo event: Exchange Deposited On",
      note: expect.stringContaining("explicit pairing review"),
    });
  });

  it("does not silently discard a conversion fee in another currency", async () => {
    const rows = await parseNexoTransactionHistory(fixture);

    expect(rows.find((row) => row.sourceId === "NX-FEE-1")).toMatchObject({
      typeRaw: "Unsupported Nexo event: Deposit To Exchange",
      note: expect.stringContaining("fee in EUR"),
    });
  });

  it("stages incomplete conversions for review instead of dropping them", async () => {
    const rows = await parseNexoTransactionHistory(fixture);

    expect(rows.find((row) => row.sourceId === "NX-FAILED-1")).toMatchObject({
      typeRaw: "Unsupported Nexo event: Deposit To Exchange",
      note: expect.stringContaining(
        "missing a distinct asset pair, units, or USD valuation",
      ),
    });
    expect(rows.skipped).toBe(0);
  });

  it("records interest income and units, top-ups, and unsafe withdrawals", async () => {
    const rows = await parseNexoTransactionHistory(fixture);

    expect(
      rows.filter((row) => row.sourceId?.startsWith("NX-INCOME-1")),
    ).toEqual([
      expect.objectContaining({
        typeRaw: "Interest",
        amount: 4,
        sourceId: "NX-INCOME-1:income",
      }),
      expect.objectContaining({
        typeRaw: "Gift",
        units: 0.002,
        pricePerUnit: 2000,
        sourceId: "NX-INCOME-1:units",
      }),
    ]);
    expect(rows.find((row) => row.sourceId === "NX-TOPUP-1")).toMatchObject({
      typeRaw: "Gift",
      symbolRaw: "BTC",
      units: 0.003,
    });
    expect(rows.find((row) => row.sourceId === "NX-OUT-1")).toMatchObject({
      typeRaw: "Unsupported Nexo event: Withdrawal",
      note: expect.stringContaining("manual transfer-out reconciliation"),
    });
  });

  it("retains literal provenance and is selected by the format contract", async () => {
    const rows = await parseWithConfig(fixture, {
      format: "nexo_transaction_history",
      encoding: "utf-8",
    });

    expect(rows[0].rawData).toContain("NX-TRADE-1,Deposit To Exchange");
    expect(rows[0].rawData).not.toContain("|");
  });

  it("rejects a different CSV schema", async () => {
    await expect(
      parseNexoTransactionHistory(
        new URL("fixtures/portfolio/not-ibkr.csv", import.meta.url),
      ),
    ).rejects.toThrow(/missing columns/);
  });
});
