import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  currencyCode,
  fieldErrorsFromZod,
  moneyAmount,
  requiredString,
  requiredTrimmedString,
  ymdDateString,
} from "./schemas";

describe("requiredString / ymdDateString", () => {
  test("rejects empty with the given key, accepts non-empty", () => {
    const schema = requiredString("validation.required");
    const result = schema.safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("validation.required");
    }
    expect(schema.safeParse("7").success).toBe(true);

    const date = ymdDateString("validation.required");
    expect(date.safeParse("").success).toBe(false);
    expect(date.safeParse("2026-08-03").success).toBe(true);
  });
});

describe("requiredTrimmedString", () => {
  test("whitespace-only counts as empty", () => {
    const schema = requiredTrimmedString("portfolio.move.selectAccount");
    const result = schema.safeParse("   ");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("portfolio.move.selectAccount");
    }
    expect(schema.safeParse(" Main ").success).toBe(true);
  });
});

describe("moneyAmount", () => {
  const keys = { required: "k.required", invalid: "k.invalid", zero: "k.zero" };

  test("parses EU and US locale formats to the same number", () => {
    const schema = moneyAmount(keys);
    expect(schema.parse("1.234,56")).toBe(1234.56);
    expect(schema.parse("1,234.56")).toBe(1234.56);
    expect(schema.parse("12,50")).toBe(12.5);
    expect(schema.parse("-5")).toBe(-5);
  });

  test("reports exactly one issue, in required → invalid → zero order", () => {
    const schema = moneyAmount(keys);
    for (const [input, key] of [
      ["", "k.required"],
      ["abc", "k.invalid"],
      ["0", "k.zero"],
      ["0,00", "k.zero"],
    ] as const) {
      const result = schema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0].message).toBe(key);
      }
    }
  });

  test("zero is allowed when no zero key is given", () => {
    const schema = moneyAmount({ required: "k.required", invalid: "k.invalid" });
    expect(schema.parse("0")).toBe(0);
  });

  test("non-finite results (overflowing exponent) are invalid, not silently null", () => {
    const schema = moneyAmount(keys);
    const result = schema.safeParse("1e999");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe("k.invalid");
  });
});

describe("currencyCode", () => {
  test("trims, uppercases, and falls back to the default when empty", () => {
    const schema = currencyCode("EUR");
    expect(schema.parse(" usd ")).toBe("USD");
    expect(schema.parse("")).toBe("EUR");
    expect(schema.parse("   ")).toBe("EUR");
  });

  test("without a default, empty stays empty", () => {
    expect(currencyCode().parse("")).toBe("");
  });
});

describe("fieldErrorsFromZod", () => {
  const schema = z.object({
    transaction_date: requiredString("validation.required"),
    amount: moneyAmount({ required: "validation.required", invalid: "addTxn.invalidAmount" }),
  });
  const idMap = { transaction_date: "tx_date", amount: "tx_amount" };
  const translate = (key: string) => `T:${key}`;

  test("maps schema paths to DOM ids and translates the key", () => {
    const result = schema.safeParse({ transaction_date: "", amount: "abc" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(fieldErrorsFromZod(result.error, idMap, translate)).toEqual({
      tx_date: "T:validation.required",
      tx_amount: "T:addTxn.invalidAmount",
    });
  });

  test("returns an empty map for no error, and ignores unmapped paths", () => {
    expect(fieldErrorsFromZod(undefined, idMap, translate)).toEqual({});
    const other = z.object({ note: requiredString("validation.required") }).safeParse({ note: "" });
    if (other.success) return;
    expect(fieldErrorsFromZod(other.error, idMap, translate)).toEqual({});
  });
});
