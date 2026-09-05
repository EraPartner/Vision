/**
 * ADR-108 partitioned engine — pure-math unit tests for the shared-utils core
 * (partitionTxnsByAccount / buildInvestmentSummaryCorePartitioned).
 *
 * Every expected number is hand-computed and chosen to be DISCRIMINATING: the
 * fixtures make the flat (cross-account) replay and the partitioned replay
 * disagree, so a partition engine that quietly falls back to global lot
 * consumption, mis-scales a split, or mis-allocates a return of capital fails
 * these tests instead of hiding behind symmetric numbers.
 */

import { describe, it, expect } from "vitest";

import {
  areLotsFullyAssigned,
  buildInvestmentSummaryCore,
  buildInvestmentSummaryCorePartitioned,
  partitionTxnsByAccount,
} from "@vision/shared-utils/portfolio";
import { toNumber, toDecimal } from "@vision/shared-utils/money";

const OPTS = { todayYmd: "2026-08-10" };
const stock = (current_price) => ({
  asset_class: "stock",
  current_price,
  interest_rate: 0,
});
const n = (d) => toNumber(toDecimal(d));

const buy = (accountId, units, amount, date, extra = {}) => ({
  type: "buy",
  units,
  amount,
  fees: 0,
  taxes: 0,
  date,
  account_id: accountId,
  ...extra,
});
const sell = (accountId, units, amount, date, extra = {}) => ({
  type: "sell",
  units,
  amount,
  fees: 0,
  taxes: 0,
  date,
  account_id: accountId,
  ...extra,
});

describe("areLotsFullyAssigned (transition predicate)", () => {
  it("is false when any buy/gift/sell lacks an account, regardless of other rows", () => {
    expect(areLotsFullyAssigned([buy(1, 10, 100, "2026-01-01")])).toBe(true);
    expect(areLotsFullyAssigned([buy(null, 10, 100, "2026-01-01")])).toBe(
      false,
    );
    expect(
      areLotsFullyAssigned([
        buy(1, 10, 100, "2026-01-01"),
        sell(null, 5, 60, "2026-02-01"), // unassigned SELL blocks too
      ]),
    ).toBe(false);
    expect(
      areLotsFullyAssigned([
        buy(1, 10, 100, "2026-01-01"),
        {
          type: "gift",
          units: 2,
          amount: 0,
          date: "2026-02-01",
          account_id: null,
        },
      ]),
    ).toBe(false);
    // Non-lot rows (dividends, corporate actions) never block assignment.
    expect(
      areLotsFullyAssigned([
        buy(1, 10, 100, "2026-01-01"),
        { type: "dividend", amount: 5, date: "2026-03-01", account_id: null },
        { type: "split", units: 20, date: "2026-04-01", account_id: null },
      ]),
    ).toBe(true);
    expect(areLotsFullyAssigned([])).toBe(true); // vacuously — nothing to assign
  });
});

