import { describe, expect, test } from "vitest";
import {
  configureCurrencyFormatDefaults,
  formatCurrency,
  formatCurrencyCompact,
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

describe("formatCurrencyCompact", () => {
  test("returns full when below threshold", () => {
    const result = formatCurrencyCompact(42, "EUR", "en-US", 2);
    expect(result.isCompact).toBe(false);
    expect(result.display).toBe(result.full);
  });

  test("returns full for zero", () => {
    const result = formatCurrencyCompact(0, "EUR", "en-US", 2);
    expect(result.isCompact).toBe(false);
  });

  test("returns full for small amounts (999 EUR en-US)", () => {
    const result = formatCurrencyCompact(999, "EUR", "en-US", 2);
    expect(result.isCompact).toBe(false);
    expect(result.display).toBe(result.full);
  });

  test("abbreviates large amounts (en-US, EUR)", () => {
    const result = formatCurrencyCompact(1_253_632, "EUR", "en-US", 2);
    expect(result.isCompact).toBe(true);
    expect(result.full.length).toBeGreaterThan(9);
    expect(result.display.length).toBeLessThan(result.full.length);
  });

  test("abbreviates large amounts (de-DE, EUR)", () => {
    const result = formatCurrencyCompact(1_253_632, "EUR", "de-DE", 2);
    expect(result.isCompact).toBe(true);
    expect(result.display.length).toBeLessThan(result.full.length);
  });

  test("handles negative large amounts", () => {
    const result = formatCurrencyCompact(-2_500_000, "EUR", "en-US", 2);
    expect(result.isCompact).toBe(true);
    expect(result.full).toContain("-");
    expect(result.display).toContain("-");
  });

  test("full value preserves full precision for large amount", () => {
    const result = formatCurrencyCompact(1_253_632.45, "EUR", "en-US", 2);
    expect(result.full).toContain("1,253,632.45");
  });

  test("does not compact when compact is not shorter than full", () => {
    const result = formatCurrencyCompact(100, "USD", "en-US", 2);
    expect(result.isCompact).toBe(false);
  });

  test("works with USD locale en-US", () => {
    const result = formatCurrencyCompact(5_000_000, "USD", "en-US", 2);
    expect(result.isCompact).toBe(true);
    expect(result.display).toMatch(/\$5M|\$5\.0M/);
  });

  test("works with GBP locale en-US", () => {
    const result = formatCurrencyCompact(1_000_000, "GBP", "en-US", 2);
    expect(result.isCompact).toBe(true);
  });
});
