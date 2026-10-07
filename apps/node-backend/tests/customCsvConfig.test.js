import { describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

vi.mock("../src/database/connection.ts", () => mockConnection());

import {
  __buildCustomCsvConfig as buildBankConfig,
  __normalizeParserConfig as normalizeBankParser,
} from "../src/routes/importRoutes.ts";
import {
  __buildPortfolioConfig as buildPortfolioConfig,
  __normalizePortfolioParserConfig as normalizePortfolioParser,
} from "../src/routes/portfolioImportRoutes.ts";

const bankBody = {
  bank_name: "Custom",
  date_format: "%Y-%m-%d",
  date_column: "Date",
  recipient_column: "Name",
  amount_column: "Amount",
};
const portfolioBody = {
  date_column: "Date",
  symbol_column: "Symbol",
  default_asset_class: "stock",
};
const bankSaved = {
  dateColumn: "Date",
  recipientColumn: "Name",
  amountColumn: "Amount",
};
const portfolioSaved = {
  dateColumn: "Date",
  symbolColumn: "Symbol",
  defaultAssetClass: "stock",
};
const schemas = [
  ["bank upload", (input) => buildBankConfig(input).customConfig, bankBody],
  [
    "portfolio upload",
    (input) => buildPortfolioConfig(input).customConfig,
    portfolioBody,
  ],
  ["saved bank parser", normalizeBankParser, bankSaved],
  ["saved portfolio parser", normalizePortfolioParser, portfolioSaved],
];

for (const [name, parse, base] of schemas) {
  describe(`${name} numeric format contract`, () => {
    it("defaults old configurations to auto", () => {
      expect(parse(base).number_format).toBe("auto");
    });

    it.each(["auto", "decimal_dot", "decimal_comma"])(
      "preserves %s",
      (number_format) => {
        expect(parse({ ...base, number_format }).number_format).toBe(
          number_format,
        );
      },
    );

    it.each(["guess", null, 1])(
      "rejects invalid format %s with status 400",
      (number_format) => {
        expect(() => parse({ ...base, number_format })).toThrow(
          expect.objectContaining({ status: 400 }),
        );
      },
    );

    it.each([
      ["latin-1", "latin1"],
      ["iso-8859-1", "latin1"],
      ["windows-1252", "windows-1252"],
      [" UTF8 ", "utf-8"],
    ])("normalizes supported encoding %s", (encoding, expected) => {
      expect(parse({ ...base, encoding }).encoding).toBe(expected);
    });

    it("rejects unsupported encoding with status 400", () => {
      expect(() => parse({ ...base, encoding: "bogus" })).toThrow(
        expect.objectContaining({
          status: 400,
          message: expect.stringContaining("Unsupported CSV encoding"),
        }),
      );
    });
  });
}
