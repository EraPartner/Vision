import { describe, expect, test } from "vitest";
import {
  configureCurrencyFormatDefaults,
  formatCurrency,
  formatCurrencyCompact,
  formatPercent,
  getCurrencyFormatDefaults,
  numberFormatToLocale,
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

  test("a non-finite digit override falls back instead of poisoning the defaults", () => {
    const previous = getCurrencyFormatDefaults();
    configureCurrencyFormatDefaults({ fractionDigits: Number.NaN });

    expect(getCurrencyFormatDefaults().fractionDigits).toBe(2);
    expect(formatCurrency(1234.56, "EUR", "en-US")).toBe("€1,234.56");

    configureCurrencyFormatDefaults(previous);
  });
});

describe("formatCurrency — malformed input degrades like Money / the parts hook", () => {
  test("returns the bare number instead of throwing RangeError on a malformed currency code", () => {
    // new Intl.NumberFormat(locale, { currency: "US" }) throws RangeError; the
    // unguarded call used to escape into the page error boundary while the
    // guarded parts formatter beside it degraded gracefully.
    expect(() => formatCurrency(1234.56, "US", "de-DE", 0)).not.toThrow();
    expect(formatCurrency(1234.56, "US", "de-DE", 0)).toBe("1234.56");
  });

  test("fallback text is byte-identical to the parts-formatter fallback (`${val}`)", () => {
    // Money and useCurrencyPartsFormatter fall back to
    // [{ type: "literal", value: `${val}` }] — the string paths must render
    // the same text so one page shows one consistent degradation.
    expect(formatCurrency(-42.5, "US", "de-DE", 2)).toBe("-42.5");
    expect(formatCurrency(1234.56, "US", "de-DE", 0, true)).toBe("1234.56");
  });

  test("degrades on out-of-range fraction digits too", () => {
    expect(formatCurrency(1234.56, "EUR", "de-DE", -1)).toBe("1234.56");
    expect(formatCurrency(1234.56, "EUR", "de-DE", 101)).toBe("1234.56");
  });

  test("valid input still formats normally after a failed call (no poisoned state)", () => {
    formatCurrency(1, "US", "de-DE", 2);
    expect(formatCurrency(1234.56, "EUR", "de-DE", 2)).toBe("1.234,56\u00a0€");
  });
});