describe("partitionTxnsByAccount — corporate actions apply across partitions", () => {
  it("rewrites a split into per-partition absolute totals that sum exactly to the global total", () => {
    // A holds 10, B holds 30 → 2:1 split to 80. A must become 20, B 60.
    const partitions = partitionTxnsByAccount([
      buy(1, 10, 1000, "2026-01-01"),
      buy(2, 30, 3300, "2026-01-02"),
      {
        type: "split",
        units: 80,
        amount: 0,
        fees: 0,
        taxes: 0,
        date: "2026-02-01",
        account_id: null,
      },
    ]);

    expect([...partitions.keys()].sort()).toEqual([1, 2]);
    const splitA = partitions.get(1).find((t) => t.type === "split");
    const splitB = partitions.get(2).find((t) => t.type === "split");
    expect(n(splitA.units)).toBe(20);
    expect(n(splitB.units)).toBe(60);
    // No unassigned partition minted for the fee-less rewritten action row.
    expect(partitions.has(null)).toBe(false);
  });

  it("allocates return_of_capital proportional to units held at that date", () => {
    // A holds 100, B holds 50 → 300 RoC splits 200 / 100.
    const partitions = partitionTxnsByAccount([
      buy(1, 100, 1000, "2026-01-01"),
      buy(2, 50, 1000, "2026-01-02"),
      {
        type: "return_of_capital",
        amount: 300,
        units: 0,
        fees: 0,
        taxes: 0,
        date: "2026-03-01",
        account_id: null,
      },
    ]);

    expect(
      n(partitions.get(1).find((t) => t.type === "return_of_capital").amount),
    ).toBe(200);
    expect(
      n(partitions.get(2).find((t) => t.type === "return_of_capital").amount),
    ).toBe(100);
  });

  it("keeps a corporate action row's own fees exactly once (no-op residual in its home partition)", () => {
    const partitions = partitionTxnsByAccount([
      buy(1, 10, 1000, "2026-01-01"),
      buy(2, 10, 1000, "2026-01-02"),
      {
        type: "split",
        units: 40,
        amount: 0,
        fees: 7,
        taxes: 3,
        date: "2026-02-01",
        account_id: null,
      },
    ]);

    const residuals = partitions.get(null) ?? [];
    expect(residuals).toHaveLength(1);
    expect(n(residuals[0].units)).toBe(0); // engine no-op
    expect(residuals[0].fees).toBe(7);
    expect(residuals[0].taxes).toBe(3);
    // …and the rewritten per-partition splits carry NO fees.
    expect(partitions.get(1).find((t) => t.type === "split").fees).toBe(0);
    expect(partitions.get(2).find((t) => t.type === "split").fees).toBe(0);
  });

  it("routes income rows to their own account's partition", () => {
    const partitions = partitionTxnsByAccount([
      buy(1, 10, 1000, "2026-01-01"),
      { type: "dividend", amount: 50, date: "2026-02-01", account_id: 2 },
      { type: "dividend", amount: 25, date: "2026-02-01", account_id: null },
    ]);
    expect(partitions.get(2).map((t) => t.type)).toEqual(["dividend"]);
    expect(partitions.get(null).map((t) => t.type)).toEqual(["dividend"]);
  });
});

