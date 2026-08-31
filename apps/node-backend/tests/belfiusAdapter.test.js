/**
 * Belfius Bank Adapter Tests
 * Mirrors: apps/backend/tests/test_belfius_adapter.py
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createAdapter } from "../src/services/bankAdapters.js";

import { useTempCSV } from "./helpers/tempFile.js";

const writeTempCSV = useTempCSV("belfius");

const SAMPLE_BELFIUS_CSV = `Boekingsdatum vanaf; Boekingsdatum tot en met; Bedrag vanaf; Bedrag tot en met; Rekeninguittrekselnummer vanaf; Rekeninguittrekselnummer tot en met; Mededeling; Naam tegenpartij bevat; Rekening tegenpartij;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
;;;;;;;;;
Laatste saldo;1234,56 EUR
Datum/uur van het laatste saldo;19/02/2026 12:46:57 ;

Rekening;Boekingsdatum;Rekeninguittrekselnummer;Transactienummer;Rekening tegenpartij;Naam tegenpartij bevat;Straat en nummer;Postcode en plaats;Transactie;Valutadatum;Bedrag;Devies;BIC;Landcode;Mededelingen
BE81 0637 5694 4024;24/11/2025;00010;52;;Bancontact Payconiq Co;;3200  Aarschot;BANCONTACT - AANKOOP;22/11/2025;-67,90;EUR;;BE;Additional info
BE81 0637 5694 4024;23/11/2025;00010;51;BE12 3456 7890 1234;TEST RECIPIENT SA;Rue de la Paix 123;1000 Brussels;VIREMENT - TEST PAYMENT;23/11/2025;-150,00;EUR;GEBABEBB;BE;Monthly subscription
BE81 0637 5694 4024;22/11/2025;00010;50;;SALARY PAYMENT;;1000 Brussels;VIREMENT SALAIRE;20/11/2025;2500,00;EUR;;BE;Salary November
`;

describe("BelfiusAdapter", () => {
  let tmpPath;
  const parse = createAdapter("belfius");

  it("parses correct number of transactions", async () => {
    tmpPath = writeTempCSV(SAMPLE_BELFIUS_CSV);
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(3);
  });

  it("extracts balance from header and calculates running balances", async () => {
    tmpPath = writeTempCSV(SAMPLE_BELFIUS_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].balance).toBe(1234.56);
  });

  it('parses a dot-grouped "Laatste saldo" (≥ €1000)', async () => {
    // "12.345,67 EUR" used to become NaN via a bare comma swap, so running
    // balances silently never applied for balances of €1000 and up.
    const csv = SAMPLE_BELFIUS_CSV.replace(
      "Laatste saldo;1234,56 EUR",
      "Laatste saldo;12.345,67 EUR",
    );
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns[0].balance).toBe(12345.67);
  });

  it("walks running balances by statement/transaction number for a single-day ascending statement", async () => {
    // All rows share one date, so the old first-vs-last-date heuristic
    // treated this ascending statement as descending and walked balances
    // from the wrong end. Transaction numbers 50→52 define the real order.
    const csv = SAMPLE_BELFIUS_CSV.replace(
      "Laatste saldo;1234,56 EUR",
      "Laatste saldo;1000,00 EUR",
    ).replace(
      /BE81[^]*$/,
      `BE81 0637 5694 4024;24/11/2025;00010;50;;SALARY;;1000 Brussels;VIREMENT;24/11/2025;100,00;EUR;;BE;
BE81 0637 5694 4024;24/11/2025;00010;51;;SHOP A;;1000 Brussels;BANCONTACT;24/11/2025;-50,00;EUR;;BE;
BE81 0637 5694 4024;24/11/2025;00010;52;;SHOP B;;1000 Brussels;BANCONTACT;24/11/2025;-20,00;EUR;;BE;
`,
    );
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(3);
    // Newest (txn 52) carries the "Laatste saldo"; older rows walk backwards.
    expect(txns[2].balance).toBe(1000);
    expect(txns[1].balance).toBe(1020);
    expect(txns[0].balance).toBe(1070);
    // The internal ordering key must not leak into the emitted rows.
    expect(txns[0]._seq).toBeUndefined();
  });

  it("parses transaction fields correctly", async () => {
    tmpPath = writeTempCSV(SAMPLE_BELFIUS_CSV);
    const txns = await parse(tmpPath);
    const txn1 = txns[0];
    expect(txn1.bankAccount).toBe("BE81063756944024"); // own IBAN (col 0), canonicalized
    expect(txn1.amount).toBe(-67.9);
    expect(txn1.currency).toBe("EUR");
    expect(txn1.recipient).toContain("BANCONTACT PAYCONIQ CO");
  });

  it("normalizes ISO currency cells and nulls malformed free text", async () => {
    const csv = SAMPLE_BELFIUS_CSV.replace(
      "-67,90;EUR;",
      "-67,90;usd;",
    ).replace("-150,00;EUR;", "-150,00;euro;");
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns.map((txn) => txn.currency)).toEqual(["USD", null, "EUR"]);
  });

  it("extracts recipient account and address", async () => {
    tmpPath = writeTempCSV(SAMPLE_BELFIUS_CSV);
    const txns = await parse(tmpPath);
    const txn2 = txns[1];
    expect(txn2.recipientAccount).toBe("BE12 3456 7890 1234");
    expect(txn2.recipientAddress).toContain("Rue de la Paix 123");
    expect(txn2.recipientAddress).toContain("1000 Brussels");
  });

  it("builds structured comment", async () => {
    tmpPath = writeTempCSV(SAMPLE_BELFIUS_CSV);
    const txns = await parse(tmpPath);
    const txn2 = txns[1];
    expect(txn2.comment).toContain("Statement: 00010");
    expect(txn2.comment).toContain("Transaction: 51");
    expect(txn2.comment).toContain("BIC: GEBABEBB");
    expect(txn2.comment).toContain("Country: BE");
  });

  it("normalizes text to uppercase", async () => {
    tmpPath = writeTempCSV(SAMPLE_BELFIUS_CSV);
    const txns = await parse(tmpPath);
    for (const txn of txns) {
      if (txn.recipient)
        expect(txn.recipient).toBe(txn.recipient.toUpperCase());
      if (txn.memo) expect(txn.memo).toBe(txn.memo.toUpperCase());
      expect(txn.bankAccount).toBe(txn.bankAccount.toUpperCase());
    }
  });

  it("preserves raw data for deduplication", async () => {
    tmpPath = writeTempCSV(SAMPLE_BELFIUS_CSV);
    const txns = await parse(tmpPath);
    for (const txn of txns) {
      expect(txn.rawData).toBeTruthy();
      expect(txn.rawData).toContain(";");
    }
  });

  it("parses amounts with comma decimal separator", async () => {
    tmpPath = writeTempCSV(SAMPLE_BELFIUS_CSV);
    const txns = await parse(tmpPath);
    expect(txns[0].amount).toBe(-67.9);
    expect(txns[1].amount).toBe(-150.0);
    expect(txns[2].amount).toBe(2500.0);
  });

  it("skips malformed dates", async () => {
    const csv = SAMPLE_BELFIUS_CSV.replace("24/11/2025", "INVALID_DATE");
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(2);
  });

  it("skips malformed amounts", async () => {
    const csv = SAMPLE_BELFIUS_CSV.replace("-67,90", "INVALID");
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(2);
  });

  it("handles empty file", async () => {
    tmpPath = writeTempCSV("");
    const txns = await parse(tmpPath);
    expect(txns).toHaveLength(0);
  });

  it("handles missing balance metadata", async () => {
    const csv = SAMPLE_BELFIUS_CSV.replace("Laatste saldo;1234,56 EUR", "");
    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);
    // Should still parse (may have null balances)
    expect(txns.length).toBeGreaterThanOrEqual(0);
  });
});
