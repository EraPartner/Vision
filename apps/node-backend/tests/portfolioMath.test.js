import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  calculateCostBasisFIFO,
  calculateCostBasisLIFO,
} from "@vision/shared-utils/portfolio";
import {
  calculateAccruedInterest,
  sanitizeSnapshotSpikes,
} from "../src/services/calculations/portfolioMath.js";

describe("calculateCostBasisFIFO", () => {
  it("returns zeros for empty transactions", () => {
    const result = calculateCostBasisFIFO([]);
    expect(result.totalUnits).toBe(0);
    expect(result.totalCost).toBe(0);
    expect(result.realizedGain).toBe(0);
    expect(result.totalSellProceeds).toBe(0);
  });

  it("accumulates buy-only position", () => {
    const txns = [
      {
        type: "buy",
        units: 10,
        amount: 100,
        fees: 0,
        taxes: 0,
        date: "2024-01-01",
      },
    ];
    const result = calculateCostBasisFIFO(txns);
    expect(result.totalUnits).toBe(10);
    expect(result.totalCost).toBe(100);
    expect(result.avgCostBasis).toBe(10);
    expect(result.realizedGain).toBe(0);
  });

  it("exhausts oldest lot first (FIFO ordering)", () => {
    const txns = [
      {
        type: "buy",
        units: 5,
        amount: 50,
        fees: 0,
        taxes: 0,
        date: "2024-01-01",
      },
      {
        type: "buy",
        units: 10,
        amount: 200,
        fees: 0,
        taxes: 0,
        date: "2024-01-02",
      },
      {
        type: "sell",
        units: 5,
        amount: 75,
        fees: 0,
        taxes: 0,
        date: "2024-01-03",
      },
    ];
    const result = calculateCostBasisFIFO(txns);
    // FIFO exhausts lot1 (costBasis=50): realizedGain = 75 - 50 = 25
    expect(result.realizedGain).toBe(25);
    expect(result.totalUnits).toBe(10);
  });

  it("caps sell units at available and scales proceeds proportionally (oversell)", () => {
    const txns = [
      {
        type: "buy",
        units: 10,
        amount: 100,
        fees: 0,
        taxes: 0,
        date: "2024-01-01",
      },
      {
        type: "sell",
        units: 20,
        amount: 200,
        fees: 0,
        taxes: 0,
        date: "2024-01-02",
      },
    ];
    const result = calculateCostBasisFIFO(txns);
    // sellRatio = min(20,10)/20 = 0.5; netProceeds = 200*0.5 = 100; costOfSold = 100
    expect(result.totalUnits).toBe(0);
    expect(result.realizedGain).toBe(0);
    expect(result.totalSellProceeds).toBe(100);
  });

  it("applies split events — doubles units, preserves total cost", () => {
    const txns = [
      {
        type: "buy",
        units: 10,
        amount: 100,
        fees: 0,
        taxes: 0,
        date: "2024-01-01",
      },
      {
        type: "split",
        units: 20,
        amount: 0,
        fees: 0,
        taxes: 0,
        date: "2024-01-02",
      },
    ];
    const result = calculateCostBasisFIFO(txns);
    expect(result.totalUnits).toBe(20);
    expect(result.totalCost).toBe(100);
    expect(result.avgCostBasis).toBe(5);
  });
});

