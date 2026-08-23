import { describe, expect, it } from "vitest";
import {
  sumConvertedAmounts,
  sumConvertedMonthlyAmounts,
} from "@/features/planned/plannedCurrencyTotals";

describe("sumConvertedAmounts", () => {
  it("excludes amounts with unavailable exchange rates instead of blending currencies", () => {
    const items = [
      { amount: -10, currency: "EUR", multiplier: 1 },
      { amount: -20, currency: "USD", multiplier: 2 },
      { amount: -99, currency: "GBP", multiplier: 1 },
    ];
    const convertAmount = (amount: number, currency?: string) => {
      if (currency === "GBP") return undefined;
      if (currency === "USD") return amount * 0.9;
      return amount;
    };

    expect(sumConvertedAmounts(items, convertAmount, (item) => item.multiplier)).toEqual({
      total: -46,
      unavailableCount: 1,
    });
  });

  it("includes only active recurring rows and reports missing monthly conversions", () => {
    const items = [
      { amount: -10, currency: "EUR", is_active: true, is_recurring: true, frequency: "monthly" },
      { amount: -20, currency: "USD", is_active: true, is_recurring: true, frequency: "weekly" },
      { amount: -30, currency: "GBP", is_active: true, is_recurring: true, frequency: "monthly" },
      { amount: -40, currency: "EUR", is_active: false, is_recurring: true, frequency: "monthly" },
      { amount: -50, currency: "EUR", is_active: true, is_recurring: false, frequency: "monthly" },
    ];
    const convertAmount = (amount: number, currency?: string) => {
      if (currency === "GBP") return undefined;
      if (currency === "USD") return amount * 0.9;
      return amount;
    };

    expect(sumConvertedMonthlyAmounts(items, convertAmount)).toEqual({
      total: -87.94,
      unavailableCount: 1,
    });
  });
});
