import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

import { mockLogger } from "./helpers/mockLogger.ts";
import { mockCurrencyConversion } from "./helpers/mockCurrencyConversion.ts";
import { mockTxConnection } from "./helpers/repoMocks.ts";
import {
  makeInvestmentRow,
  makePortfolioTransactionRow,
} from "./builders/domainRows.ts";
import {
  toPgMathTxRow,
  toPgSummaryInvestmentRow,
} from "./helpers/portfolioPgRows.ts";
vi.mock("../src/database/connection.ts", () => mockTxConnection());

vi.mock("../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

const { mockConvertToCurrency } = vi.hoisted(() => ({
  mockConvertToCurrency: vi.fn(async (amount, from, to) => {
    if (!from || from === to) return amount;
    return new Map([
      [1, 0.9],
      [100, 90],
      [200, 180],
    ]).get(Number(amount));
  }),
}));

vi.mock("../src/services/currency/currencyConversionService.ts", () =>
  mockCurrencyConversion({ convertToCurrency: mockConvertToCurrency }),
);

vi.mock("../src/repositories/settingsRepository.ts", () => ({
  settingsRepository: { get: vi.fn(async () => null) },
}));

import { __storeCurrentBrokerSnapshot } from "../src/services/portfolioPerformanceSnapshotService.ts";
import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { settingsRepository as rawSettingsRepository } from "../src/repositories/settingsRepository.ts";
import {
  getPortfolioSummary,
  getBreakdownSummary,
} from "../src/services/portfolio/portfolioSummaryService.ts";

/** `query` as these tests drive it: SQL text in, a bare `{ rows }` result out. */
const query = vi.mocked(rawQuery) as unknown as Mock<
  (sql: string, params?: readonly unknown[]) => Promise<Partial<PgQueryResult>>
>;
const settingsRepository = vi.mocked(rawSettingsRepository);

const investmentRow = (overrides = {}) =>
  toPgSummaryInvestmentRow(
    makeInvestmentRow({
      name: "Apple Inc",
      symbol: "AAPL",
      asset_class: "stock",
      currency: "USD",
      current_price: 200,
      interest_rate: 0,
      is_active: true,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      notes: null,
      location: null,
      municipality: null,
      cadastral_income: null,
      municipality_tax_rate: null,
      maturity_date: null,
      price_provider: null,
      price_provider_id: null,
      price_provider_url: null,
      price_provider_latest_url: null,
      price_provider_latest_path: null,
      price_provider_history_url: null,
      price_provider_history_path: null,
      price_provider_history_ts_path: null,
      price_provider_history_price_path: null,
      price_updated_at: null,
      ...overrides,
    }),
  );

const txnRow = (overrides = {}) =>
  toPgMathTxRow(
    makePortfolioTransactionRow({
      amount: 100,
      units: 1,
      fees: 0,
      taxes: 0,
      date: "2026-01-01",
      currency: "USD",
      fx_rate_to_eur: null,
      ...overrides,
    }),
  );

describe("getPortfolioSummary", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it.each(["weighted_avg", "fifo", "lifo"])(
    "normalizes EUR-booked USD quote basis at historical FX (%s)",
    async (method) => {
      settingsRepository.get.mockResolvedValue(method);
      query
        .mockResolvedValueOnce({ rows: [investmentRow({ current_price: 20 })] })
        .mockResolvedValueOnce({
          rows: [
            txnRow({
              type: "buy",
              units: 10,
              amount: 80,
              currency: "EUR",
              account_id: 7,
            }),
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              currency_code: "USD",
              rate_date: "2025-12-31",
              rate_to_eur: "0.8",
            },
          ],
        });
      try {
        const s = (await getPortfolioSummary("EUR")).summaries[0]!;
        // Booked EUR80 is USD100 basis at the prior day's0.8 daily quote rate.
        // Current USD200 value at0.9 is EUR180: asset gain90 plus FX gain10.
        expect(s.totalBuyCost).toBe(80);
        expect(s.currentValue).toBe(180);
        expect(s.gainLoss).toBe(100);
        expect(s.assetGain).toBe(90);
        expect(s.fxGain).toBe(10);
        expect(s.usedFallbackRate).toBe(false);
      } finally {
        settingsRepository.get.mockResolvedValue(null);
      }
    },
  );

  it("uses stamped USD booking FX for a EUR quote without changing EUR gain", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "EUR", current_price: 20 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            type: "buy",
            units: 10,
            amount: 100,
            fx_rate_to_eur: 0.8,
            account_id: 7,
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            currency_code: "USD",
            rate_date: "2026-01-01",
            rate_to_eur: "0.75",
          },
        ],
      });
    const s = (await getPortfolioSummary("EUR")).summaries[0]!;
    expect(s.totalBuyCost).toBe(80);
    expect(s.gainLoss).toBe(120);
    expect(s.assetGain).toBe(120);
    expect(s.fxGain).toBe(0);
    expect(s.usedFallbackRate).toBe(false);
  });

  it("discloses missing dated quote FX even when the booked EUR headline is exact", async () => {
    query
      .mockResolvedValueOnce({ rows: [investmentRow({ current_price: 20 })] })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            type: "buy",
            units: 10,
            amount: 80,
            currency: "EUR",
            account_id: 7,
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const s = (await getPortfolioSummary("EUR")).summaries[0]!;
    expect(s.totalBuyCost).toBe(80);
    expect(s.gainLoss).toBe(100);
    expect(s.assetGain).toBeCloseTo(100, 2);
    expect(s.fxGain).toBeCloseTo(0, 2);
    expect(s.usedFallbackRate).toBe(true);
  });

  it("returns empty totals when no investments exist", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPortfolioSummary("EUR");

    expect(result.summaries).toEqual([]);
    expect(result.totals).toEqual({
      totalPortfolioValue: 0,
      totalInvested: 0,
      totalGainLoss: 0,
      totalRealizedGain: 0,
      totalUnrealizedGain: 0,
      totalGain: 0,
      totalIncome: 0,
      totalDividends: 0,
      totalInKindIncome: 0,
      totalFees: 0,
      totalTaxes: 0,
      totalAssetGain: 0,
      totalFxGain: 0,
      totalReturnPct: 0,
      usedFallbackRate: false,
    });
    expect(result.currency).toBe("EUR");
    expect(result).not.toHaveProperty("brokerSnapshotParity");
  });

  it("stores broker snapshots despite accumulated investment display rounding", async () => {
    query
      .mockResolvedValueOnce({
        rows: Array.from({ length: 6 }, (_, index) =>
          investmentRow({
            id: index + 1,
            currency: "EUR",
            current_price: "100.006",
          }),
        ),
      })
      .mockResolvedValueOnce({
        rows: Array.from({ length: 6 }, (_, index) =>
          txnRow({
            id: index + 1,
            investment_id: index + 1,
            type: "buy",
            amount: 100,
            units: 1,
            currency: "EUR",
            account_id: 7,
          }),
        ),
      });
    const result = await getPortfolioSummary("EUR", {
      includeBrokerSnapshotParity: true,
    });
    expect(result.totals.totalPortfolioValue).toBe(600.06);
    expect(result.byAccount[0]!.currentValue).toBe(600.04);
    expect(result.brokerSnapshotParity).toEqual({
      totalValue: "600.036",
      partitionValue: "600.036",
    });
    query
      .mockResolvedValueOnce({
        rows: [{ relation: "portfolio_broker_snapshots" }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 7, display_name: "Test broker" }] })
      .mockResolvedValueOnce({ rows: [{ today: "2026-09-27" }] })
      .mockResolvedValue({ rows: [] });
    await expect(
      __storeCurrentBrokerSnapshot("EUR", result),
    ).resolves.toMatchObject({ stored: true, rows: 1 });
    const insert = query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO portfolio_broker_snapshots"),
    );
    expect(insert![1]![5]).toBe("600.04");
  });

  it("computes single-currency stock totals correctly", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "EUR", current_price: 200 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({ type: "buy", amount: 100, units: 1, currency: "EUR" }),
          txnRow({
            id: 2,
            type: "buy",
            amount: 110,
            units: 1,
            currency: "EUR",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");

    expect(result.summaries).toHaveLength(1);
    const s = result.summaries[0]!;
    expect(s.totalUnits).toBe(2);
    expect(s.totalBuyCost).toBe(210);
    expect(s.currentValue).toBe(400); // 2 units * 200
    expect(s.unrealizedGain).toBe(190); // (200 - 105) * 2
    expect(s.realizedGain).toBe(0);
    expect(s).not.toHaveProperty("description");

    expect(result.totals.totalPortfolioValue).toBe(400);
    expect(result.totals.totalInvested).toBe(210);
    expect(result.totals.totalUnrealizedGain).toBe(190);
  });

  it("pre-converts USD investments to EUR target currency", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "USD", current_price: 200 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: "buy", amount: 100, units: 1, currency: "USD" })],
      })
      // historical rate index: no stored rates → per-txn conversion falls back
      // to today's rate (0.9) and the response is flagged
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPortfolioSummary("EUR");
    const s = result.summaries[0]!;

    // 1 unit * 200 USD * 0.9 = 180 EUR
    expect(s.currentValue).toBe(180);
    // 100 USD buy cost * 0.9 = 90 EUR
    expect(s.totalBuyCost).toBe(90);
    expect(s.currency).toBe("EUR");
    expect(s.originalCurrency).toBe("USD");
    expect(s.usedFallbackRate).toBe(true);
    expect(result.totals.usedFallbackRate).toBe(true);
  });

  it("locks invested at the transaction-date rate and attributes the FX gain", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "USD", current_price: 200 })],
      })
      .mockResolvedValueOnce({
        // bought at 0.8 EUR/USD (stamped on the transaction)
        rows: [
          txnRow({
            type: "buy",
            amount: 100,
            units: 1,
            currency: "USD",
            fx_rate_to_eur: 0.8,
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPortfolioSummary("EUR");
    const s = result.summaries[0]!;

    // Invested locked at buy-date rate: 100 USD * 0.8 = 80 EUR (today's 0.9 must not move it)
    expect(s.totalInvested).toBe(80);
    expect(s.totalBuyCost).toBe(80);
    // Value at today's rate: 200 USD * 0.9 = 180 EUR
    expect(s.currentValue).toBe(180);
    // Total gain includes FX: 180 − 80 = 100 EUR …
    expect(s.gainLoss).toBe(100);
    // … decomposed into native performance (100 USD * 0.9 = 90 EUR) + FX on
    // the invested capital (100 USD * (0.9 − 0.8) = 10 EUR)
    expect(s.assetGain).toBe(90);
    expect(s.fxGain).toBe(10);
    expect(s.nativeCurrentValue).toBe(200);
    expect(s.usedFallbackRate).toBe(false);

    expect(result.totals.totalInvested).toBe(80);
    expect(result.totals.totalGainLoss).toBe(100);
    expect(result.totals.totalAssetGain).toBe(90);
    expect(result.totals.totalFxGain).toBe(10);
  });

  it("aggregates totals across mixed currencies in target currency", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({ id: 1, currency: "EUR", current_price: 100 }),
          investmentRow({
            id: 2,
            currency: "USD",
            current_price: 200,
            name: "MSFT",
            symbol: "MSFT",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            investment_id: 1,
            type: "buy",
            amount: 100,
            units: 1,
            currency: "EUR",
          }),
          txnRow({
            id: 2,
            investment_id: 2,
            type: "buy",
            amount: 200,
            units: 1,
            currency: "USD",
          }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPortfolioSummary("EUR");

    // EUR investment: 100 EUR value, 100 EUR cost
    // USD investment: 200 USD * 0.9 = 180 EUR value, 200 USD * 0.9 = 180 EUR cost
    expect(result.totals.totalPortfolioValue).toBe(280);
    expect(result.totals.totalInvested).toBe(280);
  });

  it("totalReturnPct equals totalGainLoss / totalInvested * 100", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "EUR", current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: "buy", amount: 100, units: 1, currency: "EUR" })],
      });

    const result = await getPortfolioSummary("EUR");
    const { totalGainLoss, totalInvested, totalReturnPct } = result.totals;

    expect(totalReturnPct).toBeCloseTo(
      (totalGainLoss / totalInvested) * 100,
      2,
    );
  });

  it("totals match the sum of summary fields (reconciliation invariant)", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({ id: 1, currency: "EUR", current_price: 150 }),
          investmentRow({
            id: 2,
            currency: "EUR",
            current_price: 50,
            name: "B",
            symbol: "B",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            investment_id: 1,
            type: "buy",
            amount: 100,
            units: 1,
            currency: "EUR",
          }),
          txnRow({
            id: 2,
            investment_id: 2,
            type: "buy",
            amount: 30,
            units: 1,
            currency: "EUR",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    const sumValue = result.summaries.reduce((s, x) => s + x.currentValue, 0);
    const sumInvested = result.summaries.reduce(
      (s, x) => s + x.totalBuyCost,
      0,
    );
    const sumGainLoss = result.summaries.reduce((s, x) => s + x.gainLoss, 0);

    expect(result.totals.totalPortfolioValue).toBeCloseTo(sumValue, 2);
    expect(result.totals.totalInvested).toBeCloseTo(sumInvested, 2);
    expect(result.totals.totalGainLoss).toBeCloseTo(sumGainLoss, 2);
  });

  it("totals carry the summed dividends the tax income tool splits from interest and rent", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({ id: 1, currency: "EUR", current_price: 150 }),
          investmentRow({
            id: 2,
            currency: "EUR",
            current_price: 50,
            name: "B",
            symbol: "B",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            investment_id: 1,
            type: "buy",
            currency: "EUR",
            amount: 100,
            units: 1,
          }),
          txnRow({
            id: 2,
            investment_id: 1,
            type: "dividend",
            currency: "EUR",
            amount: 12.5,
          }),
          txnRow({
            id: 3,
            investment_id: 2,
            type: "buy",
            currency: "EUR",
            amount: 30,
            units: 1,
          }),
          txnRow({
            id: 4,
            investment_id: 2,
            type: "dividend",
            currency: "EUR",
            amount: 7.25,
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    const sumDividends = result.summaries.reduce(
      (s, x) => s + x.totalDividends,
      0,
    );

    expect(sumDividends).toBeCloseTo(19.75, 2);
    expect(result.totals.totalDividends).toBeCloseTo(sumDividends, 2);
  });

  it("byAccount: an instrument with ANY unassigned lot collapses whole into the null row (ADR-108 transition rule — never wrong partitions)", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ id: 1, currency: "EUR", current_price: 12 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            investment_id: 1,
            type: "buy",
            amount: 1000,
            units: 100,
            currency: "EUR",
            account_id: 10,
          }),
          txnRow({
            id: 2,
            investment_id: 1,
            type: "buy",
            amount: 500,
            units: 50,
            currency: "EUR",
            account_id: 20,
          }),
          txnRow({
            id: 3,
            investment_id: 1,
            type: "buy",
            amount: 120,
            units: 10,
            currency: "EUR",
            account_id: null,
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");

    // Partially assigned → per-broker figures unavailable: everything on the
    // unassigned row; the summary flags it so the UI can render the nudge.
    expect(result.byAccount.map((a) => a.account_id)).toEqual([null]);
    expect(result.byAccount[0]).toMatchObject({
      assignment: "unassigned",
      oversold: false,
    });
    expect(result.summaries[0]!.fullyAssigned).toBe(false);
    expect(result.summaries[0]!.byAccount).toEqual(result.byAccount);
    // Global figures stay the exact flat-replay values.
    expect(result.byAccount[0]!.currentValue).toBeCloseTo(
      result.totals.totalPortfolioValue,
      2,
    );
    expect(result.byAccount[0]!.totalInvested).toBeCloseTo(
      result.totals.totalInvested,
      2,
    );
    expect(result.byAccount[0]!.gainLoss).toBeCloseTo(
      result.totals.totalGainLoss,
      2,
    );
    expect(result.totals.totalPortfolioValue).toBe(1920); // 160 units @ 12
  });

  it("keeps null-account position and non-position contributions separate", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({ id: 1, currency: "EUR", current_price: 12 }),
          investmentRow({
            id: 2,
            name: "Microsoft",
            symbol: "MSFT",
            currency: "EUR",
            current_price: 20,
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            investment_id: 1,
            type: "buy",
            amount: 1000,
            units: 100,
            currency: "EUR",
            account_id: null,
          }),
          txnRow({
            id: 2,
            investment_id: 2,
            type: "buy",
            amount: 200,
            units: 10,
            currency: "EUR",
            account_id: 10,
          }),
          txnRow({
            id: 3,
            investment_id: 2,
            type: "dividend",
            amount: 25,
            units: 0,
            currency: "EUR",
            account_id: null,
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");

    expect(result.summaries.map((summary) => summary.fullyAssigned)).toEqual([
      false,
      true,
    ]);
    expect(
      result.byAccount.map((row) => ({
        account_id: row.account_id,
        contribution_kind: row.contribution_kind,
      })),
    ).toEqual([
      { account_id: null, contribution_kind: "position" },
      { account_id: 10, contribution_kind: "position" },
      { account_id: null, contribution_kind: "non_position" },
    ]);
    expect(result.byAccount[2]).toMatchObject({
      assignment: "unassigned",
      currentValue: 0,
      totalInvested: 0,
    });
    const sum = (
      field:
        | "currentValue"
        | "totalInvested"
        | "realizedGain"
        | "unrealizedGain"
        | "gainLoss",
    ) => result.byAccount.reduce((total, row) => total + row[field], 0);
    expect(sum("currentValue")).toBeCloseTo(
      result.totals.totalPortfolioValue,
      2,
    );
    expect(sum("totalInvested")).toBeCloseTo(result.totals.totalInvested, 2);
    expect(sum("realizedGain")).toBeCloseTo(result.totals.totalRealizedGain, 2);
    expect(sum("unrealizedGain")).toBeCloseTo(
      result.totals.totalUnrealizedGain,
      2,
    );
    expect(sum("gainLoss")).toBeCloseTo(result.totals.totalGainLoss, 2);
  });

  it("byAccount: fully-assigned lots partition per broker — sells consume SAME-account lots (ADR-108)", async () => {
    settingsRepository.get.mockResolvedValueOnce("fifo");
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ id: 1, currency: "EUR", current_price: 12 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            investment_id: 1,
            type: "buy",
            amount: 1000,
            units: 100,
            currency: "EUR",
            date: "2026-01-01",
            account_id: 10,
          }),
          txnRow({
            id: 2,
            investment_id: 1,
            type: "buy",
            amount: 1000,
            units: 50,
            currency: "EUR",
            date: "2026-02-01",
            account_id: 20,
          }),
          txnRow({
            id: 3,
            investment_id: 1,
            type: "sell",
            amount: 600,
            units: 25,
            currency: "EUR",
            date: "2026-03-01",
            account_id: 20,
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");

    expect(result.summaries[0]!.fullyAssigned).toBe(true);
    expect(result.summaries[0]!.oversold).toBe(false);
    expect(result.byAccount.map((a) => a.account_id)).toEqual([10, 20]);
    expect(result.summaries[0]!.byAccount).toEqual(result.byAccount);

    // Account 20's sell consumes account 20's own 20/unit lot — NOT account
    // 10's older 10/unit lot that flat global FIFO would pick.
    const acc20 = result.byAccount.find((a) => a.account_id === 20)!;
    expect(acc20.realizedGain).toBe(100); // 600 − 25×20
    expect(acc20).toMatchObject({ assignment: "account", oversold: false });
    expect(acc20.unrealizedGain).toBe(-200); // 25×12 − 25×20
    expect(acc20.currentValue).toBe(300);
    const acc10 = result.byAccount.find((a) => a.account_id === 10);
    expect(acc10).toMatchObject({
      currentValue: 1200,
      totalInvested: 1000,
      realizedGain: 0,
      unrealizedGain: 200,
    });

    // The investment summary IS the partition sum (Σ partitions ≡ global).
    expect(result.summaries[0]!.realizedGain).toBe(100); // flat FIFO would say 350
    expect(result.totals.totalRealizedGain).toBe(100);
    const sumCV = result.byAccount.reduce((s, a) => s + a.currentValue, 0);
    const sumInv = result.byAccount.reduce((s, a) => s + a.totalInvested, 0);
    const sumReal = result.byAccount.reduce((s, a) => s + a.realizedGain, 0);
    const sumUnreal = result.byAccount.reduce(
      (s, a) => s + a.unrealizedGain,
      0,
    );
    const sumGL = result.byAccount.reduce((s, a) => s + a.gainLoss, 0);
    expect(sumCV).toBeCloseTo(result.totals.totalPortfolioValue, 2);
    expect(sumInv).toBeCloseTo(result.totals.totalInvested, 2);
    expect(sumReal).toBeCloseTo(result.totals.totalRealizedGain, 2);
    expect(sumUnreal).toBeCloseTo(result.totals.totalUnrealizedGain, 2);
    expect(sumGL).toBeCloseTo(result.totals.totalGainLoss, 2);
  });

  it("surfaces a legacy oversold broker partition through both response levels", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ id: 1, currency: "EUR", current_price: 12 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            investment_id: 1,
            type: "buy",
            amount: 100,
            units: 10,
            currency: "EUR",
            account_id: 10,
          }),
          txnRow({
            id: 2,
            investment_id: 1,
            type: "sell",
            amount: 180,
            units: 15,
            currency: "EUR",
            account_id: 10,
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");

    expect(result.summaries[0]).toMatchObject({
      fullyAssigned: true,
      oversold: true,
    });
    expect(result.byAccount[0]).toMatchObject({
      account_id: 10,
      assignment: "account",
      oversold: true,
    });
  });
});

