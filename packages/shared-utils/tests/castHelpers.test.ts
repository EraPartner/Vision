import { describe, expect, it } from "vitest";
import { isFiniteNumber } from "../src/numeric.ts";
import { isCostBasisMethod } from "../src/portfolio.ts";
import { coerceNumericFields } from "../src/money.ts";

describe("isFiniteNumber", () => {
  it("accepts finite numbers only", () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-1.5)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
    expect(isFiniteNumber("1")).toBe(false);
  });
});

describe("isCostBasisMethod", () => {
  it("accepts the three methods and nothing else", () => {
    for (const method of ["weighted_avg", "fifo", "lifo"])
      expect(isCostBasisMethod(method)).toBe(true);
    expect(isCostBasisMethod("average")).toBe(false);
    expect(isCostBasisMethod(null)).toBe(false);
    expect(isCostBasisMethod(1)).toBe(false);
  });
});

describe("coerceNumericFields typed overload", () => {
  it("turns the named string columns into numbers and keeps the rest", () => {
    const row = { id: 1, amount: "12.50", note: null as string | null };
    const out = coerceNumericFields(row, ["amount"] as const);
    expect(out).toEqual({ id: 1, amount: 12.5, note: null });
    const amount: number = out.amount;
    expect(amount).toBe(12.5);
  });
});
