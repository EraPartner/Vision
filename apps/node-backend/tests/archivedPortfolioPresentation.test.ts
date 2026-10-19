import { describe, expect, it } from "vitest";
import { buildArchivedPortfolioPresentation } from "../src/services/portfolio/archivedPortfolioPresentation.ts";
import {
  makeInvestmentRow,
  makePortfolioTransactionRow,
} from "./builders/domainRows.ts";
import {
  toPgSummaryInvestmentRow,
  toPgMathTxRow,
} from "./helpers/portfolioPgRows.ts";
import type { InvestmentSummary } from "../src/services/portfolio/portfolioSummaryService.ts";
import { asInvestmentId } from "@vision/types/brands";

const investment = toPgSummaryInvestmentRow(
  makeInvestmentRow({
    id: 1,
    asset_class: "stock",
    currency: "USD",
    current_price: 200,
    is_active: false,
  }),
);
const canonical = [
  {
    id: 1,
    totalInKindIncome: 4.9,
    byAccount: [],
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    nativeCurrentValue: 200,
    gainLoss: 999,
  },
] as unknown as InvestmentSummary[];
const tx = (overrides: Parameters<typeof makePortfolioTransactionRow>[0]) =>
  toPgMathTxRow(
    makePortfolioTransactionRow({
      investment_id: 1,
      currency: "USD",
      date: "2026-01-01",
      type: "buy",
      amount: 100,
      units: 1,
      fees: 0,
      taxes: 0,
      ...overrides,
    }),
  );

describe("Archived ordinary presentation parity", () => {
  it("preserves current quote FX separately from dated canonical figures", () => {
    const transactions = [tx({ id: 1, fx_rate_to_eur: 0.5 })];
    const rows = buildArchivedPortfolioPresentation(
      [investment],
      transactions,
      canonical,
      new Map([["USD", 0.8]]),
      new Set<string>(),
      "weighted_avg",
      "2026-06-01",
    );
    expect(rows[0]).toMatchObject({
      currentValue: 160,
      totalInvested: 80,
      realizedGain: 0,
      unrealizedGain: 80,
      gainLoss: 80,
      totalUnits: 1,
      totalInKindIncome: 4.9,
      transactionCount: 1,
      summarySource: "local",
      nativeCurrentPrice: 200,
      nativeAvgCostBasis: 100,
    });
    // Frozen-date stamp must not turn the web archive's cost into 50 (canonical dated FX).
    expect(rows[0]?.avgCostBasis).toBe(80);
  });
  it("keeps active rows out and returns unrounded ordinary web amounts", () => {
    const active = { ...investment, id: asInvestmentId(2), is_active: true };
    const rows = buildArchivedPortfolioPresentation(
      [active, investment],
      [tx({ amount: 100.01, units: 1 })],
      canonical,
      new Map([["USD", 0.8]]),
      new Set<string>(),
      "weighted_avg",
      "2026-06-01",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalBuyCost).toBe(80.008);
    expect(rows[0]?.totalInKindIncome).toBe(4.9);
  });
  it("uses at most the same newest 1000 ordinary rows as the web archive", () => {
    const txns = Array.from({ length: 1001 }, (_, i) =>
      tx({ id: i + 1, amount: 1, units: 1, date: "2026-01-01" }),
    );
    const rows = buildArchivedPortfolioPresentation(
      [investment],
      txns,
      canonical,
      new Map([["USD", 1]]),
      new Set<string>(),
      "weighted_avg",
      "2026-06-01",
    );
    expect(rows[0]?.transactionCount).toBe(1000);
    expect(rows[0]?.totalBuyCost).toBe(1000);
  });
});