describe("calculateCostBasisLIFO", () => {
  it("returns zeros for empty transactions", () => {
    const result = calculateCostBasisLIFO([]);
    expect(result.totalUnits).toBe(0);
    expect(result.realizedGain).toBe(0);
  });

  it("exhausts newest lot first — opposite realized gain from FIFO", () => {
    // Two buys at different costs; sell exhausts the more-expensive recent lot (LIFO)
    // vs the cheaper old lot (FIFO), flipping realized gain from positive to negative.
    const txns = [
      {
        type: "buy",
        units: 5,
        amount: 50,
        fees: 0,
        taxes: 0,
        date: "2024-01-01",
      },
      {
        type: "buy",
        units: 10,
        amount: 200,
        fees: 0,
        taxes: 0,
        date: "2024-01-02",
      },
      {
        type: "sell",
        units: 5,
        amount: 75,
        fees: 0,
        taxes: 0,
        date: "2024-01-03",
      },
    ];
    const lifo = calculateCostBasisLIFO(txns);
    const fifo = calculateCostBasisFIFO(txns);
    // LIFO takes from lot2 (200/10=20/unit × 5 = 100): gain = 75 - 100 = -25
    // FIFO takes from lot1 (50/5=10/unit × 5 = 50): gain = 75 - 50 = 25
    expect(lifo.realizedGain).toBe(-25);
    expect(fifo.realizedGain).toBe(25);
    expect(lifo.totalUnits).toBe(fifo.totalUnits);
  });

  it("caps sell units at available and scales proceeds proportionally (oversell)", () => {
    const txns = [
      {
        type: "buy",
        units: 5,
        amount: 50,
        fees: 0,
        taxes: 0,
        date: "2024-01-01",
      },
      {
        type: "sell",
        units: 15,
        amount: 150,
        fees: 0,
        taxes: 0,
        date: "2024-01-02",
      },
    ];
    const result = calculateCostBasisLIFO(txns);
    // sellRatio = min(15,5)/15 = 1/3; netProceeds = 150*(1/3) = 50; costOfSold = 50
    expect(result.totalUnits).toBe(0);
    expect(result.realizedGain).toBe(0);
    expect(result.totalSellProceeds).toBe(50);
  });
});

describe("calculateAccruedInterest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns 0 when interestRate is 0", () => {
    vi.setSystemTime(new Date("2024-07-01T00:00:00Z"));
    expect(
      calculateAccruedInterest([{ type: "buy", date: "2024-01-01" }], 1000, 0),
    ).toBe(0);
  });

  it("returns 0 when principal is 0", () => {
    vi.setSystemTime(new Date("2024-07-01T00:00:00Z"));
    expect(
      calculateAccruedInterest([{ type: "buy", date: "2024-01-01" }], 0, 5),
    ).toBe(0);
  });

  it("returns 0 when no buy or interest transaction exists", () => {
    vi.setSystemTime(new Date("2024-07-01T00:00:00Z"));
    expect(calculateAccruedInterest([], 1000, 5)).toBe(0);
  });

  it("computes exact simple interest over 365 days from first buy", () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    const txns = [{ type: "buy", date: "2023-01-01" }];
    // 365 days, 5% annual → 1000 × 0.05 / 365 × 365 = 50
    expect(calculateAccruedInterest(txns, 1000, 5)).toBeCloseTo(50, 4);
  });

  it("uses last interest payment date as start, not first buy", () => {
    vi.setSystemTime(new Date("2024-01-10T00:00:00Z"));
    const txns = [
      { type: "buy", date: "2024-01-01" },
      { type: "interest", date: "2024-01-05" },
    ];
    // From interest date (Jan 5): 5 days elapsed; from buy date (Jan 1): 9 days
    const result = calculateAccruedInterest(txns, 1000, 5);
    expect(result).toBeCloseTo(1000 * (5 / 100 / 365) * 5, 4);
  });

  it("returns 0 when start date is in the future", () => {
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    expect(
      calculateAccruedInterest([{ type: "buy", date: "2025-01-01" }], 1000, 5),
    ).toBe(0);
  });
});

