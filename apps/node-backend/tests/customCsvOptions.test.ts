import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockLogger } from "./helpers/mockLogger.ts";

vi.mock("../src/config/logger.ts", () => ({ logger: mockLogger() }));

import { parse as parseTransactions } from "../src/services/importPipeline/adapters/generic.ts";
import { parseWithConfig as parsePortfolio } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import type { PortfolioParserConfig } from "../src/services/portfolioImportPipeline/portfolioGenericAdapter.ts";
import { loose } from "./helpers/partial.ts";

/** The fields these tests read from either adapter's parsed rows. */
interface ParsedCsvRow {
  amount?: unknown;
  rawData?: unknown;
  recipient?: unknown;
  nameRaw?: unknown;
  memo?: unknown;
  note?: unknown;
}
type CsvAdapter = (
  filePath: string,
  config: PortfolioParserConfig,
) => Promise<ParsedCsvRow[] & { skipped?: number }>;

const paths: string[] = [];
function fixture(bytes: string | Buffer) {
  const file = path.join(
    os.tmpdir(),
    `custom-csv-options-${process.pid}-${paths.length}.csv`,
  );
  fs.writeFileSync(file, bytes);
  paths.push(file);
  return file;
}
afterEach(() => {
  for (const file of paths.splice(0)) fs.unlinkSync(file);
});

const config = {
  date_format: "%Y-%m-%d",
  column_mapping: {
    date: "Date",
    recipient: "Name",
    name: "Name",
    amount: "Amount",
    memo: "Note",
    note: "Note",
  },
};
// The two adapters return different row shapes; the shared cases read only
// the fields of ParsedCsvRow, so both are driven through one signature.
const adapters = loose<Array<["transaction" | "portfolio", CsvAdapter]>>([
  ["transaction", parseTransactions],
  ["portfolio", parsePortfolio],
]);

for (const [name, parse] of adapters) {
  describe(`${name} custom CSV options`, () => {
    it("skips metadata lines before selecting the header without skipping data", async () => {
      const csv =
        'Export generated for example account\nPeriod: September\nDate,Name,Amount,Note\n2026-09-01,Shop,12.50,"line one\nline two"\n2026-09-02,Other,2.50,second';
      const rows = await parse(fixture(csv), { ...config, skip_rows: 2 });
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.amount)).toEqual([12.5, 2.5]);
      expect(rows.skipped).toBe(0);
      expect(rows[0].rawData).toBe(
        '2026-09-01,Shop,12.50,"line one\nline two"',
      );
    });

    it.each(["latin-1", "iso-8859-1", "latin1"])(
      "decodes accented text with %s",
      async (encoding) => {
        const csv = Buffer.from(
          "Date,Name,Amount,Note\n2026-09-01,Café,1,référence",
          "latin1",
        );
        const rows = await parse(fixture(csv), { ...config, encoding });
        expect(rows).toHaveLength(1);
        expect(rows[0].recipient ?? rows[0].nameRaw).toBe("Café");
        expect(rows[0].memo ?? rows[0].note).toBe("référence");
      },
    );

    it("decodes Windows-1252 euro and smart quotes instead of control characters", async () => {
      const csv = Buffer.concat([
        Buffer.from("Date,Name,Amount,Note\n2026-09-01,Shop,1,"),
        Buffer.from([0x80, 0x20, 0x93, 0xe9, 0x94]),
      ]);
      const rows = await parse(fixture(csv), {
        ...config,
        encoding: "windows-1252",
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].memo ?? rows[0].note).toBe("€ “é”");
    });

    it("rejects unsupported encoding with a validation error", async () => {
      await expect(
        parse(fixture("Date,Name,Amount\n2026-09-01,Shop,1"), {
          ...config,
          encoding: "not-an-encoding",
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/Unsupported.*encoding/),
      });
    });
  });
}

describe("generic number formats", () => {
  const mapping = {
    ...config.column_mapping,
    balance: "Balance",
    units: "Units",
    price: "Price",
    fees: "Fees",
    taxes: "Taxes",
    fx_rate: "Fx",
  };
  const columns = [
    "Date",
    "Name",
    "Amount",
    "Balance",
    "Units",
    "Price",
    "Fees",
    "Taxes",
    "Fx",
  ];
  const numericFields = {
    transaction: ["Amount", "Balance"],
    portfolio: ["Amount", "Units", "Price", "Fees", "Taxes", "Fx"],
  };

  it.each([
    ["auto", "12."],
    ["decimal_dot", "12."],
    ["decimal_comma", "12,"],
  ])(
    "portfolio: preserves scientific units and trailing decimal under %s",
    async (number_format, price) => {
      const rows = await parsePortfolio(
        fixture(
          `Date;Name;Units;Amount;Price\n2026-09-01;Crypto;1e-8;1e-6;${price}`,
        ),
        {
          ...config,
          separator: ";",
          number_format,
          column_mapping: mapping,
        },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        units: 1e-8,
        amount: 1e-6,
        pricePerUnit: 12,
      });
    },
  );

  for (const [name, parse] of adapters) {
    it.each(numericFields[name])(
      `${name}: rejects ambiguous %s with row/column context`,
      async (column) => {
        const valid = ["2026-09-01", "Shop", "1", "1", "1", "1", "1", "1", "1"];
        const ambiguous = [...valid];
        ambiguous[columns.indexOf(column)] = "1,234";
        const csv = [
          columns.join(";"),
          valid.join(";"),
          ambiguous.join(";"),
        ].join("\n");
        const result = parse(fixture(csv), {
          ...config,
          separator: ";",
          column_mapping: mapping,
        });
        await expect(result).rejects.toMatchObject({
          status: 400,
          message: expect.stringMatching(new RegExp(`row 2.*${column}`)),
        });
        await result.catch((error) =>
          expect(error.message).not.toContain("1,234"),
        );
      },
    );

    it.each([
      ["decimal_dot", "1,234", 1234],
      ["decimal_comma", "1,234", 1.234],
      ["decimal_dot", "1.234", 1.234],
      ["decimal_comma", "1.234", 1234],
      ["auto", "1.2345", 1.2345],
      ["auto", "1,234,567", 1234567],
      ["auto", "1.234.567", 1234567],
      ["auto", "1.234,56", 1234.56],
      ["auto", "1,234.56", 1234.56],
      ["auto", "(€12,50)", -12.5],
      ["auto", "-12.50", -12.5],
      ["auto", "+12,50", 12.5],
    ])(`${name}: %s resolves %s`, async (number_format, value, expected) => {
      const rows = await parse(
        fixture(`Date;Name;Amount\n2026-09-01;Shop;${value}`),
        {
          ...config,
          separator: ";",
          number_format,
        },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].amount).toBe(
        name === "portfolio" ? Math.abs(expected) : expected,
      );
    });

    it(`${name}: rejects a genuinely ambiguous dot form in auto mode`, async () => {
      await expect(
        parse(fixture("Date;Name;Amount\n2026-09-01;Shop;1.234"), {
          ...config,
          separator: ";",
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining("Ambiguous number"),
      });
    });
  }
});