describe("separate imported broker account fees", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  function withFees(
    fees: Record<string, unknown>[],
    rates: Record<string, unknown>[] = [],
  ) {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "EUR", current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ currency: "EUR", amount: 100, account_id: 7 })],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: fees });
    if (rates.length) query.mockResolvedValueOnce({ rows: rates });
  }

  it("subtracts dated cash fees once without altering investment gains or account partitions", async () => {
    withFees(
      [
        {
          id: 10,
          account_id: 7,
          date: "2026-01-01",
          currency: "USD",
          amount: "10.0000",
        },
        {
          id: 11,
          account_id: 8,
          date: "2026-01-02",
          currency: "EUR",
          amount: "2.0000",
        },
      ],
      [{ currency_code: "USD", rate_date: "2025-12-31", rate_to_eur: "0.8" }],
    );
    const result = await getPortfolioSummary("EUR", {
      throughDate: "2026-01-02",
    });
    expect(result.totals.totalGainLoss).toBe(50);
    expect(result.totals.totalFees).toBe(0);
    expect(result.summaries[0]!.gainLoss).toBe(50);
    expect(result.byAccount[0]!.gainLoss).toBe(50);
    expect(result.brokerageCashFees).toEqual({
      total: 10,
      gainAfterFees: 40,
      usedFallbackRate: false,
      byAccount: [
        { account_id: 7, total: 8 },
        { account_id: 8, total: 2 },
      ],
    });
    expect(
      query.mock.calls.find(([sql]) => sql.includes("WITH owned_fee_ids"))![1],
    ).toEqual(["2026-01-02"]);
  });

  it("discloses current-rate fallback for missing historical account fee rates", async () => {
    withFees([
      {
        id: 10,
        account_id: 7,
        date: "2026-01-01",
        currency: "USD",
        amount: "10.0000",
      },
    ]);
    const result = await getPortfolioSummary("EUR");
    expect(result.brokerageCashFees).toMatchObject({
      total: 9,
      gainAfterFees: 41,
      usedFallbackRate: true,
    });
    expect(result.totals.usedFallbackRate).toBe(false);
  });

  it("reports zero costs and unchanged gain when no cash fee is proved", async () => {
    withFees([]);
    const result = await getPortfolioSummary("EUR");
    expect(result.brokerageCashFees).toEqual({
      total: 0,
      gainAfterFees: 50,
      usedFallbackRate: false,
      byAccount: [],
    });
  });
});

