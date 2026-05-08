import { describe, expect, test } from "vitest";
import {
  configureCurrencyFormatDefaults,
  formatCurrency,
  formatCurrencyCompact,
  getCurrencyFormatDefaults,
  parseLocaleNumber,
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

describe("parseLocaleNumber", () => {
  test("returns the input unchanged when given a number", () => {
    expect(parseLocaleNumber(42.5)).toBe(42.5);
    expect(parseLocaleNumber(-7)).toBe(-7);
    expect(parseLocaleNumber(0)).toBe(0);
  });

  test("parses plain US-format decimals", () => {
    expect(parseLocaleNumber("42.50")).toBe(42.5);
    expect(parseLocaleNumber("0.01")).toBe(0.01);
  });

  test("parses EU-format comma decimal (1,50 → 1.5)", () => {
    expect(parseLocaleNumber("1,50")).toBe(1.5);
    expect(parseLocaleNumber("0,99")).toBe(0.99);
  });

  test("parses US thousands+decimal (1,500.25 → 1500.25)", () => {
    expect(parseLocaleNumber("1,500.25")).toBe(1500.25);
    expect(parseLocaleNumber("12,345.67")).toBe(12345.67);
  });

  test("parses EU thousands+decimal (1.234,56 → 1234.56)", () => {
    expect(parseLocaleNumber("1.234,56")).toBe(1234.56);
    expect(parseLocaleNumber("12.345,67")).toBe(12345.67);
  });

  test("treats double-comma + 3-digit tail as US thousands separator (12,345,500 → 12345500)", () => {
    expect(parseLocaleNumber("12,345,500")).toBe(12345500);
  });

  test("strips currency symbols and whitespace", () => {
    expect(parseLocaleNumber("$ 42.50 ")).toBe(42.5);
    expect(parseLocaleNumber("€1,50")).toBe(1.5);
  });

  test("parses parenthesised negatives", () => {
    expect(parseLocaleNumber("(42.50)")).toBe(-42.5);
  });

  test("parses leading-sign values", () => {
    expect(parseLocaleNumber("-42.50")).toBe(-42.5);
    expect(parseLocaleNumber("+42.50")).toBe(42.5);
  });

  test("returns NaN for non-numeric input", () => {
    expect(Number.isNaN(parseLocaleNumber(""))).toBe(true);
    expect(Number.isNaN(parseLocaleNumber("abc"))).toBe(true);
    expect(Number.isNaN(parseLocaleNumber(null))).toBe(true);
    expect(Number.isNaN(parseLocaleNumber(undefined))).toBe(true);
  });
});
