import { describe, expect, it } from "vitest";
import { sumConvertedAmounts } from "@/features/planned/plannedCurrencyTotals";

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
});
