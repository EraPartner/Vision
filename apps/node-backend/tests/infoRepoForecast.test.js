import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "./helpers/repoMocks.js";

vi.mock("../src/database/connection.js", () => mockConnection());

// getIncludeTransfers() reads `user_settings` (ADR-083). Stub it so the module
// under test does not spend a `query` mock call on the settings lookup — the
// call-count/param assertions below are about the cash-flow SQL only. Its
// behaviour is exercised for real in infoRepoForecast.db.test.js.
vi.mock("../src/repositories/infoRepositoryHelpers.js", async () => {
  const actual = await vi.importActual(
    "../src/repositories/infoRepositoryHelpers.js",
  );
  return {
    ...actual,
    batchConvertGroupsWithHistoricalRateFallback: vi.fn(),
    getIncludeTransfers: vi.fn().mockResolvedValue(false),
  };
});

import { query } from "../src/database/connection.js";
import {
  batchConvertGroupsWithHistoricalRateFallback,
  getIncludeTransfers,
} from "../src/repositories/infoRepositoryHelpers.js";
import {
  getCashflowComparison,
  getCashflowForecastData,
  getCashflowForecastDataRolling,
  getCashflowForecastDataByCategory,
} from "../src/repositories/infoRepositoryForecast.js";
import { ValidationError } from "../src/middleware/errorHandler.js";
import { appDateStringToUtc, todayAppDateString } from "../src/lib/timezone.js";

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks wipes the factory's mockResolvedValue — restore the default.
  getIncludeTransfers.mockResolvedValue(false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-04-15T12:00:00Z"));
});

afterEach(() => vi.useRealTimers());

/** Matches the unfiltered ledger-start probe (last query of getCashflowComparison). */
const isLedgerStartSql = (sql) => /MIN\(t\.date\)/.test(sql);

/**
 * query() stub. The ledger-start probe answers with `firstDate` (a 'YYYY-MM-DD'
 * string or null); every other query returns no rows. Needed because the probe
 * — not the result rows — is what sets the historical-average divisor.
 */
function stubQueries(firstDate = null) {
  query.mockImplementation(async (sql) =>
    isLedgerStartSql(sql)
      ? { rows: [{ first_date: firstDate }] }
      : { rows: [] },
  );
}

