/**
 * Vision Bank Adapter Tests
 */

import { describe, it, expect } from "vitest";
import { createAdapter } from "../src/services/bankAdapters.js";
import { detect } from "../src/services/importPipeline/adapters/vision.js";

import { useTempCSV } from "./helpers/tempFile.js";

const writeTempCSV = useTempCSV("vision");

describe("VisionAdapter", () => {
  let tmpPath;
  const parse = createAdapter("vision");

  it("parses valid rows and skips invalid date or amount rows", async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-01,Main Account,John Doe,Dinner,-45.20,EUR,954.80,FOOD,Shared meal
INVALID_DATE,Main Account,Skip Date,Note,-10.00,EUR,944.80,OTHER,invalid date
2026-03-02,Main Account,Skip Amount,Note,INVALID,EUR,944.80,OTHER,invalid amount
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns.skipped).toBe(2);
    expect(txns[0].recipient).toBe("JOHN DOE");
    expect(txns[0].amount).toBe(-45.2);
    expect(txns[0].balance).toBe(954.8);
  });

  it("re-imports guard-quoted negative amounts and balances (export round-trip)", async () => {
    // Older exports ran numeric cells through the CSV formula-injection guard,
    // which prepended "'" to negatives. The adapter must strip it so the
    // expense row is not NaN-dropped and the balance not silently nulled.
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-01,Main Account,John Doe,Dinner,'-45.20,EUR,'-12.00,FOOD,Shared meal
`;
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(-45.2);
    expect(txns[0].balance).toBe(-12);
  });

  it("parses EU-decimal amounts instead of stripping the comma into a 100× value", async () => {
    // The loose header detection can route non-Vision CSVs here; a blind
    // comma-strip turned "12,34" into 1234.
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-04,Main Account,EU Shop,groceries,"-12,34",EUR,"1.234,56",FOOD,
`;
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].amount).toBe(-12.34);
    expect(txns[0].balance).toBe(1234.56);
  });

  it("uses UNKNOWN recipient when recipient is empty", async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-03,Main Account,,transfer,25.00,EUR,979.80,INCOME,
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].recipient).toBe("UNKNOWN");
  });

  it("defaults bank account to VISION and currency to EUR", async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-04,,Acme Corp,salary,1000.00,,1979.80,INCOME,
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].bankAccount).toBe("VISION");
    expect(txns[0].currency).toBe("EUR");
  });

  it("uppercases an ISO currency and falls back to EUR for free text (was a commit-time CHECK 500)", async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-04,Main,Acme,one,-10.00,usd,100.00,OTHER,
2026-03-05,Main,Acme,two,-11.00,euro,89.00,OTHER,
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns.map((t) => t.currency)).toEqual(["USD", "EUR"]);
  });

  it("builds comment from imported category and existing comment", async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-05,Personal,Electric Company,bill,-120.00,EUR,1859.80,UTILITIES,Paid by direct debit
2026-03-06,Personal,No Comment,none,-5.00,EUR,1854.80,,
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(2);
    expect(txns[0].comment).toBe(
      "Imported Category: UTILITIES | Paid by direct debit",
    );
    expect(txns[1].comment).toBeNull();
  });

  it("normalizes memo to uppercase", async () => {
    const csv = `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
2026-03-07,Personal,Some Recipient,mixEd Case Memo,-1.25,EUR,1853.55,MISC,
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].memo).toBe("MIXED CASE MEMO");
  });
});

describe("vision.detect", () => {
  it("detects the exact Vision export header, with or without trailing columns", () => {
    expect(
      detect(
        "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Tags\n2026-03-01,A,B,,-1.00,EUR,,,,",
      ),
    ).toBe(true);
    expect(
      detect(
        "Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Tags,Running Balance\n",
      ),
    ).toBe(true);
    expect(detect("date,bank account,recipient,memo,amount,currency\n")).toBe(
      true,
    );
  });

  it("rejects unknown bank CSVs that merely contain the header words", () => {
    // Substring matching used to auto-route any of these to the Vision adapter.
    expect(
      detect("Booking Date,Recipient Bank Account,Amount,Reference\n"),
    ).toBe(false);
    expect(
      detect("Transaction Date,Amount,Recipient,Bank Account Nr,Description\n"),
    ).toBe(false);
    expect(detect("Date,Amount,Bank Account,Recipient,Memo,Currency\n")).toBe(
      false,
    ); // wrong order
    expect(detect("")).toBe(false);
  });
});