describe("buildInvestmentSummaryCorePartitioned — sells consume SAME-account lots", () => {
  it("surfaces the oversold partition while preserving clamped values for repair", () => {
    const result = buildInvestmentSummaryCorePartitioned(
      stock(10),
      [
        buy(1, 5, 50, "2026-01-01"),
        buy(2, 5, 50, "2026-01-01"),
        sell(1, 7, 70, "2026-02-01"),
      ],
      { ...OPTS, costBasisMethod: "fifo" },
    );

    expect(result.core.oversold).toBe(true);
    expect(result.partitions.find((p) => p.accountId === 1).core.oversold).toBe(
      true,
    );
    expect(result.partitions.find((p) => p.accountId === 2).core.oversold).toBe(
      false,
    );
    expect(toNumber(result.core.totalUnits)).toBe(5);
    expect(toNumber(result.core.currentValue)).toBe(50);
  });

  // A: 100 @10 bought first, plus 10 @40 bought LAST. B: 25 @16 then 25 @24.
  // B sells 25 @30 (750). The flat replay would raid A's lots — FIFO takes
  // A's oldest 10/unit lot (cost 250 → gain 500), LIFO takes A's newest
  // 40/unit lot first (cost 760 → gain −10), weighted uses the blended
  // 15/unit average (cost 375 → gain 375). Partitioned must stay inside B,
  // where the three methods disagree among themselves:
  //   fifo   → cost 400 → realized 350
  //   lifo   → cost 600 → realized 150
  //   w-avg  → cost 500 → realized 250
  const txns = [
    buy(1, 100, 1000, "2026-01-01"),
    buy(2, 25, 400, "2026-02-01"),
    buy(2, 25, 600, "2026-02-15"),
    buy(1, 10, 400, "2026-02-20"),
    sell(2, 25, 750, "2026-03-01"),
  ];
  const inv = stock(12);

  it.each([
    ["fifo", 350, 600],
    ["lifo", 150, 400],
    ["weighted_avg", 250, 500],
  ])(
    "%s: realized gain comes from B's own lots; flat replay would differ",
    (method, expectedRealized, expectedRemainingCostB) => {
      const { core, partitions, fullyAssigned } =
        buildInvestmentSummaryCorePartitioned(inv, txns, {
          ...OPTS,
          costBasisMethod: method,
        });

      expect(fullyAssigned).toBe(true);
      const partB = partitions.find((p) => p.accountId === 2);
      const partA = partitions.find((p) => p.accountId === 1);
      expect(toNumber(partB.core.realizedGain)).toBe(expectedRealized);
      expect(toNumber(partB.core.totalInvested)).toBe(expectedRemainingCostB);
      expect(toNumber(partA.core.realizedGain)).toBe(0);
      expect(toNumber(partA.core.totalInvested)).toBe(1400);

      // Investment core ≡ Σ partitions (units, value, invested, realized, unrealized).
      expect(toNumber(core.totalUnits)).toBe(135);
      expect(toNumber(core.currentValue)).toBe(135 * 12);
      expect(toNumber(core.realizedGain)).toBe(expectedRealized);
      expect(toNumber(core.totalInvested)).toBe(1400 + expectedRemainingCostB);
      expect(toNumber(core.unrealizedGain)).toBeCloseTo(
        toNumber(partA.core.unrealizedGain) +
          toNumber(partB.core.unrealizedGain),
        10,
      );

      // And it genuinely differs from the flat cross-account replay.
      const flat = buildInvestmentSummaryCore(inv, txns, {
        ...OPTS,
        costBasisMethod: method,
      });
      expect(toNumber(flat.realizedGain)).not.toBe(expectedRealized);
    },
  );

  it("split-then-sell: the split rescales BOTH partitions before the sell consumes B's lots", () => {
    // A: 10 @1000. B: 10 @1100. 2:1 split → A 20, B 20. B sells 15 @900.
    //   B cost of sold = 1100 × 15/20 = 825 → realized 75, B remainder cost 275.
    //   Flat FIFO would consume A's whole post-split lot (cost 750 → gain 150).
    const rows = [
      buy(1, 10, 1000, "2026-01-01"),
      buy(2, 10, 1100, "2026-01-02"),
      {
        type: "split",
        units: 40,
        amount: 0,
        fees: 0,
        taxes: 0,
        date: "2026-02-01",
        account_id: null,
      },
      sell(2, 15, 900, "2026-03-01"),
    ];
    const { core, partitions } = buildInvestmentSummaryCorePartitioned(
      stock(55),
      rows,
      { ...OPTS, costBasisMethod: "fifo" },
    );

    const partA = partitions.find((p) => p.accountId === 1);
    const partB = partitions.find((p) => p.accountId === 2);
    expect(toNumber(partA.core.totalUnits)).toBe(20);
    expect(toNumber(partB.core.totalUnits)).toBe(5);
    expect(toNumber(partB.core.realizedGain)).toBe(75);
    expect(toNumber(partB.core.totalInvested)).toBe(275);
    expect(toNumber(core.totalUnits)).toBe(25);
    expect(toNumber(core.realizedGain)).toBe(75);

    const flat = buildInvestmentSummaryCore(stock(55), rows, {
      ...OPTS,
      costBasisMethod: "fifo",
    });
    expect(toNumber(flat.realizedGain)).toBe(150); // what a non-partitioned engine would claim
    expect(toNumber(flat.totalUnits)).toBe(25); // units are method/partition-invariant
  });

  it("return_of_capital reduces each partition's basis by its own unit share", () => {
    const rows = [
      buy(1, 100, 1000, "2026-01-01"),
      buy(2, 50, 1000, "2026-01-02"),
      {
        type: "return_of_capital",
        amount: 300,
        units: 0,
        fees: 0,
        taxes: 0,
        date: "2026-03-01",
        account_id: null,
      },
    ];
    const { core, partitions } = buildInvestmentSummaryCorePartitioned(
      stock(12),
      rows,
      { ...OPTS, costBasisMethod: "weighted_avg" },
    );

    expect(
      toNumber(partitions.find((p) => p.accountId === 1).core.totalInvested),
    ).toBe(800); // 1000 − 200
    expect(
      toNumber(partitions.find((p) => p.accountId === 2).core.totalInvested),
    ).toBe(900); // 1000 − 100
    expect(toNumber(core.totalInvested)).toBe(1700);

    // With no sells the flat engine agrees on the total — RoC allocation must
    // not change Σ, only its distribution.
    const flat = buildInvestmentSummaryCore(stock(12), rows, {
      ...OPTS,
      costBasisMethod: "weighted_avg",
    });
    expect(toNumber(flat.totalInvested)).toBe(1700);
  });

  it("re-tag = the math is a pure function of the rows' CURRENT account_id", () => {
    const before = buildInvestmentSummaryCorePartitioned(
      stock(12),
      [buy(1, 100, 1000, "2026-01-01"), buy(2, 50, 1000, "2026-01-02")],
      { ...OPTS, costBasisMethod: "fifo" },
    );
    // Whole-lot re-tag of B's lot onto A (basis travels with the lot).
    const after = buildInvestmentSummaryCorePartitioned(
      stock(12),
      [buy(1, 100, 1000, "2026-01-01"), buy(1, 50, 1000, "2026-01-02")],
      { ...OPTS, costBasisMethod: "fifo" },
    );

    expect(after.partitions).toHaveLength(1);
    expect(after.partitions[0].accountId).toBe(1);
    expect(toNumber(after.partitions[0].core.totalInvested)).toBe(2000);
    expect(toNumber(after.core.totalInvested)).toBe(
      toNumber(before.core.totalInvested),
    );
    expect(toNumber(after.core.currentValue)).toBe(
      toNumber(before.core.currentValue),
    );
  });
});

