import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";
import { mockCurrencyConversion } from "./helpers/mockCurrencyConversion.js";

import { mockLogger } from "./helpers/mockLogger.js";
vi.mock("../src/database/connection.js", () => mockConnection());

vi.mock("../src/services/currency/currencyConversionService.js", () =>
  mockCurrencyConversion(),
);

vi.mock("../src/config/logger.js", () => ({
  logger: mockLogger(),
}));

vi.mock("../src/repositories/infoRepositoryHelpers.js", async () => {
  const actual = await vi.importActual(
    "../src/repositories/infoRepositoryHelpers.js",
  );
  return {
    ...actual,
    mvAvailable: vi.fn(),
    getIncludeTransfers: vi.fn().mockResolvedValue(false),
    clearMvCache: actual.clearMvCache,
  };
});

import { query } from "../src/database/connection.js";
import { convertRowsToEur } from "../src/services/currency/currencyConversionService.js";
import { mvAvailable } from "../src/repositories/infoRepositoryHelpers.js";
import { getMonthlyFinancialSummary } from "../src/repositories/infoRepositoryMonthly.js";
import { todayAppDateString } from "../src/lib/timezone.js";

beforeEach(() => vi.clearAllMocks());

describe("getMonthlyFinancialSummary — materialized-view fast path", () => {
  it("uses mv_monthly_summary when no exclusions and not allTime", async () => {
    // Pin the clock so the zero-filled 6-month window is deterministic
    // (2024-11 … 2025-04). The MV returns only the populated month (2025-04).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-04-15T12:00:00Z"));
    try {
      mvAvailable.mockResolvedValueOnce(true);

      query
        // Currency-homogeneity probe: no rows in a non-target currency.
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              month_start: new Date("2025-04-01T00:00:00Z"),
              month: 4,
              year: 2025,
              currency: "EUR",
              transaction_count: "10",
              total_income: "1000",
              total_spending: "-400",
              net_amount: "600",
            },
          ],
        });

      convertRowsToEur.mockResolvedValueOnce([
        {
          _key: "2025-04",
          _type: "income",
          _row: {
            month: 4,
            year: 2025,
            month_start: new Date("2025-04-01T00:00:00Z"),
            transaction_count: "10",
          },
          amount_eur: 1000,
        },
        {
          _key: "2025-04",
          _type: "spending",
          _row: {
            month: 4,
            year: 2025,
            month_start: new Date("2025-04-01T00:00:00Z"),
            transaction_count: "10",
          },
          amount_eur: -400,
        },
      ]);

      const r = await getMonthlyFinancialSummary([], "EUR", [], false);

      expect(query.mock.calls[0][0]).toContain("UPPER(currency)"); // homogeneity probe
      expect(query.mock.calls[1][0]).toContain("FROM mv_monthly_summary"); // MV aggregation
      expect(query.mock.calls[1][0]).toContain("GROUP BY month_start");
      // Zero-filled to the full 6-month window (matches the live path).
      expect(r.months).toHaveLength(6);
      const april = r.months.find((m) => m.year === 2025 && m.month === 4);
      expect(april).toMatchObject({
        total_income: 1000,
        total_spending: -400,
        net_amount: 600,
        transaction_count: 10, // halved (income+spending counted once each)
      });
      // A month with no MV data is present and zeroed.
      const march = r.months.find((m) => m.year === 2025 && m.month === 3);
      expect(march).toMatchObject({
        total_income: 0,
        total_spending: 0,
        transaction_count: 0,
      });
      expect(r.summary).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds ONE app-date anchor for both the SQL window and the zero-fill across a month rollover", async () => {
    // 22:30 UTC on Mar 31 is already 00:30 Apr 1 in APP_TIMEZONE (Europe/
    // Brussels) — the exact window where the DB session's CURRENT_DATE still
    // says March. Pre-fix the MV filter selected Oct…Mar while the zero-fill
    // keyed Nov…Apr, a 7-month union; post-fix both derive from the single
    // bound '2025-04-01'.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-31T22:30:00Z"));
    try {
      mvAvailable.mockResolvedValueOnce(true);
      query
        .mockResolvedValueOnce({ rows: [] }) // homogeneity probe
        .mockResolvedValueOnce({ rows: [] }); // MV aggregation — empty corpus
      convertRowsToEur.mockResolvedValueOnce([]);

      const r = await getMonthlyFinancialSummary([], "EUR", [], false);

      const [sql, params] = query.mock.calls[1];
      expect(sql).not.toContain("CURRENT_DATE");
      expect(params).toEqual(["2025-04-01"]);
      expect(
        r.months.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`),
      ).toEqual([
        "2024-11",
        "2024-12",
        "2025-01",
        "2025-02",
        "2025-03",
        "2025-04",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls through to live query when mv unavailable", async () => {
    mvAvailable.mockResolvedValueOnce(false);
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([], "EUR", [], false);

    expect(query.mock.calls[0][0]).toContain("generate_series");
    expect(query.mock.calls[0][0]).toContain("filtered_transactions");
  });

  it("falls through to the live path when the MV holds a non-target currency", async () => {
    // Month-start-rate conversion of mixed-currency MV rows is inexact; the live
    // per-(date,currency) path must handle it instead.
    mvAvailable.mockResolvedValueOnce(true);
    query
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] }) // homogeneity probe finds a non-EUR row
      .mockResolvedValueOnce({ rows: [] }); // live query
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([], "EUR", [], false);

    expect(query.mock.calls[0][0]).toContain("UPPER(currency)"); // probe ran
    expect(query.mock.calls[1][0]).toContain("generate_series"); // live path, not MV
    expect(query.mock.calls[1][0]).toContain("filtered_transactions");
  });

  it("always uses live query when category exclusions present", async () => {
    mvAvailable.mockResolvedValue(true); // would skip mv-path for excluded ids
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([5, 7], "EUR", [], false);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("NOT IN ($1, $2)");
    // The app-date window anchor rides after the exclusion params (ADR-009).
    expect(params).toEqual([5, 7, todayAppDateString()]);
  });

  it("always uses live query when recipient exclusions present", async () => {
    mvAvailable.mockResolvedValue(true);
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([], "EUR", [3, 4], false);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([3, 4, todayAppDateString()]);
  });

  it("combines category and recipient exclusions with sequential param numbering", async () => {
    mvAvailable.mockResolvedValue(true);
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([1], "EUR", [99], false);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/category.*\$1/);
    // Alias-aware recipient exclusion (canonical), not bare t.recipient_id.
    expect(sql).toContain(
      "COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN ($2)",
    );
    expect(params).toEqual([1, 99, todayAppDateString()]);
  });

  // Was: the malformed lists below were asserted to bind as [99, 5, …] — every
  // bad element dropped, the summary quietly computed over a different set of
  // transactions than the caller asked to exclude. Rejecting surfaces it.
  // 2147483647 was in the dropped set only because of the old exclusive
  // `< MAX_INT4` bound; it is a legal int4 id and is kept now.
  it("rejects malformed exclusion lists instead of dropping the bad ids", async () => {
    mvAvailable.mockResolvedValue(true);

    await expect(
      getMonthlyFinancialSummary(
        [0, -1, 1.5, "evil", 2147483647, 99],
        "EUR",
        [null, undefined, 5],
        false,
      ),
    ).rejects.toThrow(/excludedCategoryIds contains invalid value/);

    expect(query).not.toHaveBeenCalled();
  });

  it("binds an exclusion id at the int4 ceiling instead of dropping it", async () => {
    mvAvailable.mockResolvedValue(true);
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([2147483647, 99], "EUR", [5], false);

    const [, params] = query.mock.calls[0];
    expect(params).toEqual([2147483647, 99, 5, todayAppDateString()]);
  });

  it("uses earliest-transaction date when allTime=true", async () => {
    mvAvailable.mockResolvedValue(false);
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([], "EUR", [], true);

    const [sql] = query.mock.calls[0];
    expect(sql).toContain("SELECT MIN(date_trunc");
  });

  it("buckets per-(date,currency) grouped aggregates into income vs spending", async () => {
    mvAvailable.mockResolvedValueOnce(false);

    // Live path now returns SQL aggregates grouped by (date, currency): income
    // and spending are pre-summed per day. Empty months arrive with date null.
    query.mockResolvedValueOnce({
      rows: [
        {
          month: 4,
          year: 2025,
          period_start: "2025-04-01",
          period_end: "2025-04-30",
          date: "2025-04-05",
          currency: "EUR",
          cnt: "1",
          income_amount: "500",
          spending_amount: "0",
        },
        {
          month: 4,
          year: 2025,
          period_start: "2025-04-01",
          period_end: "2025-04-30",
          date: "2025-04-10",
          currency: "EUR",
          cnt: "2",
          income_amount: "0",
          spending_amount: "-150",
        },
        {
          month: 5,
          year: 2025,
          period_start: "2025-05-01",
          period_end: "2025-05-31",
          date: null,
          currency: null,
          cnt: null,
          income_amount: null,
          spending_amount: null,
        },
      ],
    });

    // Two conversion calls: income aggregates, then spending aggregates.
    convertRowsToEur
      .mockResolvedValueOnce([{ amount_eur: 500 }, { amount_eur: 0 }])
      .mockResolvedValueOnce([{ amount_eur: 0 }, { amount_eur: -150 }]);

    const r = await getMonthlyFinancialSummary([], "EUR", [], false);
    expect(convertRowsToEur).toHaveBeenCalledTimes(2);
    const apr = r.months.find((m) => m.month === 4);
    expect(apr).toMatchObject({
      total_income: 500,
      total_spending: -150,
      net_amount: 350,
      transaction_count: 3, // 1 + 2
    });
    const may = r.months.find((m) => m.month === 5);
    expect(may).toMatchObject({
      total_income: 0,
      total_spending: 0,
      net_amount: 0,
      transaction_count: 0,
    });
  });
});
