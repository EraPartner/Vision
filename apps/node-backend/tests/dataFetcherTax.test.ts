import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import { partial } from "./helpers/partial.ts";

vi.mock("../src/database/connection.ts", () => mockConnection());

// Keep convertWithRates real (pure math); only stub the DB-backed current-rate loader.
vi.mock(
  "../src/services/currency/currencyConversionService.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/services/currency/currencyConversionService.ts")
      >();
    return { ...actual, loadCurrentRates: vi.fn() };
  },
);

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import {
  loadCurrentRates as rawLoadCurrentRates,
  __clearHistoricalIndexCache as clearHistoricalIndexCache,
} from "../src/services/currency/currencyConversionService.ts";
import { fetchTaxData } from "../src/services/reports/dataFetcherTax.ts";
import { RowContractError } from "../src/database/rowContracts.ts";

const query = vi.mocked(rawQuery);
const loadCurrentRates = vi.mocked(rawLoadCurrentRates);

// pg returns the COALESCEd NUMERIC money columns as strings, so cases may pass
// numbers for readability and the builder stringifies them.
const dividendRow = (over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: 1,
    investment_id: 10,
    investment_name: "Acme",
    symbol: "ACME",
    asset_class: "stock",
    type: "dividend",
    dividend_amount_convention: "net",
    income_recognition_role: "standard",
    amount: 1000,
    taxes: 150,
    fees: 0,
    currency: "USD",
    rate_date: "2024-03-15",
    year: 2024,
    month: 3,
    ...over,
  };
  return {
    ...row,
    amount: String(row.amount),
    taxes: String(row.taxes),
    fees: String(row.fees),
  };
};