describe("getCashflowComparison", () => {
  function setupEmpty() {
    stubQueries(null);
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValue([
      [],
      [],
      [],
      [],
    ]);
  }

  it("runs five parallel queries (past, current, planned current, planned hist, ledger start)", async () => {
    setupEmpty();
    await getCashflowComparison([], [], "EUR");
    expect(query).toHaveBeenCalledTimes(5);
    // Windows are anchored on the bound APP_TIMEZONE date ($1 here — no
    // exclusion params to allocate around), never on Postgres CURRENT_DATE.
    expect(query.mock.calls[0][0]).toContain(
      "date >= date_trunc('month', $1::date) - make_interval(months => $2::int)",
    );
    expect(query.mock.calls[0][0]).toContain(
      "date < date_trunc('month', $1::date)",
    );
    expect(query.mock.calls[0][1]).toEqual(["2025-04-15", 24]);
    expect(query.mock.calls[1][0]).toContain(
      "date <= (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')",
    );
    expect(query.mock.calls[1][1]).toEqual(["2025-04-15"]);
    expect(query.mock.calls[2][0]).toContain("FROM planned_transactions");
    expect(query.mock.calls[3][0]).toContain("month_key");
    // Executed planned transactions must be excluded from the overlays, or an
    // executed non-recurring row double-counts against its real transaction.
    expect(query.mock.calls[2][0]).toContain("is_executed = false");
    expect(query.mock.calls[3][0]).toContain("is_executed = false");
    // The ledger-start probe is appended LAST so the four data queries keep
    // their call order, and carries no filters of any kind (see D2 below).
    expect(query.mock.calls[4][0]).toContain("MIN(t.date)");
  });

  it("returns days_in_month, current_day, month, year aligned to the system clock", async () => {
    setupEmpty();
    const r = await getCashflowComparison([], [], "EUR");
    expect(r.month).toBe(4);
    expect(r.year).toBe(2025);
    expect(r.current_day).toBe(15);
    expect(r.days_in_month).toBe(30);
    expect(r.without_planned).toHaveLength(30);
    expect(r.with_planned).toHaveLength(30);
  });

  it("marks future-day current as null in the output", async () => {
    setupEmpty();
    const r = await getCashflowComparison([], [], "EUR");
    const day20 = r.without_planned.find((d) => d.day === 20);
    expect(day20.current).toBeNull();
    const day10 = r.without_planned.find((d) => d.day === 10);
    expect(day10.current).toBe(0); // up to current day, value non-null
  });

  it("projects scheduled ledger rows without treating them as current", async () => {
    stubQueries("2025-01-05");
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [
        { day_of_month: 10, amount_eur: 50 },
        { day_of_month: 20, amount_eur: -30 },
      ],
      [],
      [],
    ]);

    const r = await getCashflowComparison([], [], "EUR");
    expect(r.without_planned.find((d) => d.day === 20)?.current).toBeNull();
    expect(r.with_planned.find((d) => d.day === 19)?.current).toBe(50);
    expect(r.with_planned.find((d) => d.day === 20)?.current).toBe(20);
  });

  it("builds cumulative averages from past month data", async () => {
    stubQueries("2025-01-05"); // ledger starts 2025-01
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { day_of_month: 5, month_key: "2025-01", amount_eur: 100 },
        { day_of_month: 10, month_key: "2025-01", amount_eur: -30 },
        { day_of_month: 5, month_key: "2025-02", amount_eur: 60 },
      ],
      [
        { day_of_month: 1, amount_eur: 50 },
        { day_of_month: 3, amount_eur: -10 },
      ],
      [],
      [],
    ]);

    const r = await getCashflowComparison([], [], "EUR");
    // Divisor is elapsed months since the ledger STARTED (the unfiltered probe
    // says 2025-01), NOT the count of months carrying rows: "today" is
    // 2025-04-15, so Jan/Feb/Mar are all elapsed and March's silence is a real
    // zero → 3.
    // Day 5: (100 from Jan + 60 from Feb) / 3 = 53.33
    expect(r.without_planned.find((d) => d.day === 5).average).toBe(53.33);
    // Day 10: ((100-30) + 60) / 3 = 43.33
    expect(r.without_planned.find((d) => d.day === 10).average).toBe(43.33);
    // Current day 1: 50; day 3 cumulative: 40
    expect(r.without_planned.find((d) => d.day === 1).current).toBe(50);
    expect(r.without_planned.find((d) => d.day === 3).current).toBe(40);
    // Future day 20 has no current
    expect(r.without_planned.find((d) => d.day === 20).current).toBeNull();
  });

  it("binds category and recipient exclusion params with sequential numbering", async () => {
    setupEmpty();
    await getCashflowComparison([1, 2], [9], "EUR");
    const [pastSql, params] = query.mock.calls[0];
    expect(pastSql).toContain("NOT IN ($1, $2)");
    expect(pastSql).toContain("NOT IN ($3)");
    // The exclusion params keep $1..$k; the module's own bound values (anchor
    // date, then the window length) are allocated after them.
    expect(pastSql).toContain("date_trunc('month', $4::date)");
    expect(pastSql).toContain("make_interval(months => $5::int)");
    expect(params).toEqual([1, 2, 9, "2025-04-15", 24]);
    // The current-month query references $1..$4 only, so it is passed exactly
    // that contiguous prefix — Postgres counts parameters by the highest $n in
    // the text, so a gap or an unreferenced trailing slot is an error.
    expect(query.mock.calls[1][1]).toEqual([1, 2, 9, "2025-04-15"]);
  });

  it("skips JOIN when there are no exclusions", async () => {
    setupEmpty();
    await getCashflowComparison([], [], "EUR");
    const [pastSql] = query.mock.calls[0];
    expect(pastSql).not.toContain("LEFT JOIN recipients");
  });
});

