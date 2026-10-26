/**
 * Currency Conversion Service tests.
 * Mirrors: apps/backend/tests/test_currency_conversion_service.py
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import { mockLogger } from "./helpers/mockLogger.ts";

// Mock database
vi.mock("../src/database/connection.ts", () => mockConnection());

vi.mock("../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

import {
  clearMemoryCache,
  convertRowsToEur,
  convertToCurrency,
  warmCache,
  loadCurrentRates,
  backfillPortfolioHistoricalRates,
  __clearHistoricalIndexCache as clearHistoricalIndexCache,
  getHistoricalRateIndex,
} from "../src/services/currency/currencyConversionService.ts";
import {
  query as rawQuery,
  withTransaction as rawWithTransaction,
} from "../src/database/connection.ts";
import type {
  PgPoolClient,
  PgQueryResult,
} from "../src/database/connection.ts";
import { logger } from "../src/config/logger.ts";
import { partial } from "./helpers/partial.ts";
import { pgLocalDate } from "./helpers/portfolioPgRows.ts";
import { RowContractError } from "../src/database/rowContracts.ts";
import { must } from "./helpers/must.ts";

import { mockOf } from "./helpers/mockOf.ts";
// The cases prime `query` with bare `{ rows }` results and never read
// `rowCount`, so the mock is typed with a partial result.
const query = vi.mocked(rawQuery) as unknown as Mock<
  (sql: string, params?: readonly unknown[]) => Promise<Partial<PgQueryResult>>
>;
const withTransaction = vi.mocked(rawWithTransaction);

type QueryResultFixture = Partial<PgQueryResult>;
type QueryHandler =
  | QueryResultFixture
  | ((params: readonly unknown[], sql: string) => QueryResultFixture);

const originalFetch = global.fetch;

/**
 * SQL text lower-cased with identifier quotes removed, so the routing below
 * matches hand-written and query-builder statements alike.
 */
