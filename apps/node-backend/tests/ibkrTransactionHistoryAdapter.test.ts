import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));

import { parseIbkrTransactionHistory } from "../src/services/portfolioImportPipeline/ibkrTransactionHistoryAdapter.ts";
import { parseWithConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/portfolio/ibkr-transaction-history.csv",
);

async function parseModifiedFixture(transform: (csv: string) => string) {
  const directory = await mkdtemp(path.join(tmpdir(), "vision-ibkr-adapter-"));
  const statement = path.join(directory, "statement.csv");
  try {
    await writeFile(statement, transform(await readFile(fixture, "utf8")));
    return await parseIbkrTransactionHistory(statement);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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

  it("imports only explicit forex charges as an instrument-less base-currency fee, retaining raw identity", async () => {
    const chargedStatement = (csv: string) =>
      `${csv}\nTransaction History,Data,2026-01-10,U0000000,Net Amount in Base from Forex Trade,Forex Trade Component,EUR.USD,300,1.2,USD,0,-1.73,-1.73,0.833333,-0.02,-,1\n`;
    const rows = await parseModifiedFixture(chargedStatement);
    expect(rows).toHaveLength(10);
    expect(rows.skipped).toBe(2);
    expect(rows.at(-1)).toMatchObject({
      typeRaw: "Fee",
      symbolRaw: "",
      nameRaw: "",
      units: null,
      pricePerUnit: null,
      amount: 1.75,
      fees: null,
      taxes: null,
      currency: "EUR",
      fxRateToEur: null,
    });
    expect(rows.at(-1)!.rawData).toContain("Forex Trade Component,EUR.USD,300");
    const repeated = await parseModifiedFixture(chargedStatement);
    expect(repeated.ibkrSourceContext!.record_hashes).toEqual(
      rows.ibkrSourceContext!.record_hashes,
    );
  });

  it.each(["invalid", "1.73"])(
    "rejects an ambiguous forex commission %s instead of inventing an expense",
    async (commission) => {
      await expect(
        parseModifiedFixture(
          (csv) =>
            `${csv}\nTransaction History,Data,2026-01-10,U0000000,Net Amount in Base from Forex Trade,Forex Trade Component,EUR.USD,300,1.2,USD,0,${commission},0,0.833333,-,-,1\n`,
        ),
      ).rejects.toThrow("unsupported Commission");
    },
  );

  it.each([12.34, -12.34])(
    "skips an FX Translations P&L valuation adjustment of %s without adding cash",
    async (amount) => {
      const baseline = await parseIbkrTransactionHistory(fixture);
      const rows = await parseModifiedFixture(
        (csv) =>
          `${csv}\nTransaction History,Data,2026-01-10,U0000000,FX Translations P&L,Adjustment,-,-,-,-,${amount},-,${amount},1.0,-,-,1\n`,
      );

      expect(rows).toHaveLength(baseline.length);
      expect(rows.skipped).toBe(baseline.skipped! + 1);
      expect(rows.map((row) => row.rawData)).toEqual(
        baseline.map((row) => row.rawData),
      );
      expect(rows.ibkrSourceContext!.record_hashes).toEqual(
        baseline.ibkrSourceContext!.record_hashes,
      );
      expect(rows.ibkrSourceContext!.source_file_hash).not.toBe(
        baseline.ibkrSourceContext!.source_file_hash,
      );
    },
  );

  it.each([
    ["Rounding adjustment", "Withdrawal", 0.01],
    ["Positive adjustment", "Deposit", 0.02],
  ])(
    "keeps the genuine %s as base-currency cash",
    async (description, typeRaw, amount) => {
      const rows = await parseIbkrTransactionHistory(fixture);

      expect(rows.find((row) => row.note === description)).toMatchObject({
        typeRaw,
        amount,
        currency: "EUR",
        symbolRaw: "",
        nameRaw: "",
      });
    },
  );

  it.each([
    ["Cash adjustment", "Adjustment"],
    ["FX Translations P&L", "Deposit"],
  ])(
    "does not skip %s with transaction type %s",
    async (description, originalType) => {
      const rows = await parseModifiedFixture(
        (csv) =>
          `${csv}\nTransaction History,Data,2026-01-10,U0000000,${description},${originalType},-,-,-,-,1.23,-,1.23,1.0,-,-,1\n`,
      );

      expect(rows).toHaveLength(10);
      expect(rows.skipped).toBe(2);
      expect(rows.at(-1)).toMatchObject({
        typeRaw: "Deposit",
        amount: 1.23,
        currency: "EUR",
        note: description,
      });
    },
  );

  it("rejects a CSV without the IBKR Transaction History section", async () => {
    await expect(
      parseIbkrTransactionHistory(
        fileURLToPath(
          new URL("fixtures/portfolio/not-ibkr.csv", import.meta.url),
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects repeated Transaction History headers before parsing records", async () => {
    await expect(
      parseModifiedFixture((csv) =>
        csv.replace(/^(Transaction History,Header,.*)$/m, "$1\n$1"),
      ),
    ).rejects.toThrow('multiple "Transaction History" headers');
  });

  it.each([
    ["blank", "   ", "blank column names"],
    ["duplicate after trimming", " Price ", "duplicate column names"],
  ])("rejects %s transaction column names", async (_label, column, error) => {
    await expect(
      parseModifiedFixture((csv) =>
        csv.replace(/^(Transaction History,Header,.*)$/m, `$1,${column}`),
      ),
    ).rejects.toThrow(error);
  });

  it.each(["EUR", "USD"])(
    "rejects a second Summary base currency record containing %s",
    async (currency) => {
      await expect(
        parseModifiedFixture((csv) =>
          csv.replace(
            "Summary,Data,Base Currency,EUR",
            `Summary,Data,Base Currency,EUR\nSummary,Data,Base Currency,${currency}`,
          ),
        ),
      ).rejects.toThrow("multiple Summary base currency records");
    },
  );

  it("preserves valid reordered headers and their literal source context", async () => {
    const rows = await parseModifiedFixture((csv) =>
      csv
        .replace(
          "Transaction History,Header,Date,Account,",
          "Transaction History,Header,Account,Date,",
        )
        .replace(/^(Transaction History,Data),([^,]*),([^,]*)/gm, "$1,$3,$2"),
    );

    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatchObject({
      date: new Date("2026-01-02T00:00:00.000Z"),
      sourceAccountIdentity: "U0000000",
      units: 2,
      pricePerUnit: 10,
      currency: "USD",
    });
    expect(rows.sourceColumns!.slice(0, 2)).toEqual(["Account", "Date"]);
    expect(rows.ibkrSourceContext!.header_record).toContain(
      "Transaction History,Header,Account,Date,",
    );
    expect(rows[0].rawData).toContain(
      "Transaction History,Data,U0000000,2026-01-02,",
    );
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