describe("getCashflowForecastData", () => {
  it("issues 4 parallel queries with the configured history window", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [],
      [],
      [],
    ]);

    const r = await getCashflowForecastData(12, [], [], "EUR");
    expect(query).toHaveBeenCalledTimes(4);
    // historyMonths is bound, not interpolated (and 12 never appears in the text).
    expect(query.mock.calls[0][0]).toContain(
      "make_interval(months => $2::int)",
    );
    expect(query.mock.calls[0][0]).not.toContain("interval '12 months'");
    expect(query.mock.calls[0][1]).toEqual(["2025-04-15", 12]);
    expect(r).toMatchObject({ historyMonths: 12 });
  });

  it("aggregates transactions by date and sorts ascending", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { date: "2025-02-15", amount_eur: 50 },
        { date: "2025-02-15", amount_eur: -20 },
        { date: "2025-01-30", amount_eur: 100 },
      ],
      [],
      [],
      [],
    ]);

    const r = await getCashflowForecastData(3);
    expect(r.history).toEqual([
      { date: "2025-01-30", net: 100 },
      { date: "2025-02-15", net: 30 },
    ]);
    expect(r.currentActual).toEqual([]);
  });

  it("separates future ledger rows from actual-to-date", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [
        { date: "2025-04-15", amount_eur: 10 },
        { date: "2025-04-20", amount_eur: -25 },
      ],
      [],
      [],
    ]);

    const r = await getCashflowForecastData(3);
    expect(r.currentActual).toEqual([{ date: "2025-04-15", net: 10 }]);
    expect(r.scheduledActual).toEqual([{ date: "2025-04-20", net: -25 }]);
  });

  it("aggregates same-day decimal amounts without binary float drift", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { date: "2025-02-15", amount_eur: "0.1" },
        { date: "2025-02-15", amount_eur: "0.2" },
      ],
      [],
      [],
      [],
    ]);

    const r = await getCashflowForecastData(3);
    expect(r.history).toEqual([{ date: "2025-02-15", net: 0.3 }]);
  });

  it("formats Date instances as YYYY-MM-DD", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [{ date: new Date("2025-03-10T05:00:00Z"), amount_eur: 25 }],
      [],
      [],
      [],
    ]);
    const r = await getCashflowForecastData(1);
    expect(r.history[0].date).toBe("2025-03-10");
  });

  it("coerces non-numeric amount_eur to 0", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { date: "2025-03-10", amount_eur: "not a number" },
        { date: "2025-03-10", amount_eur: 5 },
      ],
      [],
      [],
      [],
    ]);
    const r = await getCashflowForecastData(1);
    expect(r.history[0].net).toBe(5);
  });
});