describe("getBreakdownSummary (legacy compat)", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it("returns a narrow shape sourced from getPortfolioSummary", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "EUR", current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: "buy", amount: 100, units: 1, currency: "EUR" })],
      });

    const breakdown = await getBreakdownSummary("EUR");

    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]).toMatchObject({
      id: 1,
      name: "Apple Inc",
      symbol: "AAPL",
      assetClass: "stock",
      currency: "EUR", // originalCurrency from the test investment
      currentValue: 150,
      totalInvested: 100,
    });
  });

  it("breakdown values match getPortfolioSummary summaries (parity)", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "USD", current_price: 200 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: "buy", amount: 100, units: 1, currency: "USD" })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const summary = await getPortfolioSummary("EUR");

    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "USD", current_price: 200 })],
      })
      .mockResolvedValueOnce({
        rows: [txnRow({ type: "buy", amount: 100, units: 1, currency: "USD" })],
      })
      .mockResolvedValueOnce({ rows: [] });
    const breakdown = await getBreakdownSummary("EUR");

    expect(breakdown[0]!.currentValue).toBe(summary.summaries[0]!.currentValue);
    expect(breakdown[0]!.totalInvested).toBe(
      summary.summaries[0]!.totalInvested,
    );
    expect(breakdown[0]!.gainLoss).toBe(summary.summaries[0]!.gainLoss);
    expect(breakdown[0]!.assetGain).toBe(summary.summaries[0]!.assetGain);
    expect(breakdown[0]!.fxGain).toBe(summary.summaries[0]!.fxGain);
  });
});

