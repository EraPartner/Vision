/**
 * Holding gain outcomes of the shared portfolio engine, the one the portfolio
 * summary API serves: each fee, rent, tax and interest payment counts once.
 * Moved from the browser summary hook when archived holdings switched to
 * server summaries.
 */
import { describe, expect, it } from "vitest";
import { buildInvestmentSummaryCorePartitioned } from "@vision/shared-utils/portfolio";
import type { PartitionedTxnLike } from "@vision/shared-utils/portfolio";
import { toNumber } from "@vision/shared-utils/money";

const txn = (overrides: Partial<PartitionedTxnLike>): PartitionedTxnLike => ({
  type: "buy",
  amount: 0,
  units: 0,
  fees: 0,
  taxes: 0,
  date: "2026-01-01",
  account_id: null,
  ...overrides,
});

function gainLossOf(
  inv: { asset_class: string; current_price: number; interest_rate?: number },
  txns: PartitionedTxnLike[],
) {
  const { core } = buildInvestmentSummaryCorePartitioned(
    { interest_rate: 0, ...inv },
    txns,
    { todayYmd: "2026-08-10" },
  );
  return toNumber(core.gainLoss);
}

describe("holding gainLoss counts each cash flow once", () => {
  it("unit-based: a buy fee is folded into cost basis only once", () => {
    // Paid 110 (100 + 10 fee), worth 150: economic gain 40.
    expect(
      gainLossOf({ asset_class: "stock", current_price: 150 }, [
        txn({ amount: 100, units: 1, fees: 10 }),
      ]),
    ).toBe(40);
  });

  it("real estate: rent, fees and taxes counted once", () => {
    // appreciation 10000 + rent 12000 - fees 2000 - taxes 1000 = 19000.
    expect(
      gainLossOf({ asset_class: "real_estate", current_price: 0 }, [
        txn({ amount: 250000 }),
        txn({ type: "appreciation", amount: 10000 }),
        txn({ type: "rent_income", amount: 12000 }),
        txn({ type: "fee", amount: 2000 }),
        txn({ type: "tax", amount: 1000 }),
      ]),
    ).toBe(19000);
  });

  it("fixed income: interest received counted once", () => {
    // One 400 interest payment and no accrual: 400, not realized + income.
    expect(
      gainLossOf({ asset_class: "savings", current_price: 0 }, [
        txn({ amount: 10000, date: "2025-01-01" }),
        txn({ type: "interest", amount: 400, date: "2026-01-01" }),
      ]),
    ).toBe(400);
  });
});