describe("sanitizeSnapshotSpikes", () => {
  it("returns empty array for non-array input", () => {
    expect(sanitizeSnapshotSpikes(null)).toEqual([]);
  });

  it("returns input reference unchanged when fewer than 3 elements", () => {
    const snapshots = [{ value: 100 }, { value: 200 }];
    expect(sanitizeSnapshotSpikes(snapshots)).toBe(snapshots);
  });

  it("leaves non-spike sequences untouched", () => {
    const snapshots = [{ value: 100 }, { value: 110 }, { value: 120 }];
    const result = sanitizeSnapshotSpikes(snapshots);
    expect(result[1].value).toBe(110);
  });

  it("replaces a high needle spike (localNeedlePeak) with geo mean of neighbors", () => {
    // 500 >= max(100, 102) * 1.8 = 183.6 → spike. Replacement is rounded to
    // cents (shared implementation with sanitizeIsolatedValueSpikes).
    const snapshots = [{ value: 100 }, { value: 500 }, { value: 102 }];
    const result = sanitizeSnapshotSpikes(snapshots);
    expect(result[1].value).toBeCloseTo(Math.sqrt(100 * 102), 2);
  });

  it("replaces a low needle spike (localNeedleTrough) with geo mean of neighbors", () => {
    // 20 * 1.8 = 36 <= min(100, 102) = 100 → trough spike
    const snapshots = [{ value: 100 }, { value: 20 }, { value: 102 }];
    const result = sanitizeSnapshotSpikes(snapshots);
    expect(result[1].value).toBeCloseTo(Math.sqrt(100 * 102), 2);
  });

  it("does not smooth a needle when the neighbors disagree (abnormal bridge)", () => {
    // 400 >= max(100, 200) * 1.8 = 360, but prev→next doubles (bridge is NOT
    // normal) — the series is repricing, not needling. The unguarded legacy
    // copy smoothed this; the shared bridge-guarded rule must keep it.
    const snapshots = [{ value: 100 }, { value: 400 }, { value: 200 }];
    const result = sanitizeSnapshotSpikes(snapshots);
    expect(result[1].value).toBe(400);
  });

  it("does not mutate the input array or its elements", () => {
    const snapshots = [{ value: 100 }, { value: 500 }, { value: 102 }];
    sanitizeSnapshotSpikes(snapshots);
    expect(snapshots[1].value).toBe(500);
  });
});

