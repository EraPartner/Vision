import { describe, expect, it } from "vitest";
import { calculateAccruedInterest } from "../src/portfolio.ts";

// Simple interest, actual/365: principal × rate × days / 365 per principal
// segment since the last interest payment.
const accrue = (principal: number, ratePct: number, days: number) =>
  (principal * ratePct * days) / 100 / 365;

describe("calculateAccruedInterest per principal segment", () => {
  it("accrues a top-up only from its own date (term deposit, 2.5%)", () => {
    // €12,000 deposited, interest paid 2025-05-07, €3,000 top-up 2025-10-13.
    // 2025-05-07 → 2025-10-13 = 159 days at 12,000; 2025-10-13 → 2026-10-21
    // = 373 days at 15,000: 130.68 + 383.22 = 513.90 (today's principal over
    // all 532 days would give 546.58).
    const txns = [
      { type: "buy", date: "2024-05-19", amount: 12000 },
      { type: "interest", date: "2025-05-07", amount: 180 },
      { type: "buy", date: "2025-10-13", amount: 3000 },
    ];
    const result = calculateAccruedInterest(txns, 15000, 2.5, "2026-10-21");
    expect(result).toBeCloseTo(accrue(12000, 2.5, 159) + accrue(15000, 2.5, 373), 8);
    expect(Math.round(result * 100) / 100).toBe(513.9);
  });

  it("accrues the larger principal until a withdrawal", () => {
    const txns = [
      { type: "buy", date: "2026-01-01", amount: 10000 },
      { type: "sell", date: "2026-03-02", amount: 4000 },
    ];
    // 60 days at 10,000, then 30 days at 6,000.
    expect(calculateAccruedInterest(txns, 6000, 3, "2026-04-01")).toBeCloseTo(
      accrue(10000, 3, 60) + accrue(6000, 3, 30),
      8,
    );
  });

  it("reduces the principal after a return of capital", () => {
    const txns = [
      { type: "buy", date: "2026-01-01", amount: 5000 },
      { type: "return_of_capital", date: "2026-01-11", amount: 1000 },
    ];
    expect(calculateAccruedInterest(txns, 4000, 4, "2026-01-21")).toBeCloseTo(
      accrue(5000, 4, 10) + accrue(4000, 4, 10),
      8,
    );
  });

  it("keeps a change on the interest date in the starting principal", () => {
    const txns = [
      { type: "buy", date: "2026-01-01", amount: 1000 },
      { type: "interest", date: "2026-02-01", amount: 5 },
      { type: "buy", date: "2026-02-01", amount: 500 },
    ];
    expect(calculateAccruedInterest(txns, 1500, 2, "2026-03-03")).toBeCloseTo(
      accrue(1500, 2, 30),
      8,
    );
  });

  it("ignores a future-dated top-up for interest accrued so far", () => {
    const txns = [
      { type: "buy", date: "2026-01-01", amount: 1000 },
      { type: "buy", date: "2026-12-01", amount: 9000 },
    ];
    expect(calculateAccruedInterest(txns, 10000, 5, "2026-01-31")).toBeCloseTo(
      accrue(1000, 5, 30),
      8,
    );
  });
});
