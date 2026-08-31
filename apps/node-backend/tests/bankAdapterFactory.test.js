/**
 * Bank Adapter Factory Tests
 * Tests the factory pattern and generic CSV adapter.
 */

import { describe, it, expect } from "vitest";
import {
  createAdapter,
  getSupportedBanks,
  detectBank,
} from "../src/services/bankAdapters.js";

import { useTempCSV } from "./helpers/tempFile.js";

const writeTempCSV = useTempCSV("factory");

describe("BankAdapterFactory", () => {
  let tmpPath;

  it("creates belfius adapter", async () => {
    const parser = createAdapter("belfius");
    expect(typeof parser).toBe("function");
  });

  it("creates revolut adapter", async () => {
    const parser = createAdapter("revolut");
    expect(typeof parser).toBe("function");
  });

  it("creates kbc adapter", async () => {
    const parser = createAdapter("kbc");
    expect(typeof parser).toBe("function");
  });

  it("creates ing adapter", async () => {
    const parser = createAdapter("ing");
    expect(typeof parser).toBe("function");
  });

  it("creates bnp adapter", async () => {
    const parser = createAdapter("bnp");
    expect(typeof parser).toBe("function");
  });

  it("is case-insensitive", async () => {
    expect(() => createAdapter("BELFIUS")).not.toThrow();
    expect(() => createAdapter("Revolut")).not.toThrow();
    expect(() => createAdapter("KBC")).not.toThrow();
    expect(() => createAdapter("ING")).not.toThrow();
    expect(() => createAdapter("BNP")).not.toThrow();
  });

  it("throws for unsupported bank", async () => {
    expect(() => createAdapter("UnknownBank")).toThrow(
      "No configuration found",
    );
  });

  it("creates generic adapter with custom config", async () => {
    const config = {
      bank_name: "TestBank",
      date_format: "%Y-%m-%d",
      separator: ",",
      encoding: "utf-8",
      skip_rows: 0,
      column_mapping: {
        date: "Date",
        recipient: "Description",
        amount: "Amount",
        memo: "",
      },
    };
    const parser = createAdapter("TestBank", config);
    expect(typeof parser).toBe("function");
  });

  it("generic adapter parses CSV correctly", async () => {
    const config = {
      bank_name: "TestBank",
      date_format: "%Y-%m-%d",
      separator: ",",
      encoding: "utf-8",
      skip_rows: 0,
      column_mapping: {
        date: "Date",
        recipient: "Description",
        amount: "Amount",
        memo: "",
      },
    };
    const csv = `Date,Description,Amount
2024-01-15,Grocery Store,-50.00
2024-01-16,Salary,2000.00
`;
    tmpPath = writeTempCSV(csv);
    const parser = createAdapter("TestBank", config);
    const txns = await parser(tmpPath);
    expect(txns).toHaveLength(2);
    expect(txns[0].recipient).toBe("Grocery Store");
    expect(txns[0].amount).toBe(-50.0);
    expect(txns[1].amount).toBe(2000.0);
    expect(txns[0].bankAccount).toBe("TESTBANK");
  });

  describe("ING adapter", () => {
    it("parses ING CSV correctly", async () => {
      const csv = [
        "Rekeningnummer;Naam van de rekening;Rekening tegenpartij;Omzetnummer;Boekingsdatum;Valutadatum;Bedrag;Munteenheid;Omschrijving;Detail van de omzet;Bericht",
        "BE12345678901234;John Doe;BE98765432109876;20240115000001;15/01/2024;15/01/2024;-50,00;EUR;Europese overschrijving;Supermarkt AH;Boodschappen",
        "BE12345678901234;John Doe;;20240116000001;16/01/2024;16/01/2024;2000,00;EUR;Storting;;Salaris januari",
      ].join("\n");
      tmpPath = writeTempCSV(csv);
      const parser = createAdapter("ing");
      const txns = await parser(tmpPath);
      expect(txns).toHaveLength(2);
      expect(txns[0].amount).toBe(-50);
      expect(txns[0].recipient).toBe("SUPERMARKT AH");
      expect(txns[0].memo).toBe("EUROPESE OVERSCHRIJVING");
      expect(txns[0].currency).toBe("EUR");
      expect(txns[0].recipientAccount).toBe("BE98765432109876");
      expect(txns[0].bankAccount).toBe("BE12345678901234");
      expect(txns[1].amount).toBe(2000);
      expect(txns[1].recipientAccount).toBeNull();
    });

    it("detects ING header correctly", () => {
      const sample =
        "Rekeningnummer;Naam van de rekening;Rekening tegenpartij;Omzetnummer;Boekingsdatum;Valutadatum;Bedrag;Munteenheid;Omschrijving;Detail van de omzet;Bericht\n";
      expect(detectBank(sample)).toBe("ing");
    });

    it("does not detect ING for KBC header", () => {
      const sample =
        "Rekeningnummer;Naam van de rekening;Datum;Omschrijving;Bedrag;Valuta;Vrije Mededeling\n";
      expect(detectBank(sample)).not.toBe("ing");
    });
  });

  describe("BNP adapter", () => {
    const BNP_HEADER =
      "Volgnummer;Uitvoeringsdatum;Valutadatum;Bedrag;Valuta rekening;Rekeningnummer;Type verrichting;Tegenpartij;Naam van de tegenpartij;Mededeling;Details;Status;Reden van weigering";

    it("parses BNP CSV with comma decimals", async () => {
      const csv = [
        BNP_HEADER,
        "2024000001;15/01/2024;15/01/2024;-50,00;EUR;BE12345678901234;Aankoop met kaart;BE98765432109876;Supermarkt AH;Boodschappen;Detail line;Uitgevoerd;",
        "2024000002;16/01/2024;16/01/2024;2000,00;EUR;BE12345678901234;Overschrijving;;;Salaris januari;;Uitgevoerd;",
      ].join("\n");
      tmpPath = writeTempCSV(csv);
      const parser = createAdapter("bnp");
      const txns = await parser(tmpPath);
      expect(txns).toHaveLength(2);
      expect(txns[0].amount).toBe(-50);
      expect(txns[0].recipient).toBe("SUPERMARKT AH");
      expect(txns[0].memo).toBe("AANKOOP MET KAART");
      expect(txns[0].currency).toBe("EUR");
      expect(txns[0].recipientAccount).toBe("BE98765432109876");
      expect(txns[0].bankAccount).toBe("BE12345678901234");
      expect(txns[1].amount).toBe(2000);
      expect(txns[1].recipientAccount).toBeNull();
    });

    it("parses BNP CSV with dot decimals", async () => {
      const csv = [
        BNP_HEADER,
        "2024000003;17/01/2024;17/01/2024;-12.34;EUR;BE12345678901234;Aankoop met kaart;BE98765432109876;Bakkerij;;;Uitgevoerd;",
      ].join("\n");
      tmpPath = writeTempCSV(csv);
      const parser = createAdapter("bnp");
      const txns = await parser(tmpPath);
      expect(txns).toHaveLength(1);
      expect(txns[0].amount).toBeCloseTo(-12.34, 2);
      expect(txns[0].recipient).toBe("BAKKERIJ");
    });

    it("detects BNP header correctly", () => {
      expect(detectBank(BNP_HEADER + "\n")).toBe("bnp");
    });

    it("does not detect BNP for ING header", () => {
      const sample =
        "Rekeningnummer;Naam van de rekening;Rekening tegenpartij;Omzetnummer;Boekingsdatum;Valutadatum;Bedrag;Munteenheid;Omschrijving;Detail van de omzet;Bericht\n";
      expect(detectBank(sample)).not.toBe("bnp");
    });
  });

  describe("getSupportedBanks", () => {
    it("pins the complete adapter registry and detection order", () => {
      expect(getSupportedBanks()).toEqual([
        "belfius",
        "revolut",
        "ing",
        "bnp",
        "kbc",
        "vision",
        "sabb",
        "wise",
      ]);
    });

    it.each([
      ["belfius", "Laatste saldo;100,00 EUR\n"],
      ["revolut", "Type,Product,Completed Date,State\n"],
      ["ing", "Omzetnummer;Boekingsdatum;Detail van de omzet\n"],
      ["bnp", "Volgnummer;Uitvoeringsdatum;Valuta rekening\n"],
      ["kbc", "Rekeningnummer;Naam van de rekening;Vrije Mededeling\n"],
      ["vision", "Date,Bank Account,Recipient,Memo,Amount,Currency\n"],
      ["sabb", "Transaction Date,Description,Amount(SAR)\n"],
      ["wise", "Direction,Target amount,Source amount\n"],
    ])("detects the %s registry entry", (bank, sample) => {
      expect(detectBank(sample)).toBe(bank);
    });

    it("uses registry order when one sample matches multiple adapters", () => {
      const ambiguous = [
        "Laatste saldo;100,00 EUR",
        "Omzetnummer;Boekingsdatum;Detail van de omzet",
      ].join("\n");
      expect(detectBank(ambiguous)).toBe("belfius");
    });
  });
});
