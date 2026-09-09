import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.js";

vi.mock("../src/config/logger.js", () => ({ logger: mockLogger() }));

import { parseKinesisTransactionHistory } from "../src/services/portfolioImportPipeline/kinesisTransactionHistoryAdapter.js";
import { parseWithConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/portfolio/kinesis-transaction-history.csv",
);

describe("Kinesis Transaction History portfolio adapter", () => {
  it("collapses paired trade legs into one trade and one real cash movement", async () => {
    const rows = await parseKinesisTransactionHistory(fixture);

    expect(rows.slice(0, 4).map((row) => row.typeRaw)).toEqual([
      "Buy",
      "Withdrawal",
      "Sell",
      "Deposit",
    ]);
    expect(rows[0]).toMatchObject({
      symbolRaw: "KAG",
      units: 32.24654,
      pricePerUnit: 21.66,
      amount: null,
      fees: expect.closeTo(1.540026, 6),
      currency: "EUR",
      sourceId: "TX-BUY",
      sourceAccountIdentity: "KM00000001",
    });
    expect(rows[1]).toMatchObject({
      symbolRaw: "",
      amount: 700.01,
      currency: "EUR",
      sourceId: "TX-BUY",
    });
    expect(rows[2]).toMatchObject({
      symbolRaw: "KAU",
      units: 0.24561,
      pricePerUnit: 61.9,
      fees: expect.closeTo(0.032807, 6),
      currency: "USD",
    });
  });

  it("pins distributions, instrument-less fiat rows, and noisy asset codes", async () => {
    const rows = await parseKinesisTransactionHistory(fixture);

    expect(rows).toHaveLength(12);
    expect(rows.skipped).toBe(0);

    const distribution = rows.filter((row) =>
      row.sourceId?.startsWith("TX-YIELD"),
    );
    expect(distribution).toHaveLength(2);
    expect(distribution).toEqual([
      expect.objectContaining({
        typeRaw: "Dividend",
        symbolRaw: "KAU",
        amount: 0.1617675,
        currency: "USD",
        sourceId: "TX-YIELD:income",
      }),
      expect.objectContaining({
        typeRaw: "Gift",
        symbolRaw: "KAU",
        units: 0.00287,
        amount: 0.1617675,
        currency: "USD",
        sourceId: "TX-YIELD:units",
      }),
    ]);

    const cashDeposit = rows.find((row) => row.sourceId === "TX-CASH-IN");
    expect(cashDeposit).toMatchObject({
      typeRaw: "Deposit",
      symbolRaw: "",
      nameRaw: "",
      amount: 1234.56,
      currency: "EUR",
    });
    expect(rows.find((row) => row.sourceId === "TX-ASSET-IN")).toMatchObject({
      typeRaw: "Gift",
      symbolRaw: "BTC",
      units: 0.00784739,
      amount: 0,
    });
    expect(rows.find((row) => row.sourceId === "TX-ASSET-OUT")).toMatchObject({
      typeRaw: "Unsupported Kinesis event: Withdrawal",
      symbolRaw: "BTC",
      units: 0.0008,
      note: expect.stringContaining("manual transfer-out reconciliation"),
    });
    expect(rows.find((row) => row.sourceId === "TX-ADJUST-OUT")).toMatchObject({
      typeRaw: "Unsupported Kinesis event: Holder's_Distribution_Adjustment",
      symbolRaw: "KAU",
      units: 0.07652,
      note: expect.stringContaining("manual reconciliation"),
    });
    expect(
      rows.every((row) => row.symbolRaw !== "EUR" && row.symbolRaw !== "USD"),
    ).toBe(true);
  });

  it("retains literal CSV provenance and is selected by the format contract", async () => {
    const rows = await parseWithConfig(fixture, {
      format: "kinesis_transaction_history",
      encoding: "utf-8",
    });

    expect(rows[0].rawData).toContain("ORDER-BUY,KAG_EUR");
    expect(rows[0].rawData).not.toContain("|");
    expect(rows).toHaveLength(12);
  });

  it("rejects a different CSV schema", async () => {
    await expect(
      parseKinesisTransactionHistory(
        new URL("fixtures/portfolio/not-ibkr.csv", import.meta.url),
      ),
    ).rejects.toThrow(/missing columns/);
  });
});
