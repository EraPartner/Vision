import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.js";

vi.mock("../src/config/logger.js", () => ({ logger: mockLogger() }));

import { parseIbkrTransactionHistory } from "../src/services/portfolioImportPipeline/ibkrTransactionHistoryAdapter.js";
import { parseWithConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/portfolio/ibkr-transaction-history.csv",
);

describe("IBKR Transaction History portfolio adapter", () => {
  it("parses the real multi-section schema with base-currency trade conversion", async () => {
    const rows = await parseIbkrTransactionHistory(fixture);

    expect(rows).toHaveLength(9);
    expect(rows.skipped).toBe(2);
    expect(rows.map((row) => row.typeRaw)).toEqual([
      "Buy",
      "Buy",
      "Sell",
      "Dividend",
      "tax",
      "Deposit",
      "Withdrawal",
      "Withdrawal",
      "Deposit",
    ]);

    expect(rows[0]).toMatchObject({
      symbolRaw: "EXM",
      nameRaw: "",
      units: 2,
      pricePerUnit: 10,
      amount: null,
      fees: 1.2,
      currency: "USD",
      fxRateToEur: 0.85,
    });
    expect(rows[3]).toMatchObject({ amount: 4.25, currency: "EUR" });
    expect(rows[4]).toMatchObject({ amount: 1.25, currency: "EUR" });
    expect(rows[0].rawData).toBe(
      "Transaction History,Data,2026-01-02,U0000000,Example Corp purchase,Buy,EXM,2.0,10.0,USD,-17.0,-0.85,-17.85,0.85,-0.17,-,1",
    );
    expect(rows[0].rawData).toBe(rows[1].rawData);
    expect(rows[3].rawData).toContain('\"4,25\"');
    expect(rows[3].rawData).not.toContain("|");
  });

  it("treats dash symbols as instrument-less and keeps descriptions only as notes", async () => {
    const rows = await parseIbkrTransactionHistory(fixture);
    const cashRows = rows.filter((row) =>
      ["Deposit", "Withdrawal"].includes(row.typeRaw),
    );

    expect(cashRows).toHaveLength(4);
    expect(cashRows.every((row) => row.symbolRaw === "")).toBe(true);
    expect(cashRows.every((row) => row.nameRaw === "")).toBe(true);
    expect(cashRows.every((row) => row.note.length > 0)).toBe(true);
  });

  it("rejects a CSV without the IBKR Transaction History section", async () => {
    await expect(
      parseIbkrTransactionHistory(
        new URL("fixtures/portfolio/not-ibkr.csv", import.meta.url),
      ),
    ).rejects.toThrow();
  });

  it("is selected through the portfolio parser format contract", async () => {
    const rows = await parseWithConfig(fixture, {
      format: "ibkr_transaction_history",
      encoding: "utf-8",
    });

    expect(rows).toHaveLength(9);
    expect(rows.skipped).toBe(2);
  });
});
