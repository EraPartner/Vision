/**
 * Revolut Bank Adapter Tests
 * Mirrors: apps/backend/tests/test_revolut_adapter.py
 */

import { describe, it, expect } from "vitest";
import { createAdapter } from "../src/services/bankAdapters.js";

import { useTempCSV } from "./helpers/tempFile.js";

const writeTempCSV = useTempCSV("revolut");

const SAMPLE_REVOLUT_CSV = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Card Payment,Current,2026-02-01 21:27:32,2026-02-02 11:28:17,Sardinha Rabina,-39.50,0.00,EUR,COMPLETED,113.74
Transfer,Current,2026-02-01 10:00:00,2026-02-01 10:05:30,John Doe,50.00,0.00,EUR,COMPLETED,153.24
ATM,Current,2026-01-31 15:30:00,2026-01-31 15:30:45,Cash Withdrawal,-100.00,2.50,EUR,COMPLETED,103.24
Exchange,Savings,2026-01-30 09:00:00,2026-01-30 09:01:15,EUR to USD,500.00,0.00,USD,COMPLETED,600.00
Card Payment,Current,2026-01-29 12:00:00,2026-01-29 12:00:30,Pending Store,-25.00,0.00,EUR,PENDING,50.00
`;

describe("RevolutAdapter", () => {
  let tmpPath;
  const parse = createAdapter("revolut");

  it("filters out PENDING transactions", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(4);
  });

  it("detects Current account type", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].bankAccount).toBe("REVOLUT CURRENT");
    expect(txns[1].bankAccount).toBe("REVOLUT CURRENT");
    expect(txns[2].bankAccount).toBe("REVOLUT CURRENT");
  });

  it("detects Savings account type", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    expect(txns[3].bankAccount).toBe("REVOLUT SAVINGS");
  });

  it("parses transaction fields correctly", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    const txn1 = txns[0];
    expect(txn1.recipient).toContain("SARDINHA RABINA");
    expect(txn1.amount).toBe(-39.5);
    expect(txn1.currency).toBe("EUR");
    expect(txn1.balance).toBe(113.74);
    expect(txn1.recipientAccount).toBeNull();
  });

  it("extracts transaction types in comment", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].comment).toContain("Type: Card Payment");
    expect(txns[1].comment).toContain("Type: Transfer");
    expect(txns[2].comment).toContain("Type: ATM");
    expect(txns[3].comment).toContain("Type: Exchange");
  });

  it("includes fee in comment when non-zero", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].comment).not.toContain("Fee:");
    expect(txns[2].comment).toContain("Fee: 2.50 EUR");
  });

  it("preserves sub-cent fee precision in the provenance comment", async () => {
    const csv = SAMPLE_REVOLUT_CSV.replace(
      "2.50,EUR,COMPLETED,103.24",
      "2.1234,EUR,COMPLETED,103.24",
    );
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns[2].comment).toContain("Fee: 2.1234 EUR");
  });

  it("builds memo as Type - Product", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].memo).toBe("CARD PAYMENT - CURRENT");
    expect(txns[1].memo).toBe("TRANSFER - CURRENT");
    expect(txns[3].memo).toBe("EXCHANGE - SAVINGS");
  });

  it("parses amounts correctly, netting the fee", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].amount).toBe(-39.5);
    expect(txns[1].amount).toBe(50.0);
    // Revolut's Amount excludes Fee — the €100 ATM withdrawal with a €2.50
    // fee moves −102.50, which is what reconciles with the Balance column.
    expect(txns[2].amount).toBe(-102.5);
    expect(txns[3].amount).toBe(500.0);
  });

  it("parses balances correctly", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].balance).toBe(113.74);
    expect(txns[1].balance).toBe(153.24);
    expect(txns[2].balance).toBe(103.24);
    expect(txns[3].balance).toBe(600.0);
  });

  it("normalizes text to uppercase", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    for (const txn of txns) {
      if (txn.recipient)
        expect(txn.recipient).toBe(txn.recipient.toUpperCase());
      if (txn.memo) expect(txn.memo).toBe(txn.memo.toUpperCase());
      expect(txn.bankAccount).toBe(txn.bankAccount.toUpperCase());
    }
  });

  it("preserves raw data", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    for (const txn of txns) {
      expect(txn.rawData).toBeTruthy();
      expect(txn.rawData).toContain(",");
    }
  });

  it("extracts currency correctly", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].currency).toBe("EUR");
    expect(txns[3].currency).toBe("USD");
  });

  it("normalizes ISO currency cells, nulls free text, and preserves fee provenance", async () => {
    const csv = SAMPLE_REVOLUT_CSV.replace(
      "0.00,EUR,COMPLETED,113.74",
      "0.00,usd,COMPLETED,113.74",
    ).replace("2.50,EUR,COMPLETED,103.24", "2.50,euro,COMPLETED,103.24");
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns[0].currency).toBe("USD");
    expect(txns[2].currency).toBeNull();
    expect(txns[2].comment).toContain("Fee: 2.50 euro");
  });

  it("has no recipient account or address", async () => {
    tmpPath = writeTempCSV(SAMPLE_REVOLUT_CSV);
    const txns = await parse(tmpPath);
    for (const txn of txns) {
      expect(txn.recipientAccount).toBeNull();
      expect(txn.recipientAddress).toBeNull();
    }
  });

  it("skips malformed dates", async () => {
    const csv = SAMPLE_REVOLUT_CSV.replace(
      "2026-02-02 11:28:17",
      "INVALID_DATE",
    );
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(3);
    expect(txns.map((txn) => txn.recipient)).toEqual([
      "JOHN DOE",
      "CASH WITHDRAWAL",
      "EUR TO USD",
    ]);
  });

  it("skips malformed amounts", async () => {
    const csv = SAMPLE_REVOLUT_CSV.replace("-39.50", "INVALID");
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(3);
    expect(txns.map((txn) => txn.recipient)).toEqual([
      "JOHN DOE",
      "CASH WITHDRAWAL",
      "EUR TO USD",
    ]);
  });

  it("handles empty file", async () => {
    tmpPath = writeTempCSV("");
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(0);
  });

  it("handles zero balance", async () => {
    const csv = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
Transfer,Current,2026-02-01 10:00:00,2026-02-01 10:05:30,Test,-50.00,0.00,EUR,COMPLETED,0.00
`;
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(1);
    expect(txns[0].balance).toBe(0.0);
  });
});