describe("formatCurrencyCompact", () => {
  test("degrades to bare-number parts for malformed currency and digits", () => {
    for (const result of [
      formatCurrencyCompact(1234.56, "US", "de-DE", 2),
      formatCurrencyCompact(1234.56, "EUR", "de-DE", -1),
    ]) {
      expect(result).toEqual({
        display: "1234.56",
        full: "1234.56",
        isCompact: false,
        parts: [{ type: "literal", value: "1234.56" }],
      });
    }
  });

  test("valid compact formatting still works after a failed call", () => {
    formatCurrencyCompact(1, "US", "de-DE", 2);
    expect(formatCurrencyCompact(1_253_632, "EUR", "en-US", 2).isCompact).toBe(true);
  });

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

  test("keeps de-DE thousands full when compact notation has no abbreviation", () => {
    const result = formatCurrencyCompact(2_010, "EUR", "de-DE", 2);

    expect(result.isCompact).toBe(false);
    expect(result.display).toBe("2.010,00\u00a0€");
    expect(result.parts.some((part) => part.type === "compact")).toBe(false);
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
    expect(result.parts.some((part) => part.type === "compact")).toBe(true);
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

describe("formatPercent — value scale", () => {
  // The single most dangerous mistake this helper could make is a factor of
  // 100, so the scale convention is pinned first and explicitly.
  test("takes PERCENT UNITS, not a fraction (12.5 means 12.5%)", () => {
    expect(formatPercent(12.5, { locale: "en-US" })).toBe("12.5%");
    expect(formatPercent(100, { locale: "en-US", digits: 0 })).toBe("100%");
    // A fraction-holding call site must scale at the boundary itself; passing
    // the raw fraction is a visible 100x error, never a silent one.
    expect(formatPercent(0.125, { locale: "en-US", digits: 3 })).toBe("0.125%");
    expect(formatPercent(0.125 * 100, { locale: "en-US" })).toBe("12.5%");
  });

  test("large values keep locale thousands grouping", () => {
    expect(formatPercent(1234.5, { locale: "en-US" })).toBe("1,234.5%");
    expect(formatPercent(1234.5, { locale: "de-DE" })).toBe("1.234,5%");
  });
});

describe("formatPercent — locale separator (the eu/us bug this fixes)", () => {
  test("eu number format renders a comma decimal, matching the money beside it", () => {
    const eu = numberFormatToLocale("eu");
    expect(formatPercent(12.5, { locale: eu })).toBe("12,5%");
    // The money sibling on the same card, for contrast — same separator.
    expect(formatCurrency(1234.56, "EUR", eu, 2)).toBe("1.234,56 €");
  });

  test("us number format renders a dot decimal", () => {
    expect(formatPercent(12.5, { locale: numberFormatToLocale("us") })).toBe("12.5%");
  });

  test("ch and in formats follow their own separators", () => {
    // de-CH groups with an apostrophe whose exact codepoint (U+0027 vs U+2019)
    // varies by ICU version — assert the shape, not the byte.
    expect(formatPercent(1234.5, { locale: numberFormatToLocale("ch") })).toMatch(/^1['’]234\.5%$/);
    // en-IN uses lakh/crore grouping, not thousands.
    expect(formatPercent(123456.5, { locale: numberFormatToLocale("in") })).toBe("1,23,456.5%");
  });

  test("the percent sign stays glued to the number in every format", () => {
    // style:'percent' on de-DE would emit "12,5 %" (NBSP) and reflow the delta
    // chips; the decimal+literal approach must not. No locale may introduce a
    // space before the sign.
    for (const setting of ["eu", "us", "ch", "in"]) {
      expect(formatPercent(12.5, { locale: numberFormatToLocale(setting) })).not.toMatch(/[\s\u00a0\u202f]%/);
    }
  });
});

describe("formatPercent — sign convention (exceptZero, matching money)", () => {
  test("signed renders + for positive and - for negative", () => {
    expect(formatPercent(3.2, { locale: "en-US", signed: true })).toBe("+3.2%");
    expect(formatPercent(-3.2, { locale: "en-US", signed: true })).toBe("-3.2%");
  });

  test("signed leaves zero unsigned — the same call formatCurrency makes", () => {
    expect(formatPercent(0, { locale: "en-US", signed: true })).toBe("0.0%");
    expect(formatCurrency(0, "EUR", "en-US", 2, true)).toBe("€0.00");
  });

  test("unsigned keeps a negative sign but never adds a plus", () => {
    expect(formatPercent(3.2, { locale: "en-US" })).toBe("3.2%");
    expect(formatPercent(-3.2, { locale: "en-US" })).toBe("-3.2%");
    expect(formatPercent(0, { locale: "en-US" })).toBe("0.0%");
  });

  test("documents the inherited exceptZero pitfall: a loss rounding to zero loses its minus", () => {
    // Deliberate, not an oversight — money does exactly this too, so a delta
    // chip and its amount degrade together instead of disagreeing.
    expect(formatPercent(-0.04, { locale: "en-US", signed: true })).toBe("0.0%");
    expect(formatCurrency(-0.004, "EUR", "en-US", 2, true)).toBe("€0.00");
    // Unsigned keeps Intl's 'auto', which does surface the negative zero.
    expect(formatPercent(-0.04, { locale: "en-US" })).toBe("-0.0%");
  });

  test("signed negatives survive the eu separator swap", () => {
    expect(formatPercent(-1234.56, { locale: "de-DE", signed: true, digits: 2 })).toBe("-1.234,56%");
  });
});

describe("formatPercent — digits", () => {
  test("defaults to 1 decimal (the gain/loss delta standard)", () => {
    expect(formatPercent(3.25, { locale: "en-US" })).toBe("3.3%");
    expect(formatPercent(3, { locale: "en-US" })).toBe("3.0%");
  });

  test("minDigits gives 'up to N' — trailing zeros dropped, fractions kept", () => {
    // The rebalance weight column: "7.5%" must keep its decimal, "60%" must not
    // grow one.
    expect(formatPercent(60, { locale: "en-US", digits: 1, minDigits: 0 })).toBe("60%");
    expect(formatPercent(7.5, { locale: "en-US", digits: 1, minDigits: 0 })).toBe("7.5%");
    expect(formatPercent(7.5, { locale: "de-DE", digits: 1, minDigits: 0 })).toBe("7,5%");
  });

  test("honours an explicit digit count, padding as well as rounding", () => {
    expect(formatPercent(3.14159, { locale: "en-US", digits: 0 })).toBe("3%");
    expect(formatPercent(3.14159, { locale: "en-US", digits: 2 })).toBe("3.14%");
    expect(formatPercent(3.1, { locale: "en-US", digits: 2 })).toBe("3.10%");
    expect(formatPercent(3, { locale: "en-US", digits: 0 })).toBe("3%");
  });
});

describe("formatPercent — defaults and degradation", () => {
  test("falls back to the configured app locale when none is passed", () => {
    const previous = getCurrencyFormatDefaults();

    configureCurrencyFormatDefaults({ locale: "de-DE" });
    expect(formatPercent(12.5)).toBe("12,5%");

    configureCurrencyFormatDefaults({ locale: "en-US" });
    expect(formatPercent(12.5)).toBe("12.5%");

    configureCurrencyFormatDefaults(previous);
  });

  test("degrades to a bare value instead of throwing on out-of-range digits", () => {
    // Same contract as formatCurrency: a percent readout must not take the
    // card into the error boundary.
    expect(() => formatPercent(12.5, { locale: "en-US", digits: -1 })).not.toThrow();
    expect(formatPercent(12.5, { locale: "en-US", digits: -1 })).toBe("12.5%");
    expect(formatPercent(12.5, { locale: "en-US", digits: 101 })).toBe("12.5%");
  });

  test("valid input still formats normally after a failed call (no poisoned state)", () => {
    formatPercent(1, { locale: "en-US", digits: 101 });
    expect(formatPercent(12.5, { locale: "en-US" })).toBe("12.5%");
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

  test("treats single-comma + 3-digit tail as US thousands separator (1,000 → 1000)", () => {
    expect(parseLocaleNumber("1,000")).toBe(1000);
    expect(parseLocaleNumber("5,000")).toBe(5000);
    expect(parseLocaleNumber("999,000")).toBe(999000);
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