describe("sanitizeSnapshotSpikes decomposition invariant", () => {
  // snapshotBuilder builds every row as
  //   value = stocks_etfs_value + crypto_value + metals_value + cash_value
  // (unit-priced stock/etf/crypto/metals + the non-unit savings/bond/real_estate
  // bucket). Rows below satisfy it exactly, as the day walk's output does.
  const decompositionError = (row) =>
    row.value -
    (row.stocks_etfs_value +
      row.crypto_value +
      row.metals_value +
      row.cash_value);

  it("keeps Σ components == value on a price needle where cash moves across the needle", () => {
    const snapshots = [
      {
        value: 18000,
        stocks_etfs_value: 5000,
        crypto_value: 2000,
        metals_value: 1000,
        cash_value: 10000,
      },
      // Bad crypto tick (2000 → 20000) on the same day a 15k deposit sits in savings.
      {
        value: 51000,
        stocks_etfs_value: 5000,
        crypto_value: 20000,
        metals_value: 1000,
        cash_value: 25000,
      },
      {
        value: 18360,
        stocks_etfs_value: 5100,
        crypto_value: 2040,
        metals_value: 1020,
        cash_value: 10200,
      },
    ];
    for (const row of snapshots)
      expect(decompositionError(row)).toBeCloseTo(0, 6);

    const result = sanitizeSnapshotSpikes(snapshots);

    // The needle is gone from the market legs...
    expect(result[1].crypto_value).toBeCloseTo(Math.sqrt(2000 * 2040), 2);
    // ...cash is never invented — the real balance survives...
    expect(result[1].cash_value).toBe(25000);
    // ...and the row still decomposes.
    expect(decompositionError(result[1])).toBeCloseTo(0, 2);
  });

  it("does not fabricate a loss day when a one-day cash transit trips needle detection", () => {
    // No market movement at all: a 50k deposit lands and leaves the next day.
    // Detection runs on TOTAL value, so it fires; smoothing `value` while
    // `invested` stays at 68000 would persist a 50k loss that never happened.
    const snapshots = [
      {
        value: 18000,
        invested: 18000,
        stocks_etfs_value: 5000,
        crypto_value: 2000,
        metals_value: 1000,
        cash_value: 10000,
      },
      {
        value: 68000,
        invested: 68000,
        stocks_etfs_value: 5000,
        crypto_value: 2000,
        metals_value: 1000,
        cash_value: 60000,
      },
      {
        value: 18000,
        invested: 18000,
        stocks_etfs_value: 5000,
        crypto_value: 2000,
        metals_value: 1000,
        cash_value: 10000,
      },
    ];

    const result = sanitizeSnapshotSpikes(snapshots);

    expect(result[1].cash_value).toBe(60000);
    expect(result[1].value).toBeCloseTo(68000, 2);
    expect(result[1].value - result[1].invested).toBeCloseTo(0, 2);
  });

  it("keeps value_fx_neutral == value for an all-EUR portfolio across a needle", () => {
    // With no foreign-currency holdings, snapshotBuilder produces
    // value_fx_neutral == value on every single day by construction, and
    // PerformancePage gates the FX-attribution line on ANY day differing by
    // more than 0.01. Reconciling `value` to Σ legs while value_fx_neutral kept
    // its own geometric mean would hand a EUR-only user a phantom FX effect.
    const snapshots = [
      {
        value: 18000,
        value_fx_neutral: 18000,
        stocks_etfs_value: 5000,
        crypto_value: 2000,
        metals_value: 1000,
        cash_value: 10000,
      },
      {
        value: 86000,
        value_fx_neutral: 86000,
        stocks_etfs_value: 5000,
        crypto_value: 20000,
        metals_value: 1000,
        cash_value: 60000,
      },
      {
        value: 18360,
        value_fx_neutral: 18360,
        stocks_etfs_value: 5100,
        crypto_value: 2040,
        metals_value: 1020,
        cash_value: 10200,
      },
    ];

    const result = sanitizeSnapshotSpikes(snapshots);

    // Exactly equal, not merely under the 0.01 gate — the ratio is 1 by
    // construction here, so there is no rounding slack to spend.
    for (const [i, row] of result.entries()) {
      expect(row.value_fx_neutral, `row ${i} shows a phantom FX effect`).toBe(
        row.value,
      );
    }
  });

  it("preserves the real FX ratio of the market legs across a needle", () => {
    // 4% cumulative currency effect on the market legs, no effect on cash
    // (non-unit values accrue at txn-date rates — snapshotBuilder:677-679 adds
    // the same cash figure to both totals). The ratio must survive smoothing
    // rather than being flattened to 1.
    const marketRatio = 0.96;
    const row = (stocks, crypto, metals, cash) => ({
      value: stocks + crypto + metals + cash,
      value_fx_neutral: (stocks + crypto + metals) * marketRatio + cash,
      stocks_etfs_value: stocks,
      crypto_value: crypto,
      metals_value: metals,
      cash_value: cash,
    });
    const snapshots = [
      row(5000, 2000, 1000, 10000),
      row(5000, 20000, 1000, 10000),
      row(5100, 2040, 1020, 10000),
    ];

    const result = sanitizeSnapshotSpikes(snapshots);

    const smoothed = result[1];
    const recoveredRatio =
      (smoothed.value_fx_neutral - smoothed.cash_value) /
      (smoothed.value - smoothed.cash_value);
    expect(recoveredRatio).toBeCloseTo(marketRatio, 6);
  });

  it("falls back to the geometric mean when the input rows do not decompose", () => {
    // Legacy/partial rows (e.g. written before the component columns existed):
    // there is no trustworthy decomposition to reconcile to, so the historical
    // needle rule must stand rather than invent a total from partial legs.
    const snapshots = [{ value: 100 }, { value: 500 }, { value: 102 }];
    const result = sanitizeSnapshotSpikes(snapshots);
    expect(result[1].value).toBeCloseTo(Math.sqrt(100 * 102), 2);
  });
});

describe("UTC day-walk DST safety", () => {
  it("produces correct days across European spring-forward boundary (2024-03-31)", () => {
    // European DST springs forward on 2024-03-31 at 02:00 — that day is only 23h locally.
    // setUTCDate always steps exactly 24h regardless of local DST, so the walk must yield 3 days.
    const start = new Date("2024-03-30T00:00:00Z");
    const end = new Date("2024-04-01T00:00:00Z");
    const days = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().split("T")[0]);
    }
    expect(days).toEqual(["2024-03-30", "2024-03-31", "2024-04-01"]);
  });
});
