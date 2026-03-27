import { describe, expect, test } from "vitest";
import {
  configureCurrencyFormatDefaults,
  formatCurrency,
  getCurrencyFormatDefaults,
} from "./currency";

describe("currency format defaults", () => {
  test("applies configured defaults when no explicit arguments are passed", () => {
    const previous = getCurrencyFormatDefaults();

    configureCurrencyFormatDefaults({
      defaultCurrency: "USD",
      locale: "en-US",
      fractionDigits: 0,
    });

    expect(formatCurrency(1234.56)).toBe("$1,235");

    configureCurrencyFormatDefaults(previous);
  });

  test("explicit function args still override configured defaults", () => {
    const previous = getCurrencyFormatDefaults();

    configureCurrencyFormatDefaults({
      defaultCurrency: "USD",
      locale: "en-US",
      fractionDigits: 0,
    });

    expect(formatCurrency(1234.56, "EUR", "de-DE", 2)).toBe("1.234,56 €");

    configureCurrencyFormatDefaults(previous);
  });
});
