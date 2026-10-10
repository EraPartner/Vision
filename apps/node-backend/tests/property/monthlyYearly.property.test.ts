/**
 * Summary properties for the production monthly repository helper shared by
 * live and materialized-view paths. This does not claim to compare yearly SQL
 * or validate database grouping and exclusions.
 */
import { describe, expect, it, vi } from "vitest";
import { mockConnection } from "../helpers/repoMocks.ts";

vi.mock("../../src/database/connection.ts", () => mockConnection());

import { buildMonthlySummary } from "../../src/repositories/infoRepositoryHelpers.ts";

function seeded(seed: number) {
  let t = seed >>> 0;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: production monthly summary", () => {
  it("preserves signed cents, counts and bounds across variable summary windows", () => {
    const rng = seeded(0x20251231);

    for (let trial = 0; trial < 100; trial++) {
      const entries = Array.from(
        { length: 1 + Math.floor(rng() * 36) },
        (_, index) => ({
          incomeCents: Math.floor(rng() * 500001) - 50000,
          spendingCents: Math.floor(rng() * 400001) - 50000,
          count: Math.floor(rng() * 100),
          period: `${2023 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`,
        }),
      );
      const months = entries.map((entry) => ({
        total_spending: entry.spendingCents / 100,
        total_income: entry.incomeCents / 100,
        net_amount: (entry.incomeCents - entry.spendingCents) / 100,
        transaction_count: entry.count,
        period_start: entry.period,
        period_end: entry.period,
      }));
      const summary = buildMonthlySummary(months);

      for (const [field, centsField] of [
        ["total_spending", "spendingCents"],
        ["total_income", "incomeCents"],
      ] as const) {
        const expectedCents = entries.reduce(
          (total, entry) => total + BigInt(entry[centsField]),
          0n,
        );
        expect(summary[field]).toBe(Number(expectedCents) / 100);
      }
      const expectedNetCents = entries.reduce(
        (total, entry) =>
          total + BigInt(entry.incomeCents - entry.spendingCents),
        0n,
      );
      expect(summary.net_amount).toBe(Number(expectedNetCents) / 100);
      expect(summary.transaction_count).toBe(
        entries.reduce((total, entry) => total + entry.count, 0),
      );
      expect(summary.period_start).toBe(months[0]!.period_start);
      expect(summary.period_end).toBe(months.at(-1)!.period_end);
    }
  });

  it("counts repeated rows and retains the caller's window bounds", () => {
    const month = {
      total_income: 0.3,
      total_spending: -0.2,
      net_amount: 0.5,
      transaction_count: 2,
      period_start: "2026-01-01",
      period_end: "2026-01-31",
    };
    expect(buildMonthlySummary([month, month])).toEqual({
      total_income: 0.6,
      total_spending: -0.4,
      net_amount: 1,
      transaction_count: 4,
      period_start: "2026-01-01",
      period_end: "2026-01-31",
    });
  });

  it("returns zero totals and absent bounds for empty input", () => {
    expect(buildMonthlySummary([])).toEqual({
      total_spending: 0,
      total_income: 0,
      net_amount: 0,
      transaction_count: 0,
      period_start: undefined,
      period_end: undefined,
    });
  });
});
