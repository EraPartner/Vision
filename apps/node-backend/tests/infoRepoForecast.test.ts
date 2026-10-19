import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockedBatchConvertGroups } from "./helpers/mockCurrencyConversion.ts";
import type { Mock } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";

vi.mock("../src/database/connection.ts", () => mockConnection());

// getIncludeTransfers() reads `user_settings` (ADR-083). Stub it so the module
// under test does not spend a `query` mock call on the settings lookup — the
// call-count/param assertions below are about the cash-flow SQL only. Its
// behaviour is exercised for real in infoRepoForecast.db.test.ts.
vi.mock("../src/repositories/infoRepositoryHelpers.ts", async () => {
  const actual = await vi.importActual(
    "../src/repositories/infoRepositoryHelpers.ts",
  );
  return {
    ...actual,
    batchConvertGroupsWithHistoricalRateFallback: vi.fn(),
    getIncludeTransfers: vi.fn().mockResolvedValue(false),
  };
});

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import {
  batchConvertGroupsWithHistoricalRateFallback as rawBatchConvertGroupsWithHistoricalRateFallback,
  getIncludeTransfers as rawGetIncludeTransfers,
} from "../src/repositories/infoRepositoryHelpers.ts";
import {
  getCashflowComparison,
  getCashflowForecastData,
  getCashflowForecastDataRolling,
  getCashflowForecastDataByCategory,
} from "../src/repositories/infoRepositoryForecast.ts";
import { ValidationError } from "../src/middleware/errorHandler.ts";
import { appDateStringToUtc, todayAppDateString } from "../src/lib/timezone.ts";

const query = rawQuery as unknown as Mock<
  (text: string, params?: readonly unknown[]) => Promise<Partial<PgQueryResult>>
>;
const batchConvertGroupsWithHistoricalRateFallback = mockedBatchConvertGroups(
  rawBatchConvertGroupsWithHistoricalRateFallback,
);
const getIncludeTransfers = vi.mocked(rawGetIncludeTransfers);

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks wipes the factory's mockResolvedValue — restore the default.
  getIncludeTransfers.mockResolvedValue(false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-04-15T12:00:00Z"));
});

afterEach(() => vi.useRealTimers());

/** Matches the unfiltered ledger-start probe (last query of getCashflowComparison). */
const isLedgerStartSql = (sql: string) => /MIN\(t\.date\)/.test(sql);

/**
 * query() stub. The ledger-start probe answers with `firstDate` (a 'YYYY-MM-DD'
 * string or null), handed back as pg returns a DATE: a local-midnight Date.
 * Every other query returns no rows. Needed because the probe — not the result
 * rows — is what sets the historical-average divisor.
 */
function stubQueries(firstDate: string | null = null) {
  const pgFirstDate = firstDate ? new Date(`${firstDate}T00:00:00`) : null;
  query.mockImplementation(async (sql) =>
    isLedgerStartSql(sql)
      ? { rows: [{ first_date: pgFirstDate }] }
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
    expect(day20!.current).toBeNull();
    const day10 = r.without_planned.find((d) => d.day === 10);
    expect(day10!.current).toBe(0); // up to current day, value non-null
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
    expect(r.without_planned.find((d) => d.day === 5)!.average).toBe(53.33);
    // Day 10: ((100-30) + 60) / 3 = 43.33
    expect(r.without_planned.find((d) => d.day === 10)!.average).toBe(43.33);
    // Current day 1: 50; day 3 cumulative: 40
    expect(r.without_planned.find((d) => d.day === 1)!.current).toBe(50);
    expect(r.without_planned.find((d) => d.day === 3)!.current).toBe(40);
    // Future day 20 has no current
    expect(r.without_planned.find((d) => d.day === 20)!.current).toBeNull();
  });
});

describe("getCashflowForecastData", () => {
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
        // @ts-expect-error -- string amount_eur on purpose: the aggregation must coerce it
        { date: "2025-02-15", amount_eur: "0.1" },
        // @ts-expect-error -- string amount_eur on purpose: the aggregation must coerce it
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
    expect(r.history[0]!.date).toBe("2025-03-10");
  });

  it("coerces non-numeric amount_eur to 0", async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        // @ts-expect-error -- non-numeric amount_eur on purpose: the aggregation must coerce it to 0
        { date: "2025-03-10", amount_eur: "not a number" },
        { date: "2025-03-10", amount_eur: 5 },
      ],
      [],
      [],
      [],
    ]);
    const r = await getCashflowForecastData(1);
    expect(r.history[0]!.net).toBe(5);
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
        path_name: "Food:Groceries",
        net: -75,
      },
      {
        date: "2025-03-01",
        category_id: 2,
        general: "Bills",
        detail: "Rent",
        path_name: "Bills:Rent",
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
    expect(r.currentActualByCategory[0]!.date).toBe("2025-04-15");
    expect(r.scheduledActualByCategory).toEqual([
      {
        date: "2025-04-20",
        category_id: 1,
        general: "Bills",
        detail: "Rent",
        path_name: "Bills:Rent",
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
});