describe("getCashflowForecastDataRolling", () => {
  it("rejects out-of-range historyMonths", async () => {
    // ValidationError (not a plain Error) so the route surface answers 400, not 500.
    await expect(
      getCashflowForecastDataRolling(0, 30, 60),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(getCashflowForecastDataRolling(0, 30, 60)).rejects.toThrow(
      /historyMonths/,
    );
    await expect(getCashflowForecastDataRolling(121, 30, 60)).rejects.toThrow(
      /historyMonths/,
    );
    await expect(getCashflowForecastDataRolling(1.5, 30, 60)).rejects.toThrow(
      /historyMonths/,
    );
  });

  it("rejects out-of-range daysBack", async () => {
    await expect(getCashflowForecastDataRolling(12, 0, 60)).rejects.toThrow(
      /daysBack/,
    );
    await expect(getCashflowForecastDataRolling(12, 366, 60)).rejects.toThrow(
      /daysBack/,
    );
  });

  it("rejects out-of-range daysForward", async () => {
    await expect(getCashflowForecastDataRolling(12, 30, 0)).rejects.toThrow(
      /daysForward/,
    );
    await expect(getCashflowForecastDataRolling(12, 30, 366)).rejects.toThrow(
      /daysForward/,
    );
  });

  it("runs three parallel queries (history, current rolling, planned future)", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [],
      [],
    ]);

    await getCashflowForecastDataRolling(12, 30, 60);
    expect(query).toHaveBeenCalledTimes(3);
    // daysBack / historyMonths / daysForward are all bound.
    expect(query.mock.calls[0][0]).toContain("make_interval(days => $2::int)");
    expect(query.mock.calls[0][0]).toContain(
      "make_interval(months => $3::int)",
    );
    expect(query.mock.calls[0][1]).toEqual(["2025-04-15", 30, 12]);
    expect(query.mock.calls[1][0]).toContain("make_interval(days => $3::int)");
    expect(query.mock.calls[1][1]).toEqual(["2025-04-15", 30, 60]);
    expect(query.mock.calls[2][0]).toContain("planned_date > $1::date");
    expect(query.mock.calls[2][0]).toContain("make_interval(days => $2::int)");
    expect(query.mock.calls[2][1]).toEqual(["2025-04-15", 60]);
  });

  it("returns ascending-date series for all three buckets", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { date: "2025-02-01", amount_eur: 10 },
        { date: "2025-01-15", amount_eur: 20 },
      ],
      [
        { date: "2025-04-01", amount_eur: 5 },
        { date: "2025-04-20", amount_eur: -15 },
      ],
      [{ date: "2025-05-15", amount_eur: 100 }],
    ]);
    const r = await getCashflowForecastDataRolling(3, 30, 60);
    expect(r.history.map((d) => d.date)).toEqual(["2025-01-15", "2025-02-01"]);
    expect(r.currentActual).toEqual([{ date: "2025-04-01", net: 5 }]);
    expect(r.scheduledActual).toEqual([{ date: "2025-04-20", net: -15 }]);
    expect(r.plannedCurrent).toEqual([{ date: "2025-05-15", net: 100 }]);
  });
});

describe("getCashflowForecastDataByCategory", () => {
  it("runs two parallel queries (history + current) joined to categories", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [],
    ]);

    await getCashflowForecastDataByCategory(6);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("LEFT JOIN categories cat");
    expect(query.mock.calls[0][0]).toContain(
      "make_interval(months => $2::int)",
    );
    expect(query.mock.calls[0][1]).toEqual(["2025-04-15", 6]);
    expect(query.mock.calls[1][0]).toContain(
      "date <= (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')",
    );
  });

  it("aggregates by date AND category, preserving labels", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        {
          date: "2025-03-01",
          category_id: 1,
          general: "Food",
          detail: "Groceries",
          amount_eur: -50,
        },
        {
          date: "2025-03-01",
          category_id: 1,
          general: "Food",
          detail: "Groceries",
          amount_eur: -25,
        },
        {
          date: "2025-03-01",
          category_id: 2,
          general: "Bills",
          detail: "Rent",
          amount_eur: -1000,
        },
      ],
      [],
    ]);

    const r = await getCashflowForecastDataByCategory(3);
    expect(r.historyByCategory).toEqual([
      {
        date: "2025-03-01",
        category_id: 1,
        general: "Food",
        detail: "Groceries",
        net: -75,
      },
      {
        date: "2025-03-01",
        category_id: 2,
        general: "Bills",
        detail: "Rent",
        net: -1000,
      },
    ]);
  });

  it("separates scheduled category rows from actual-to-date", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [
        {
          date: "2025-04-15",
          category_id: 1,
          general: "Bills",
          detail: "Rent",
          amount_eur: -10,
        },
        {
          date: "2025-04-20",
          category_id: 1,
          general: "Bills",
          detail: "Rent",
          amount_eur: -25,
        },
      ],
    ]);

    const r = await getCashflowForecastDataByCategory(3);
    expect(r.currentActualByCategory).toHaveLength(1);
    expect(r.currentActualByCategory[0].date).toBe("2025-04-15");
    expect(r.scheduledActualByCategory).toEqual([
      {
        date: "2025-04-20",
        category_id: 1,
        general: "Bills",
        detail: "Rent",
        net: -25,
      },
    ]);
  });

  it("replaces missing category metadata with Uncategorized", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        {
          date: "2025-03-01",
          category_id: null,
          general: null,
          detail: null,
          amount_eur: -10,
        },
      ],
      [],
    ]);
    const r = await getCashflowForecastDataByCategory(3);
    expect(r.historyByCategory[0]).toMatchObject({
      category_id: null,
      general: "Uncategorized",
      detail: "Uncategorized",
    });
  });

  it("binds exclusion params correctly across both filters", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [],
    ]);

    await getCashflowForecastDataByCategory(3, [10, 11], [22]);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([10, 11, 22, "2025-04-15", 3]);
    expect(query.mock.calls[1][1]).toEqual([10, 11, 22, "2025-04-15"]);
  });
});