describe("buildInvestmentSummaryCorePartitioned — transition & degenerate cases", () => {
  it("any unassigned lot → flat global core, whole investment on the null partition", () => {
    const rows = [
      buy(1, 100, 1000, "2026-01-01"),
      buy(null, 50, 1000, "2026-01-02"),
      sell(1, 25, 500, "2026-02-01"),
    ];
    const { core, partitions, fullyAssigned } =
      buildInvestmentSummaryCorePartitioned(stock(12), rows, {
        ...OPTS,
        costBasisMethod: "fifo",
      });
    const flat = buildInvestmentSummaryCore(stock(12), rows, {
      ...OPTS,
      costBasisMethod: "fifo",
    });

    expect(fullyAssigned).toBe(false);
    expect(partitions).toHaveLength(1);
    expect(partitions[0].accountId).toBe(null);
    for (const field of [
      "totalUnits",
      "totalInvested",
      "realizedGain",
      "unrealizedGain",
      "currentValue",
      "gainLoss",
    ]) {
      expect(toNumber(core[field])).toBe(toNumber(flat[field]));
    }
  });

  it("fully assigned to ONE broker: identical to the flat replay, attributed to that broker", () => {
    const rows = [
      buy(7, 10, 1000, "2026-01-01"),
      {
        type: "split",
        units: 20,
        amount: 0,
        fees: 0,
        taxes: 0,
        date: "2026-02-01",
        account_id: null,
      },
      sell(7, 5, 600, "2026-03-01"),
      {
        type: "return_of_capital",
        amount: 100,
        units: 0,
        fees: 0,
        taxes: 0,
        date: "2026-04-01",
        account_id: null,
      },
    ];
    const { core, partitions, fullyAssigned } =
      buildInvestmentSummaryCorePartitioned(stock(120), rows, {
        ...OPTS,
        costBasisMethod: "lifo",
      });
    const flat = buildInvestmentSummaryCore(stock(120), rows, {
      ...OPTS,
      costBasisMethod: "lifo",
    });

    expect(fullyAssigned).toBe(true);
    expect(partitions).toHaveLength(1);
    expect(partitions[0].accountId).toBe(7);
    for (const field of [
      "totalUnits",
      "totalInvested",
      "realizedGain",
      "unrealizedGain",
      "currentValue",
      "gainLoss",
    ]) {
      expect(toNumber(core[field])).toBe(toNumber(flat[field]));
    }
  });

  it("non-unit-based investments attribute whole-investment only (accrual is non-linear)", () => {
    const savings = {
      asset_class: "savings",
      current_price: 0,
      interest_rate: 3,
    };
    const rows = [
      {
        type: "buy",
        amount: 10000,
        units: 0,
        date: "2026-01-01",
        account_id: 4,
      },
      {
        type: "interest",
        amount: 100,
        units: 0,
        date: "2026-06-01",
        account_id: 4,
      },
    ];
    const single = buildInvestmentSummaryCorePartitioned(savings, rows, OPTS);
    expect(single.fullyAssigned).toBe(true);
    expect(single.partitions).toHaveLength(1);
    expect(single.partitions[0].accountId).toBe(4);

    const mixed = buildInvestmentSummaryCorePartitioned(
      savings,
      [rows[0], { ...rows[1], account_id: 9 }],
      OPTS,
    );
    expect(mixed.fullyAssigned).toBe(false);
    expect(mixed.partitions).toHaveLength(1);
    expect(mixed.partitions[0].accountId).toBe(null);
  });

  it("no transactions → no partitions, vacuously fully assigned", () => {
    const empty = buildInvestmentSummaryCorePartitioned(stock(10), [], OPTS);
    expect(empty.partitions).toEqual([]);
    expect(empty.fullyAssigned).toBe(true);
    expect(toNumber(empty.core.currentValue)).toBe(0);
  });
});
