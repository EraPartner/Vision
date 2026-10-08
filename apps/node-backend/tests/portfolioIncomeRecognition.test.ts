import { describe, expect, it } from "vitest";
import {
  buildInvestmentSummaryCore,
  buildInvestmentSummaryCorePartitioned,
} from "@vision/shared-utils/portfolio";
import type {
  CostBasisMethod,
  CostBasisTxnLike,
  InvestmentLike,
} from "@vision/shared-utils/portfolio";

const investment: InvestmentLike = { asset_class: "metals", current_price: 40 };
const positions = [
  {
    id: 1,
    type: "buy",
    date: "2025-01-02",
    units: 10,
    amount: 120,
    fxMultiplier: 0.8,
  },
  {
    id: 2,
    type: "gift",
    date: "2025-02-03",
    units: 2,
    amount: 0,
    fxMultiplier: 0.85,
  },
  {
    id: 4,
    type: "sell",
    date: "2025-03-04",
    units: 4,
    amount: 120,
    fxMultiplier: 0.9,
  },
] satisfies CostBasisTxnLike[];
const inKind = {
  id: 3,
  type: "dividend",
  date: "2025-02-03",
  amount: 50,
  fxMultiplier: 0.85,
  income_recognition_role: "included_in_units",
} satisfies CostBasisTxnLike;
const ordinary = {
  id: 5,
  type: "dividend",
  date: "2025-03-05",
  amount: 5,
  fxMultiplier: 0.92,
} satisfies CostBasisTxnLike;
const summarize = (
  transactions: readonly CostBasisTxnLike[],
  method: CostBasisMethod = "weighted_avg",
  inv: InvestmentLike = investment,
) =>
  buildInvestmentSummaryCore(inv, transactions, {
    costBasisMethod: method,
    todayYmd: "2025-04-01",
    fxMultiplierNow: 1.1,
  });

describe.each<CostBasisMethod>(["weighted_avg", "fifo", "lifo"])(
  "in-kind income with %s",
  (method) => {
    it("retains the distribution without adding its value again after some yielded units are sold", () => {
      const baseline = summarize(positions, method);
      const result = summarize([...positions, inKind], method);
      for (const field of [
        "totalUnits",
        "totalInvested",
        "currentValue",
        "realizedGain",
        "unrealizedGain",
        "gainLoss",
      ] as const)
        expect(result[field].eq(baseline[field])).toBe(true);
      expect(result.gainLoss.toNumber()).toBeCloseTo(320, 8);
      expect(result.totalInKindIncome.toNumber()).toBe(50);
      expect(result.totalIncome.toNumber()).toBe(0);
      expect(result.totalDividends.toNumber()).toBe(0);
    });

    it("uses transaction-date FX for the descriptive subtotal without changing converted gains", () => {
      const baseline = summarize(positions, method);
      const result = summarize([...positions, inKind], method);
      expect(result.converted.gainLoss.eq(baseline.converted.gainLoss)).toBe(
        true,
      );
      expect(result.converted.totalInKindIncome.toNumber()).toBe(42.5);
      expect(result.converted.gainLoss.toNumber()).toBeCloseTo(364, 8);
    });

    it("continues recognizing ordinary dividends alongside in-kind distributions", () => {
      const result = summarize([...positions, inKind, ordinary], method);
      expect(result.totalIncome.toNumber()).toBe(5);
      expect(result.totalDividends.toNumber()).toBe(5);
      expect(result.totalInKindIncome.toNumber()).toBe(50);
      expect(result.gainLoss.toNumber()).toBeCloseTo(325, 8);
      expect(result.converted.gainLoss.toNumber()).toBeCloseTo(368.6, 8);
    });

    it("keeps legacy unannotated and explicit standard dividends equivalent", () => {
      const legacy = summarize([...positions, ordinary], method);
      const explicit = summarize(
        [...positions, { ...ordinary, income_recognition_role: "standard" }],
        method,
      );
      expect(explicit.gainLoss.eq(legacy.gainLoss)).toBe(true);
      expect(explicit.converted.gainLoss.eq(legacy.converted.gainLoss)).toBe(
        true,
      );
    });
  },
);

it("rejects unknown roles rather than silently counting the income", () => {
  expect(() =>
    // @ts-expect-error -- an unknown role must be rejected at runtime
    summarize([{ ...inKind, income_recognition_role: "unverified" }]),
  ).toThrow(/Unsupported/);
});
it("rejects in-kind recognition on another transaction type", () => {
  expect(() => summarize([{ ...inKind, type: "rent_income" }])).toThrow(
    /unit-based dividend/,
  );
});
it("rejects in-kind recognition on an asset without unit valuation", () => {
  expect(() =>
    summarize([inKind], "weighted_avg", {
      asset_class: "savings",
      current_price: 40,
    }),
  ).toThrow(/unit-based dividend/);
});

it("partitioned and archived math keeps the new subtotal and both accounting tracks", () => {
  const result = buildInvestmentSummaryCorePartitioned(
    investment,
    [...positions, inKind, ordinary].map((t) => ({ ...t, account_id: 7 })),
    { costBasisMethod: "fifo", todayYmd: "2025-04-01", fxMultiplierNow: 1.1 },
  );
  expect(result.core.totalInKindIncome.toNumber()).toBe(50);
  expect(result.core.converted.totalInKindIncome.toNumber()).toBe(42.5);
  expect(result.core.totalIncome.toNumber()).toBe(5);
  expect(
    result.partitions[0].core.totalInKindIncome.eq(
      result.core.totalInKindIncome,
    ),
  ).toBe(true);
});