const sqlText = (sql: unknown) => String(sql).toLowerCase().replace(/"/g, "");

describe("Currency Conversion Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryCache();
    // Mock DB to return no cached rates so we hit fallback
    query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
      return;
    }
    delete (global as { fetch?: typeof fetch }).fetch;
  });

  // ── EUR identity ──────────────────────────────────────────
  it("should return same amount for EUR to EUR", async () => {
    const result = await convertToCurrency(100.0, "EUR", "EUR");
    expect(result).toBe(100.0);
  });

  it("should return same amount for null currency", async () => {
    const result = await convertToCurrency(100.0, null, "EUR");
    expect(result).toBe(100.0);
  });

  it("should return same amount for undefined currency", async () => {
    const result = await convertToCurrency(100.0, undefined, "EUR");
    expect(result).toBe(100.0);
  });

  // ── Zero / edge amounts ───────────────────────────────────
  it("should return 0 for zero amount", async () => {
    query.mockResolvedValue({
      rows: [{ currency_code: "USD", rate_to_eur: "0.9" }],
    });
    const result = await convertToCurrency(0.0, "USD", "EUR");
    expect(result).toBe(0);
  });

  it("should handle negative amounts (preserve sign)", async () => {
    query.mockResolvedValue({
      rows: [{ currency_code: "USD", rate_to_eur: "0.9" }],
    });
    const result = await convertToCurrency(-100.0, "USD", "EUR");
    expect(result).toBeLessThan(0);
    expect(typeof result).toBe("number");
  });

  // ── No stored rates ──────────────────────────────────────
  it("has no rate for a currency without a stored rate (never a built-in constant)", async () => {
    // DB returns nothing: only the EUR base is known.
    expect(await loadCurrentRates()).toEqual({ EUR: 1 });
    // No rate: undefined, neither a constant nor the amount passed through 1:1.
    expect(await convertToCurrency(109.0, "USD", "EUR")).toBeUndefined();
  });

  it("has no conversion for a currency without a stored rate", async () => {
    const result = await convertToCurrency(100.0, "XYZ", "EUR");
    expect(result).toBeUndefined();
  });

  // ── Case insensitivity ────────────────────────────────────
  it("should handle lowercase currency codes", async () => {
    const result = await convertToCurrency(100.0, "eur", "EUR");
    expect(result).toBe(100.0);
  });

  it("should handle mixed-case currency codes", async () => {
    const result = await convertToCurrency(100.0, "Eur", "EUR");
    expect(result).toBe(100.0);
  });

  // ── Cached DB rates ───────────────────────────────────────
  it("should load rates from database when available", async () => {
    query.mockResolvedValue({
      rows: [
        {
          currency_code: "USD",
          rate_to_eur: "0.917",
          fetched_at: new Date().toISOString(),
        },
        {
          currency_code: "GBP",
          rate_to_eur: "1.16",
          fetched_at: new Date().toISOString(),
        },
      ],
    });

    const result = await convertToCurrency(100.0, "USD", "EUR");
    expect(typeof result).toBe("number");
    // Should use the DB rate (100 * 0.917 ≈ 91.7)
    expect(result).toBeCloseTo(91.7, 0);
  });

  // ── Multiple currencies ───────────────────────────────────
  it("should convert multiple currencies correctly", async () => {
    query.mockResolvedValue({
      rows: [
        { currency_code: "USD", rate_to_eur: "0.92" },
        { currency_code: "GBP", rate_to_eur: "1.17" },
        { currency_code: "JPY", rate_to_eur: "0.0062" },
      ],
    });
    const usd = await convertToCurrency(100.0, "USD", "EUR");
    const gbp = await convertToCurrency(100.0, "GBP", "EUR");
    const jpy = await convertToCurrency(10000.0, "JPY", "EUR");

    expect(typeof usd).toBe("number");
    expect(typeof gbp).toBe("number");
    expect(typeof jpy).toBe("number");
    // GBP should be worth more than USD per unit
    expect(gbp).toBeGreaterThan(must(usd, "usd"));
  });

  // ── convertRowsToEur ─────────────────────────────────────
  it("should convert rows to EUR", async () => {
    const rows = [
      { amount: "100.00", currency: "EUR", date: "2026-01-15" },
      { amount: "-50.00", currency: "EUR", date: "2026-01-16" },
    ];

    const results = await convertRowsToEur(rows);
    expect(results).toHaveLength(2);
    expect(must(results[0], "results[0]").amount_eur).toBe(100.0);
    expect(must(results[1], "results[1]").amount_eur).toBe(-50.0);
  });

  it("should return empty array for empty rows", async () => {
    const results = await convertRowsToEur([]);
    expect(results).toEqual([]);
  });

  it("should return empty array for null rows", async () => {
    const results = await convertRowsToEur(null);
    expect(results).toEqual([]);
  });

  it("should convert rows to a non-EUR target currency", async () => {
    query.mockResolvedValue({
      rows: [
        { currency_code: "USD", rate_to_eur: "0.5" },
        { currency_code: "HUF", rate_to_eur: "0.0025" },
      ],
    });

    const rows = [{ amount: 100, currency: "USD" }];
    const results = await convertRowsToEur(rows, "HUF");
    // USD->EUR: 100 * 0.5 = 50; EUR->HUF divide by 0.0025 => 20000
    expect(must(results[0], "results[0]").amount_eur).toBeCloseTo(20000, 6);
  });

  it("should convert amount between arbitrary currencies", async () => {
    query.mockResolvedValue({
      rows: [
        { currency_code: "USD", rate_to_eur: "0.5" },
        { currency_code: "GBP", rate_to_eur: "1.25" },
      ],
    });

    const result = await convertToCurrency(100, "USD", "GBP");
    // 100 USD -> 50 EUR -> 40 GBP
    expect(result).toBeCloseTo(40, 6);
  });

  it("has no conversion when the target currency has no stored rate", async () => {
    query.mockResolvedValue({
      rows: [{ currency_code: "USD", rate_to_eur: "0.5" }],
    });

    const result = await convertToCurrency(100, "USD", "ZZZ");
    expect(result).toBeUndefined();
  });

  it("leaves a row without a stored source rate unconverted (never 1:1)", async () => {
    const [row] = await convertRowsToEur(
      [{ amount: 50, currency: "XYZ" }],
      "EUR",
    );
    expect(must(row, "row").amount_eur).toBeUndefined();
  });

  it("leaves a row unconverted when the target currency has no stored rate", async () => {
    const [row] = await convertRowsToEur(
      [{ amount: 50, currency: "USD" }],
      "ZZZ",
    );
    expect(must(row, "row").amount_eur).toBeUndefined();
  });

  it("uses an earlier historical rate even when a future rate is closer", async () => {
    query
      // getRates() initial load
      .mockResolvedValueOnce({
        rows: [
          { currency_code: "USD", rate_to_eur: "0.9" },
          { currency_code: "EUR", rate_to_eur: "1.0" },
        ],
      })
      // A closer future quote must never influence historical conversion.
      .mockResolvedValueOnce({
        rows: [
          { currency_code: "USD", rate_date: "2020-01-14", rate_to_eur: "0.8" },
          { currency_code: "USD", rate_date: "2020-01-17", rate_to_eur: "0.7" },
        ],
      });

    const rows = [{ amount: 100, currency: "USD", day: "2020-01-16" }];
    const converted = await convertRowsToEur(rows, "EUR", {
      useHistoricalRatesByDate: true,
      dateField: "day",
    });
    expect(must(converted[0], "converted[0]").amount_eur).toBeCloseTo(80, 6);
  });

  it("prefetches history when the stored currency has only future rates", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ currency_code: "USD", rate_to_eur: "0.9" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { currency_code: "USD", rate_date: "2020-02-01", rate_to_eur: "0.7" },
        ],
      });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve('<Cube time="2020-01-14"><Cube currency="USD" rate="1.25"/></Cube>'),
    });
    const [row] = await convertRowsToEur(
      [{ amount: 100, currency: "USD", day: "2020-01-16" }],
      "EUR",
      { useHistoricalRatesByDate: true },
    );
    expect(must(row, "row").amount_eur).toBeCloseTo(80, 6);
    expect(must(row, "row").used_fallback_rate).toBeUndefined();
    expect(global.fetch).toHaveBeenCalled();
  });

  it("marks a current-rate fallback when all historical quotes are in the future", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ currency_code: "USD", rate_to_eur: "0.9" }],
      })
      .mockResolvedValueOnce({
        rows: [
          { currency_code: "USD", rate_date: "2020-02-01", rate_to_eur: "0.7" },
        ],
      });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const [row] = await convertRowsToEur(
      [{ amount: 100, currency: "USD", day: "2020-01-16" }],
      "EUR",
      { useHistoricalRatesByDate: true },
    );
    expect(must(row, "row").amount_eur).toBeCloseTo(90, 6);
    expect(must(row, "row").used_fallback_rate).toBe(true);
    expect(must(row, "row").fallback_reason).toBe("historical_rate_missing");
  });

  it("should batch repeated historical misses without point DB lookups", async () => {
    query
      // getRates() initial load
      .mockResolvedValueOnce({ rows: [] })
      // historical index prefetch
      .mockResolvedValueOnce({ rows: [] });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve(""),
    });

    const rows = [
      { amount: 10, currency: "ZZZ", day: "2020-01-15" },
      { amount: 20, currency: "ZZZ", day: "2020-01-15" },
    ];

    const converted = await convertRowsToEur(rows, "EUR", {
      useHistoricalRatesByDate: true,
      dateField: "day",
    });

    expect(converted).toHaveLength(2);
    // No rate anywhere: both rows stay unconverted, never 1:1.
    expect(must(converted[0], "converted[0]").amount_eur).toBeUndefined();
    expect(must(converted[1], "converted[1]").amount_eur).toBeUndefined();

    const sqlCalls = query.mock.calls.map(([sql]) => sqlText(sql));
    const exactLookups = sqlCalls.filter((sql) =>
      sql.includes("where currency_code = $1 and rate_date = $2::date"),
    );
    const nearestLookups = sqlCalls.filter((sql) =>
      sql.includes("order by abs(rate_date - $2::date) asc"),
    );

    expect(exactLookups).toHaveLength(0);
    expect(nearestLookups).toHaveLength(0);
  });

  it("loads each provider tier once for an unindexed currency with many distinct days", async () => {
    // A daily series can contain hundreds of distinct days. A currency missing
    // from the stored index must not cause one DB/provider chain per day.
    query.mockResolvedValue({ rows: [] });
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve("") });

    const rows = Array.from({ length: 60 }, (_, i) => ({
      amount: 1,
      currency: "ZZZ",
      day: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    }));

    const converted = await convertRowsToEur(rows, "EUR", {
      useHistoricalRatesByDate: true,
      dateField: "day",
    });
    expect(converted).toHaveLength(60);

    const sqlCalls = query.mock.calls.map(([sql]) => sqlText(sql));
    const exactLookups = sqlCalls.filter((sql) =>
      sql.includes("where currency_code = $1 and rate_date = $2::date"),
    );
    const nearestLookups = sqlCalls.filter((sql) =>
      sql.includes("order by abs(rate_date - $2::date) asc"),
    );
    expect(exactLookups).toHaveLength(0);
    expect(nearestLookups).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps historical fallback metadata as an internal diagnostic", async () => {
    // A latest stored rate exists, but no historical one on or before the day.
    query.mockImplementation((sql) =>
      Promise.resolve(sqlText(sql).includes("is_latest =")
        ? { rows: [{ currency_code: "USD", rate_to_eur: "0.9" }] }
        : { rows: [] }),
    );
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve("") });

    const [converted] = await convertRowsToEur(
      [{ id: 7, amount: 100, currency: "USD", day: "2020-01-15" }],
      "EUR",
      { useHistoricalRatesByDate: true, dateField: "day" },
    );

    expect(converted).toMatchObject({
      id: 7,
      amount_eur: 90,
      used_fallback_rate: true,
      fallback_reason: "historical_rate_missing",
    });
    expect(mockOf(logger, "warn")).toHaveBeenCalledWith(
      "Historical FX missing, falling back to current rate",
      { currency: "USD", date: "2020-01-15" },
    );
  });

  it("keeps successful unindexed historical conversion date-specific and row-order invariant", async () => {
    query.mockResolvedValue({ rows: [] });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`
        <Cube time="2025-04-01"><Cube currency="USD" rate="2"/></Cube>
        <Cube time="2025-04-02"><Cube currency="USD" rate="4"/></Cube>
      `),
    });
    const rows = [
      { id: 1, amount: 100, currency: "USD", day: "2025-04-01" },
      { id: 2, amount: 100, currency: "USD", day: "2025-04-02" },
    ];

    const forward = await convertRowsToEur(rows, "EUR", {
      useHistoricalRatesByDate: true,
      dateField: "day",
    });
    const reverse = await convertRowsToEur([...rows].reverse(), "EUR", {
      useHistoricalRatesByDate: true,
      dateField: "day",
    });

    expect(
      forward.map(({ id, amount_eur, used_fallback_rate }) => ({
        id,
        amount_eur,
        used_fallback_rate,
      })),
    ).toEqual([
      { id: 1, amount_eur: 50, used_fallback_rate: undefined },
      { id: 2, amount_eur: 25, used_fallback_rate: undefined },
    ]);
    expect(
      reverse.map(({ id, amount_eur, used_fallback_rate }) => ({
        id,
        amount_eur,
        used_fallback_rate,
      })),
    ).toEqual([
      { id: 2, amount_eur: 25, used_fallback_rate: undefined },
      { id: 1, amount_eur: 50, used_fallback_rate: undefined },
    ]);
    // First request fetched once and populated the shared historical index;
    // reversing the second request therefore performs no additional HTTP work.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const writes = query.mock.calls.filter(([sql]) =>
      sqlText(sql).includes("from unnest"),
    );
    expect(writes).toHaveLength(1);
  });

  it("does not fetch historical rates when source and target currencies match", async () => {
    query.mockResolvedValue({ rows: [] });
    global.fetch = vi.fn();

    const converted = await convertRowsToEur(
      [{ amount: 100, currency: "ZZZ", day: "2025-04-01" }],
      "ZZZ",
      { useHistoricalRatesByDate: true, dateField: "day" },
    );

    expect(must(converted[0], "converted[0]").amount_eur).toBe(100);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some(([sql]) => sqlText(sql).includes("from unnest")),
    ).toBe(false);
  });

  it("invalidates a replacement historical index after an in-flight fetch persists points", async () => {
    let releaseFetch: (() => void) | undefined;
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFetch = () =>
            resolve({
              ok: true,
              text: () =>
                Promise.resolve('<Cube time="2025-04-01"><Cube currency="USD" rate="2"/></Cube>'),
            });
        }),
    );
    query.mockResolvedValue({ rows: [] });

    const conversion = convertRowsToEur(
      [{ amount: 100, currency: "USD", day: "2025-04-01" }],
      "EUR",
      { useHistoricalRatesByDate: true, dateField: "day" },
    );
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    clearHistoricalIndexCache();
    await getHistoricalRateIndex(["USD"]);
    must(releaseFetch, "releaseFetch")();
    await conversion;

    const indexLoadsBefore = query.mock.calls.filter(([sql]) =>
      sqlText(sql).includes("to_char(rate_date, 'yyyy-mm-dd')"),
    ).length;
    await getHistoricalRateIndex(["USD"]);
    const indexLoadsAfter = query.mock.calls.filter(([sql]) =>
      sqlText(sql).includes("to_char(rate_date, 'yyyy-mm-dd')"),
    ).length;
    expect(indexLoadsAfter).toBe(indexLoadsBefore + 1);
  });

  /**
   * Route the mocked DB by SQL shape — the backfill flow now spans the pairs
   * scan, the repair flag in user_settings, rate lookups/saves and the
   * fx_rate_to_eur stamping, so positional mocks are unreadable.
   */
  function dispatchQueries(handlers: Array<[string, QueryHandler]>) {
    query.mockImplementation((sql, params) => {
      const s = sqlText(sql);
      for (const [pattern, result] of handlers) {
        if (s.includes(sqlText(pattern))) {
          return Promise.resolve(typeof result === "function"
            ? result(params as readonly unknown[], s)
            : result);
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  }

  it("does not fabricate exchange-rate history for unresolvable old dates", async () => {
    // Block every external fetch so neither the 90d nor the full feed resolves.
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve(""),
    });

    dispatchQueries([
      ["FROM user_settings", { rows: [{ value: true }] }], // repair already done
      [
        "LEFT JOIN exchange_rates",
        {
          rows: [
            { currency_code: "USD", rate_date: pgLocalDate("2024-01-01") },
          ],
        },
      ],
      [
        "GROUP BY pt.currency",
        {
          rows: [
            { currency_code: "USD", rate_date: pgLocalDate("2024-01-01") },
          ],
        },
      ],
      [
        "where currency_code = $1 and rate_date = $2::date",
        { rows: [] },
      ],
      [
        "ORDER BY ABS(rate_date - $2::date)",
        { rows: [{ rate_to_eur: "0.91" }] },
      ], // nearest — must NOT be saved
      ["SELECT 1 FROM exchange_rates", { rows: [] }],
      ["SET fx_rate_to_eur", { rows: [], rowCount: 0 }],
    ]);

    const result = await backfillPortfolioHistoricalRates();

    // The nearest-rate fallback is reported as unresolved, not inserted as history.
    expect(result).toEqual({
      inserted: 0,
      missing: 1,
      repaired: 0,
      stamped: 0,
    });
    const inserts = query.mock.calls.filter(([sql]) =>
      sqlText(sql).includes("insert into exchange_rates"),
    );
    expect(inserts).toHaveLength(0);
  });

  it("should use ECB historical feed during backfill when exact date exists in 90d feed", async () => {
    query.mockReset();
    clearMemoryCache();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve("<Cube><Cube time='2026-02-01'><Cube currency='USD' rate='2.0000'/></Cube></Cube>"),
    });

    let savedRate = false;
    dispatchQueries([
      ["FROM user_settings", { rows: [{ value: true }] }], // repair already done
      [
        "LEFT JOIN exchange_rates",
        {
          rows: [
            { currency_code: "USD", rate_date: pgLocalDate("2026-02-01") },
          ],
        },
      ],
      [
        "GROUP BY pt.currency",
        {
          rows: [
            { currency_code: "USD", rate_date: pgLocalDate("2026-02-01") },
          ],
        },
      ],
      [
        "INSERT INTO exchange_rates",
        () => {
          savedRate = true;
          return { rows: [] };
        },
      ],
      [
        "where currency_code = $1 and rate_date = $2::date",
        { rows: [] },
      ],
      // Batched existence check (replaces the former per-row SELECT 1): returns
      // the now-present pair once the rate has been saved.
      [
        "JOIN UNNEST",
        () => ({
          rows: savedRate
            ? [{ currency_code: "USD", rate_date: "2026-02-01" }]
            : [],
        }),
      ],
      ["SET fx_rate_to_eur", { rows: [], rowCount: 1 }],
    ]);

    const result = await backfillPortfolioHistoricalRates();

    expect(result).toEqual({
      inserted: 1,
      missing: 0,
      repaired: 0,
      stamped: 1,
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("eurofxref-hist-90d.xml"),
      expect.any(Object),
    );
  });

  it("surfaces a stored rate that breaks its contract during the one-time repair", async () => {
    query.mockReset();
    clearMemoryCache();
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes("eurofxref-hist.xml")) {
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve("<Cube><Cube time='2020-03-02'><Cube currency='USD' rate='2.0000'/></Cube></Cube>"),
        });
      }
      return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("") });
    });

    dispatchQueries([
      ["FROM user_settings", { rows: [] }],
      [
        "GROUP BY pt.currency",
        {
          rows: [
            { currency_code: "USD", rate_date: pgLocalDate("2020-03-07") },
          ],
        },
      ],
      // NUMERIC arrives as a string; a number here means the read is wrong.
      [
        "WHERE currency_code = ANY",
        {
          rows: [
            {
              currency_code: "USD",
              rate_date: "2020-03-07",
              rate_to_eur: 0.91,
            },
          ],
        },
      ],
    ]);

    await expect(backfillPortfolioHistoricalRates()).rejects.toBeInstanceOf(
      RowContractError,
    );
  });

  it("repairs previously fabricated old rates from the full ECB history (one-time)", async () => {
    query.mockReset();
    clearMemoryCache();

    // 90d feed empty; full-history feed carries the true old rate (1/2 = 0.5).
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes("eurofxref-hist.xml")) {
        return Promise.resolve({
          ok: true,
          text: () =>
            Promise.resolve("<Cube><Cube time='2020-03-02'><Cube currency='USD' rate='2.0000'/></Cube></Cube>"),
        });
      }
      return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("") });
    });

    let repairFlagSet = false;
    const savedRates: (readonly unknown[])[] = [];
    dispatchQueries([
      [
        "FROM user_settings",
        () => ({ rows: repairFlagSet ? [{ value: true }] : [] }),
      ],
      [
        "INSERT INTO user_settings",
        () => {
          repairFlagSet = true;
          return { rows: [] };
        },
      ],
      ["LEFT JOIN exchange_rates", { rows: [] }], // nothing missing after repair
      // weekend txn date 2020-03-07 → stored fabricated rate differs from truth
      [
        "GROUP BY pt.currency",
        {
          rows: [
            { currency_code: "USD", rate_date: pgLocalDate("2020-03-07") },
          ],
        },
      ],
      [
        "WHERE currency_code = ANY",
        {
          rows: [
            {
              currency_code: "USD",
              rate_date: "2020-03-07",
              rate_to_eur: "0.91",
            },
          ],
        },
      ],
      [
        "INSERT INTO exchange_rates",
        (params) => {
          savedRates.push(params);
          return { rows: [] };
        },
      ],
      ["SET fx_rate_to_eur", { rows: [], rowCount: 1 }],
    ]);

    const result = await backfillPortfolioHistoricalRates();

    expect(result).toEqual({
      inserted: 0,
      missing: 0,
      repaired: 1,
      stamped: 1,
    });
    // The Saturday date resolves to the preceding business day's rate
    // (2020-03-02 in this fixture) per the on-or-before convention, and is
    // saved under the transaction's own date. saveHistoricalRate binds
    // (currency, rate, date).
    expect(savedRates).toHaveLength(1);
    expect(must(savedRates[0], "savedRates[0]")[0]).toBe("USD");
    expect(must(savedRates[0], "savedRates[0]")[1]).toBeCloseTo(0.5, 10);
    expect(must(savedRates[0], "savedRates[0]")[2]).toBe("2020-03-07");
    expect(repairFlagSet).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("eurofxref-hist.xml"),
      expect.any(Object),
    );
  });

  it("caches the historical rate index and reuses it across convertRowsToEur calls", async () => {
    clearMemoryCache();
    query.mockReset();
    query.mockImplementation((sql) => {
      const s = sqlText(sql);
      if (s.includes("is_latest =")) return Promise.resolve({ rows: [] }); // getRates → fallback
      if (s.includes("where currency_code = any")) {
        return Promise.resolve({
          rows: [
            {
              currency_code: "USD",
              rate_date: "2024-03-15",
              rate_to_eur: "0.9",
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const rows = [{ amount: 100, currency: "USD", day: "2024-03-15" }];
    const opts = { useHistoricalRatesByDate: true, dateField: "day" };

    const [first] = await convertRowsToEur(rows, "EUR", opts);
    const [second] = await convertRowsToEur(rows, "EUR", opts);

    expect(must(first, "first").amount_eur).toBeCloseTo(90, 6);
    expect(must(second, "second").amount_eur).toBeCloseTo(90, 6);

    // The full-history index load runs once; the second call reuses the cache.
    const indexLoads = query.mock.calls.filter(([sql]) =>
      sqlText(sql).includes("where currency_code = any"),
    );
    expect(indexLoads).toHaveLength(1);
  });

  // ── warmCache ─────────────────────────────────────────────
  it.each(["ecb", "supplementary", "both"])(
    "preserves unfetched currencies and persists only fresh quotes when %s succeeds",
    async (provider) => {
      query.mockResolvedValue({
        rows: [{ currency_code: "AED", rate_to_eur: "0.3" }],
      });
      // Statements inside the transaction run through the ambient query(),
      // not the client.
      withTransaction.mockImplementation(async (fn) =>
        fn(partial<PgPoolClient>({ query: vi.fn() })),
      );
      global.fetch = vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).includes("ecb")
          ? {
              ok: provider !== "supplementary",
              text: () => Promise.resolve('<Cube currency="USD" rate="2"/>'),
            }
          : {
              ok: provider !== "ecb",
              json: () => Promise.resolve(({
                result: "success",
                rates: { USD: 4, GBP: 2 },
              })),
            }),
      );
      await warmCache();
      expect(await convertToCurrency(10, "AED", "EUR")).toBeCloseTo(3);
      expect(await convertToCurrency(10, "USD", "EUR")).toBeCloseTo(
        provider === "supplementary" ? 2.5 : 5,
      );
      // Neither provider nor the database knows SAR: it stays unavailable
      // instead of being filled from a built-in constant.
      expect((await loadCurrentRates()).SAR).toBeUndefined();
      const written = query.mock.calls
        .filter(([sql]) => sqlText(sql).includes("insert into exchange_rates"))
        .map(([, params]) => params?.[0]);
      expect(written.sort()).toEqual(
        provider === "ecb" ? ["USD"] : ["GBP", "USD"],
      );
    },
  );
  it("surfaces a stored latest rate that breaks its contract while warming", async () => {
    // NUMERIC arrives as a string; a number here means the read is wrong.
    query.mockResolvedValue({
      rows: [{ currency_code: "AED", rate_to_eur: 0.3 }],
    });
    global.fetch = vi
      .fn()
      .mockImplementation((url) =>
        Promise.resolve(String(url).includes("ecb")
          ? { ok: true, text: () => Promise.resolve('<Cube currency="USD" rate="2"/>') }
          : { ok: false, status: 503 }),
      );

    await expect(warmCache()).rejects.toBeInstanceOf(RowContractError);
  });

  it("should warm cache without throwing", async () => {
    // Mock both upstream fetches so the test never reaches real ECB / open.er-api
    // endpoints. The unmocked variant flaked under CI coverage instrumentation
    // (845ms locally → >5s in CI when network was slow/blocked).
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("") })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve(({})),
      });

    await expect(warmCache()).resolves.not.toThrow();
  });

  it("should warm cache from fallback when both APIs are unavailable", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("") })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve(({})),
      });

    await warmCache();

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockOf(logger, "warn")).toHaveBeenCalledWith(
      expect.stringContaining("all APIs unavailable"),
    );
  });
});