describe("fetchTaxData — Belgian tax FX uses transaction-date rates (ADR-085)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The historical-rate index is cached at process level; clear it so each case
    // builds from its own mocked exchange_rates rows.
    clearHistoricalIndexCache();
    // Today's USD rate is deliberately different from the historical one so the test
    // can tell which rate was applied.
    loadCurrentRates.mockResolvedValue({ EUR: 1, USD: 0.8 });
  });

  it("converts a foreign-currency dividend at the rate on the transaction date, not today", async () => {
    query
      .mockResolvedValueOnce(partial<PgQueryResult>({ rows: [dividendRow()] }))
      .mockResolvedValueOnce(
        partial<PgQueryResult>({
          rows: [
            {
              currency_code: "USD",
              rate_date: "2024-03-15",
              rate_to_eur: "0.9",
            },
          ],
        }),
      );

    const data = await fetchTaxData("EUR", { kind: "year", year: 2024 }, {});

    // 1000 USD * 0.90 (15 Mar 2024) = 900 EUR, NOT 1000 * 0.80 (today) = 800 EUR.
    expect(data.dividendsReceived).toBeCloseTo(900, 6);
    // 150 USD withholding * 0.90 = 135 EUR.
    expect(data.dividendWHTTotal).toBeCloseTo(135, 6);
  });

  it("uses the rate on-or-before the date when no exact-day rate exists (weekend convention)", async () => {
    query
      .mockResolvedValueOnce(
        partial<PgQueryResult>({
          rows: [dividendRow({ rate_date: "2024-03-16" })],
        }),
      ) // a Saturday
      .mockResolvedValueOnce(
        partial<PgQueryResult>({
          rows: [
            {
              currency_code: "USD",
              rate_date: "2024-03-15",
              rate_to_eur: "0.9",
            },
          ],
        }),
      );

    const data = await fetchTaxData("EUR", { kind: "year", year: 2024 }, {});

    // Saturday transaction falls back to Friday's stored rate (0.90), not today's.
    expect(data.dividendsReceived).toBeCloseTo(900, 6);
  });

  it("falls back to the current rate when no historical rate exists on/before the date", async () => {
    query
      .mockResolvedValueOnce(
        partial<PgQueryResult>({ rows: [dividendRow({ taxes: 0 })] }),
      )
      .mockResolvedValueOnce(partial<PgQueryResult>({ rows: [] })); // nothing stored

    const data = await fetchTaxData("EUR", { kind: "year", year: 2024 }, {});

    // No historical rate → current rate 0.80 → 1000 * 0.80 = 800 EUR.
    expect(data.dividendsReceived).toBeCloseTo(800, 6);
  });

  it("leaves EUR rows untouched and skips the FX lookup entirely", async () => {
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({
        rows: [dividendRow({ currency: "EUR", amount: 500, taxes: 30 })],
      }),
    );

    const data = await fetchTaxData("EUR", { kind: "year", year: 2024 }, {});

    expect(data.dividendsReceived).toBeCloseTo(500, 6);
    expect(data.dividendWHTTotal).toBeCloseTo(30, 6);
    // Only the transactions query runs — no exchange_rates query for an all-EUR set.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("accumulates decimal tax-report money without binary float drift", async () => {
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({
        rows: [
          dividendRow({
            id: 11,
            amount: "0.1",
            taxes: "0.1",
            fees: "0.1",
            currency: "EUR",
          }),
          dividendRow({
            id: 12,
            amount: "0.2",
            taxes: "0.2",
            fees: "0.2",
            currency: "EUR",
          }),
        ],
      }),
    );

    const data = await fetchTaxData("EUR", { kind: "year", year: 2024 }, {});

    expect(data.dividendsReceived).toBe(0.3);
    expect(data.dividendWHTTotal).toBe(0.3);
    expect(data.feesTotal).toBe(0.3);
    expect(data.byMonth[0]).toMatchObject({ wht: 0.3, fees: 0.3 });
    expect(data.byAssetClass[0]).toMatchObject({ taxes: 0.3, fees: 0.3 });
    expect(data.byInvestment[0]).toMatchObject({
      wht: 0.3,
      fees: 0.3,
      total: 0.6,
    });
  });

  it("computes gross and net dividend totals from each row's explicit convention", async () => {
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({
        rows: [
          dividendRow({
            id: 21,
            amount: 100,
            taxes: 30,
            currency: "EUR",
            dividend_amount_convention: "gross",
          }),
          dividendRow({
            id: 22,
            amount: 70,
            taxes: 30,
            currency: "EUR",
            dividend_amount_convention: "net",
          }),
        ],
      }),
    );

    const data = await fetchTaxData("EUR", { kind: "year", year: 2024 }, {});

    expect(data.dividendsReceived).toBe(170);
    expect(data.grossDividendBase).toBe(200);
    expect(data.netDividendResult).toBe(140);
    expect(data.unknownDividendConventionCount).toBe(0);
  });

  it("marks convention-dependent dividend totals incomplete when any row is unknown", async () => {
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({
        rows: [
          dividendRow({
            currency: "EUR",
            dividend_amount_convention: "unknown",
          }),
        ],
      }),
    );

    const data = await fetchTaxData("EUR", { kind: "year", year: 2024 }, {});

    expect(data.dividendsReceived).toBe(1000);
    expect(data.dividendWHTTotal).toBe(150);
    expect(data.grossDividendBase).toBeNull();
    expect(data.netDividendResult).toBeNull();
    expect(data.unknownDividendConventionCount).toBe(1);
  });

  it("flags currencies summed 1:1 when no rate (historical or current) is available", async () => {
    // KRW has neither a stored historical rate nor a current rate.
    query
      .mockResolvedValueOnce(
        partial<PgQueryResult>({
          rows: [dividendRow({ currency: "KRW", amount: 1000, taxes: 0 })],
        }),
      )
      .mockResolvedValueOnce(partial<PgQueryResult>({ rows: [] })); // no historical rate stored for KRW

    const data = await fetchTaxData("EUR", { kind: "year", year: 2024 }, {});

    // Summed at an unconverted 1:1 rate (1000 KRW → 1000), and surfaced so the
    // report can annotate it as approximate (ADR-085) instead of silently lying.
    expect(data.dividendsReceived).toBeCloseTo(1000, 6);
    expect(data.unconvertedCurrencies).toEqual(["KRW"]);
  });

  it('buckets sell-leg taxes into TOB, not "Capital Gains / Sell Tax" (TOB hits both legs)', async () => {
    // Belgian TOB is levied on transfer AND acquisition — a sell's pt.taxes is
    // TOB like a buy's. It used to land in sellTaxTotal, rendered under a
    // "Capital Gains / Sell Tax" label (materially misleading with CGT at 0%
    // through 2025) while the TOB line under-reported the whole sell side.
    query.mockResolvedValueOnce(
      partial<PgQueryResult>({
        rows: [
          dividendRow({
            id: 2,
            type: "buy",
            amount: 1000,
            taxes: 3.5,
            currency: "EUR",
          }),
          dividendRow({
            id: 3,
            type: "sell",
            amount: 1200,
            taxes: 4.2,
            currency: "EUR",
          }),
        ],
      }),
    );

    const data = await fetchTaxData("EUR", { kind: "year", year: 2024 }, {});

    expect(data.tobTotal).toBeCloseTo(7.7, 6); // buy 3.5 + sell 4.2
    expect(data.sellTaxTotal).toBe(0);
  });
});

it("keeps paired in-kind source amount and costs separate from ordinary dividend and withholding totals", async () => {
  vi.clearAllMocks();
  clearHistoricalIndexCache();
  query.mockResolvedValueOnce(
    partial<PgQueryResult>({
      rows: [
        dividendRow({
          currency: "EUR",
          amount: 40,
          taxes: 2,
          fees: 1,
          income_recognition_role: "included_in_units",
        }),
        dividendRow({ currency: "EUR", amount: 10, taxes: 3 }),
      ],
    }),
  );
  const data = await fetchTaxData("EUR", { kind: "year", year: 2024 }, {});
  expect(data).toMatchObject({
    totalInKindIncome: 40,
    inKindIncomeCount: 1,
    dividendsReceived: 10,
    dividendWHTTotal: 3,
    otherTaxTotal: 2,
    feesTotal: 1,
    unknownDividendConventionCount: 0,
  });
});

it("surfaces a row contract mismatch instead of skipping the tax sections", async () => {
  vi.clearAllMocks();
  clearHistoricalIndexCache();
  query.mockResolvedValueOnce(
    partial<PgQueryResult>({
      rows: [{ ...dividendRow({ currency: "EUR" }), amount: 10 }],
    }),
  );
  await expect(
    fetchTaxData("EUR", { kind: "year", year: 2024 }, {}),
  ).rejects.toBeInstanceOf(RowContractError);
});