describe("asset-class formula coverage", () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue({ rows: [] });
  });

  it("savings account computes accrued + projected interest", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({
            asset_class: "savings",
            interest_rate: 5,
            current_price: 0,
            currency: "EUR",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            type: "buy",
            amount: 1000,
            units: 0,
            currency: "EUR",
            date: "2025-01-01",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    const s = result.summaries[0]!;

    expect(s.totalInvested).toBe(1000);
    expect(s.projectedAnnualInterest).toBe(50); // 1000 * 5%
    expect(s.accruedInterest).toBeGreaterThan(0);
    expect(s.currentValue).toBeCloseTo(1000 + s.accruedInterest, 2);
  });

  it("does not double-count interest in fixed-income gainLoss", async () => {
    // €10 000 deposit, one €400 interest payment, negligible accrual → economic
    // gain 400. Old code added interest via realizedGain AND totalIncome → 800.
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({
            asset_class: "savings",
            interest_rate: 0,
            current_price: 0,
            currency: "EUR",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            type: "buy",
            amount: 10000,
            units: 0,
            currency: "EUR",
            date: "2025-01-01",
          }),
          txnRow({
            id: 2,
            type: "interest",
            amount: 400,
            units: 0,
            currency: "EUR",
            date: "2026-01-01",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    expect(result.summaries[0]!.gainLoss).toBe(400);
  });

  it("clamps negative net-invested to 0 instead of flipping it positive (abs)", async () => {
    // Fixed-income sold above contributions → buys−sells negative. abs() used to
    // report +500 "invested"; clamp reports 0.
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({
            asset_class: "savings",
            interest_rate: 0,
            current_price: 0,
            currency: "EUR",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            type: "buy",
            amount: 1000,
            units: 0,
            currency: "EUR",
            date: "2025-01-01",
          }),
          txnRow({
            id: 2,
            type: "sell",
            amount: 1500,
            units: 0,
            currency: "EUR",
            date: "2026-01-01",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    expect(result.summaries[0]!.totalInvested).toBe(0);
  });

  it("reduces non-unit invested and value on return_of_capital", async () => {
    // Bond: buy €10 000, return €2 000 of capital. Invested and (no-interest)
    // value must both drop to 8 000 — pre-fix return_of_capital was ignored for
    // non-unit classes so both stayed at 10 000 forever.
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({
            asset_class: "bond",
            interest_rate: 0,
            current_price: 0,
            currency: "EUR",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            type: "buy",
            amount: 10000,
            units: 0,
            currency: "EUR",
            date: "2025-01-01",
          }),
          txnRow({
            id: 2,
            type: "return_of_capital",
            amount: 2000,
            units: 0,
            currency: "EUR",
            date: "2026-01-01",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    const s = result.summaries[0]!;

    expect(s.totalInvested).toBe(8000);
    expect(s.currentValue).toBeCloseTo(8000, 2);
  });

  it("real estate adds appreciation to current value", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({
            asset_class: "real_estate",
            current_price: 0,
            currency: "EUR",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            type: "buy",
            amount: 250000,
            units: 0,
            currency: "EUR",
          }),
          txnRow({
            id: 2,
            type: "appreciation",
            amount: 25000,
            units: 0,
            currency: "EUR",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    const s = result.summaries[0]!;

    expect(s.totalInvested).toBe(250000);
    expect(s.totalAppreciation).toBe(25000);
    expect(s.currentValue).toBe(275000);
    expect(s.unrealizedGain).toBe(25000);
  });

  it("does not double-count buy fees in gainLoss for unit-based assets", async () => {
    // Buy 1 unit for 100 with a 10 fee → cost basis 110; current price 150.
    // Economic gain is 40 (paid 110, worth 150). calculateCostBasis already
    // folds the fee into cost, so the old code's extra −fee gave 30.
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "EUR", current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            type: "buy",
            amount: 100,
            units: 1,
            fees: 10,
            currency: "EUR",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    expect(result.summaries[0]!.gainLoss).toBe(40);
  });

  it("does not double-count rent/fees/taxes in real-estate gainLoss", async () => {
    // appreciation 10000 + rent 12000 − fees 2000 − taxes 1000 = 19000.
    // Old code computed appreciation + 2·rent − 2·fees − 2·taxes = 28000.
    query
      .mockResolvedValueOnce({
        rows: [
          investmentRow({
            asset_class: "real_estate",
            current_price: 0,
            currency: "EUR",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            type: "buy",
            amount: 250000,
            units: 0,
            currency: "EUR",
          }),
          txnRow({
            id: 2,
            type: "appreciation",
            amount: 10000,
            units: 0,
            currency: "EUR",
          }),
          txnRow({
            id: 3,
            type: "rent_income",
            amount: 12000,
            units: 0,
            currency: "EUR",
          }),
          txnRow({
            id: 4,
            type: "fee",
            amount: 2000,
            units: 0,
            currency: "EUR",
          }),
          txnRow({
            id: 5,
            type: "tax",
            amount: 1000,
            units: 0,
            currency: "EUR",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    expect(result.summaries[0]!.gainLoss).toBe(19000);
  });

  it("sells reduce units and trigger realized gain on a unit-based holding", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "EUR", current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            type: "buy",
            amount: 100,
            units: 1,
            currency: "EUR",
            date: "2025-01-01",
          }),
          txnRow({
            id: 2,
            type: "buy",
            amount: 120,
            units: 1,
            currency: "EUR",
            date: "2025-06-01",
          }),
          txnRow({
            id: 3,
            type: "sell",
            amount: 200,
            units: 1,
            currency: "EUR",
            date: "2026-01-01",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    const s = result.summaries[0]!;

    expect(s.totalUnits).toBe(1);
    expect(s.realizedGain).toBeGreaterThan(0); // sold above avg cost basis
    expect(s.currentValue).toBe(150); // 1 unit * 150
  });

  it("replays full history only through the requested date boundary", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "EUR", current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            type: "buy",
            amount: 100,
            units: 1,
            currency: "EUR",
            date: "2024-01-01",
          }),
          txnRow({
            id: 2,
            type: "buy",
            amount: 120,
            units: 1,
            currency: "EUR",
            date: "2025-01-01",
          }),
          txnRow({
            id: 3,
            type: "sell",
            amount: 200,
            units: 1,
            currency: "EUR",
            date: "2026-01-01",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR", {
      throughDate: "2025-12-31",
    });

    expect(result.summaries[0]).toMatchObject({
      totalUnits: 2,
      totalSellProceeds: 0,
      realizedGain: 0,
      totalInvested: 220,
    });
  });

  it("can include inactive investments for historical reporting", async () => {
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ is_active: false, currency: "EUR" })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const result = await getPortfolioSummary("EUR", {
      throughDate: "2025-12-31",
      activeInvestmentsOnly: false,
    });

    expect(result.summaries).toHaveLength(1);
    expect(query.mock.calls[0]![0]).not.toContain("WHERE i.is_active = true");
    expect(query.mock.calls[1]![0]).not.toContain("i.is_active = true");
  });

  it("honors the cost_basis_method setting (fifo vs weighted_avg realized gain)", async () => {
    // Two lots at different prices, then sell one unit at 200:
    //   weighted_avg: cost of sold unit = (100+120)/2 = 110 → gain 90
    //   fifo:         cost of sold unit = first lot 100    → gain 100
    const seedQueries = () =>
      query
        .mockResolvedValueOnce({
          rows: [investmentRow({ currency: "EUR", current_price: 150 })],
        })
        .mockResolvedValueOnce({
          rows: [
            txnRow({
              id: 1,
              type: "buy",
              amount: 100,
              units: 1,
              currency: "EUR",
              date: "2025-01-01",
            }),
            txnRow({
              id: 2,
              type: "buy",
              amount: 120,
              units: 1,
              currency: "EUR",
              date: "2025-06-01",
            }),
            txnRow({
              id: 3,
              type: "sell",
              amount: 200,
              units: 1,
              currency: "EUR",
              date: "2026-01-01",
            }),
          ],
        });

    settingsRepository.get.mockResolvedValueOnce("weighted_avg");
    seedQueries();
    const weighted = await getPortfolioSummary("EUR");
    expect(weighted.summaries[0]!.realizedGain).toBe(90);

    settingsRepository.get.mockResolvedValueOnce("fifo");
    seedQueries();
    const fifo = await getPortfolioSummary("EUR");
    expect(fifo.summaries[0]!.realizedGain).toBe(100);
    expect(fifo.summaries[0]!.totalInvested).toBe(120); // remaining lot at 120
  });

  it("falls back to weighted_avg on an invalid stored method", async () => {
    settingsRepository.get.mockResolvedValueOnce("not-a-method");
    query
      .mockResolvedValueOnce({
        rows: [investmentRow({ currency: "EUR", current_price: 150 })],
      })
      .mockResolvedValueOnce({
        rows: [
          txnRow({
            id: 1,
            type: "buy",
            amount: 100,
            units: 1,
            currency: "EUR",
            date: "2025-01-01",
          }),
          txnRow({
            id: 2,
            type: "buy",
            amount: 120,
            units: 1,
            currency: "EUR",
            date: "2025-06-01",
          }),
          txnRow({
            id: 3,
            type: "sell",
            amount: 200,
            units: 1,
            currency: "EUR",
            date: "2026-01-01",
          }),
        ],
      });

    const result = await getPortfolioSummary("EUR");
    expect(result.summaries[0]!.realizedGain).toBe(90); // weighted_avg
  });
});

it("canonical summary exposes dated descriptive income without raising ordinary income or gains", async () => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  query
    .mockResolvedValueOnce({
      rows: [investmentRow({ id: 1, currency: "USD", current_price: 200 })],
    })
    .mockResolvedValueOnce({
      rows: [
        txnRow({
          investment_id: 1,
          type: "gift",
          units: 2,
          amount: 0,
          account_id: 7,
        }),
        txnRow({
          investment_id: 1,
          type: "dividend",
          units: 0,
          amount: 20,
          account_id: 7,
          income_recognition_role: "included_in_units",
        }),
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        { currency_code: "USD", rate_date: "2026-01-01", rate_to_eur: "0.8" },
      ],
    });
  const result = await getPortfolioSummary("EUR");
  expect(result.summaries[0]).toMatchObject({
    totalIncome: 0,
    totalDividends: 0,
    totalInKindIncome: 16,
    gainLoss: 360,
  });
  expect(result.totals).toMatchObject({
    totalIncome: 0,
    totalInKindIncome: 16,
    totalGainLoss: 360,
  });
});

it("converts archived included income at its own dated currency without changing active totals", async () => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  query
    .mockResolvedValueOnce({
      rows: [investmentRow({ id: 1, currency: "EUR" })],
    })
    .mockResolvedValueOnce({
      rows: [
        txnRow({ investment_id: 1, currency: "EUR", type: "gift", amount: 0 }),
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        {
          investment_id: 7,
          amount: "20",
          currency: "USD",
          date: "2021-02-05",
          fx_rate_to_eur: null,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        { currency_code: "USD", rate_date: "2021-02-05", rate_to_eur: "0.8" },
      ],
    });
  const result = await getPortfolioSummary("EUR");
  expect(result.archivedInKindIncome).toEqual([
    { id: 7, totalInKindIncome: 16 },
  ]);
  expect(result.totals.totalIncome).toBe(0);
  expect(result.totals.totalInKindIncome).toBe(0);
  expect(result.summaries.map((row) => row.id)).toEqual([1]);
  expect(
    query.mock.calls.find(([sql]) => sql.includes("i.is_active = false"))![0],
  ).toContain("income_recognition_role = 'included_in_units'");
});