// ADR-083: every `transactions` query in this module must carry the transfer
// predicate unless the user opted in, exactly like the sibling surfaces
// (infoRepositoryAverageVsCurrent.js, infoRepositoryMonthly.js). The previous
// version of this suite asserted the substrings it expected to be PRESENT and
// so never noticed the absent one; these cases assert both directions.
describe("ADR-083 transfer exclusion", () => {
  /**
   * SQL of every DATA query issued against `transactions`. Excludes the
   * ledger-start probe, which is unfiltered by design (asserted separately).
   */
  const transactionSqls = () =>
    query.mock.calls
      .map((c) => c[0])
      .filter(
        (sql) => /FROM transactions\b/.test(sql) && !isLedgerStartSql(sql),
      );

  const cases = [
    ["getCashflowComparison", () => getCashflowComparison([], [], "EUR"), 4, 2],
    [
      "getCashflowForecastData",
      () => getCashflowForecastData(12, [], [], "EUR"),
      4,
      2,
    ],
    [
      "getCashflowForecastDataRolling",
      () => getCashflowForecastDataRolling(12, 30, 60),
      3,
      2,
    ],
    [
      "getCashflowForecastDataByCategory",
      () => getCashflowForecastDataByCategory(6),
      2,
      2,
    ],
  ];

  for (const [name, call, queryCount, txnQueryCount] of cases) {
    it(`${name} excludes transfers by default`, async () => {
      query.mockResolvedValue({ rows: [] });
      batchConvertGroupsWithHistoricalRateFallback.mockResolvedValue(
        Array.from({ length: queryCount }, () => []),
      );

      await call();
      const sqls = transactionSqls();
      expect(sqls).toHaveLength(txnQueryCount);
      for (const sql of sqls)
        expect(sql).toContain("AND t.is_transfer = false");
    });

    it(`${name} keeps transfers when includeTransfers is on`, async () => {
      getIncludeTransfers.mockResolvedValue(true);
      query.mockResolvedValue({ rows: [] });
      batchConvertGroupsWithHistoricalRateFallback.mockResolvedValue(
        Array.from({ length: queryCount }, () => []),
      );

      await call();
      for (const sql of transactionSqls())
        expect(sql).not.toContain("is_transfer");
    });
  }

  // planned_transactions has no `is_transfer` column (ADR-083 flagged
  // `transactions` only), so the planned overlays deliberately carry no
  // predicate. Pinned so a future "consistency" edit does not add one and
  // break the query with a 42703 undefined_column.
  it("never puts a transfer predicate on the planned_transactions overlays", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValue([
      [],
      [],
      [],
      [],
    ]);

    await getCashflowComparison([], [], "EUR");
    await getCashflowForecastData(12, [], [], "EUR");
    const plannedSqls = query.mock.calls
      .map((c) => c[0])
      .filter((sql) => /FROM planned_transactions\b/.test(sql));
    expect(plannedSqls).toHaveLength(4);
    for (const sql of plannedSqls) expect(sql).not.toContain("is_transfer");
  });

  // The ledger-start probe decides the historical-average divisor. If any
  // filter reached it, excluding a category (or excluding transfers) could
  // empty the oldest months and silently re-base the divisor — the average
  // line would move for reasons unrelated to the excluded rows.
  it("never filters the ledger-start probe", async () => {
    stubQueries("2024-01-01");
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValue([
      [],
      [],
      [],
      [],
    ]);

    await getCashflowComparison([1, 2], [9], "EUR");
    const [probeSql, probeParams] = query.mock.calls.find((c) =>
      isLedgerStartSql(c[0]),
    );
    expect(probeSql).not.toContain("is_transfer");
    expect(probeSql).not.toContain("NOT IN");
    expect(probeSql).not.toContain("LEFT JOIN");
    expect(probeSql).not.toContain("planned_transactions");
    expect(probeSql).toContain("t.is_active = true");
    // "Unfiltered" is about predicates, not parameters: the only two values it
    // binds are its own window (the anchor date and the lookback length).
    expect(probeParams).toEqual(["2025-04-15", 24]);
    // Still window-clamped: a row older than the lookback cannot lengthen it.
    expect(probeSql).toContain(
      "t.date >= date_trunc('month', $1::date) - make_interval(months => $2::int)",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ONE CLOCK (was a PIN: APP_TIMEZONE month math against CURRENT_DATE windows)
// ─────────────────────────────────────────────────────────────────────────────
//
// This module used to run on two clocks: `daysInMonth` / `currentDay` /
// `lastCompleteMonthIdx` came from `todayAppDateString()` (APP_TIMEZONE, ADR-009)
// while every window predicate came from Postgres `CURRENT_DATE` (the DB
// session's zone, UTC). They name the same calendar day for ~22 hours out of 24
// — which is why a suite that runs at a random hour never saw it — and a
// different one in between. On a month's last day that gap is a whole month of
// arithmetic: the JS side had already rolled into month M+1 and counted M as
// the last complete month in the historical-average divisor, while the SQL
// window still ended at the start of M, so M's rows never reached the
// numerator. The average line was divided by one month too many.
//
// The clock here is pinned to that exact instant, so these cases exercise the
// drift window whatever hour the suite runs at.
describe("one clock: APP_TIMEZONE anchor across a month rollover", () => {
  // Pin 00:30 on 1 April in the configured application timezone. Deriving the
  // instant from APP_TIMEZONE keeps this valid for both positive and negative
  // UTC offsets; a hard-coded Brussels instant made the suite itself wrong in
  // America/New_York even though the production query was zone-agnostic.
  const ROLLOVER = new Date(
    appDateStringToUtc("2025-04-01").getTime() + 30 * 60_000,
  );

  beforeEach(() => {
    vi.setSystemTime(ROLLOVER);
  });

  it("pins the first day of the month in APP_TIMEZONE", () => {
    expect(todayAppDateString()).toBe("2025-04-01");
  });

  const entryPoints = [
    ["getCashflowComparison", () => getCashflowComparison([], [], "EUR"), 4],
    [
      "getCashflowForecastData",
      () => getCashflowForecastData(12, [], [], "EUR"),
      4,
    ],
    [
      "getCashflowForecastDataRolling",
      () => getCashflowForecastDataRolling(12, 30, 60),
      3,
    ],
    [
      "getCashflowForecastDataByCategory",
      () => getCashflowForecastDataByCategory(6),
      2,
    ],
  ];

  for (const [name, call, groups] of entryPoints) {
    it(`${name} anchors every query on the app date, never on CURRENT_DATE`, async () => {
      stubQueries("2025-02-05");
      batchConvertGroupsWithHistoricalRateFallback.mockResolvedValue(
        Array.from({ length: groups }, () => []),
      );

      await call();

      expect(query.mock.calls.length).toBeGreaterThan(0);
      for (const [sql, params] of query.mock.calls) {
        expect(sql).not.toContain("CURRENT_DATE");
        // No exclusions here, so the anchor is $1 in every query.
        expect(params[0]).toBe("2025-04-01");
      }
    });
  }
});
