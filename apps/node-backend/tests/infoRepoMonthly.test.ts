import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import {
  mockCurrencyConversion,
  mockedConvertRowsToEur,
} from "./helpers/mockCurrencyConversion.ts";

import { mockLogger } from "./helpers/mockLogger.ts";
vi.mock("../src/database/connection.ts", () => mockConnection());

vi.mock("../src/services/currency/currencyConversionService.ts", () =>
  mockCurrencyConversion(),
);

vi.mock("../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

vi.mock("../src/repositories/infoRepositoryHelpers.ts", async () => {
  const actual = await vi.importActual(
    "../src/repositories/infoRepositoryHelpers.ts",
  );
  return {
    ...actual,
    mvAvailable: vi.fn(),
    getIncludeTransfers: vi.fn().mockResolvedValue(false),
    clearMvCache: actual.clearMvCache,
  };
});

import { query as rawQuery } from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { convertRowsToEur as rawConvertRowsToEur } from "../src/services/currency/currencyConversionService.ts";
import { mvAvailable as rawMvAvailable } from "../src/repositories/infoRepositoryHelpers.ts";
import { getMonthlyFinancialSummary } from "../src/repositories/infoRepositoryMonthly.ts";
import { must } from "./helpers/must.ts";

const query = rawQuery as unknown as Mock<
  (text: string, params?: readonly unknown[]) => Promise<Partial<PgQueryResult>>
>;
const convertRowsToEur = mockedConvertRowsToEur(rawConvertRowsToEur);
const mvAvailable = vi.mocked(rawMvAvailable);

beforeEach(() => vi.clearAllMocks());

describe("getMonthlyFinancialSummary — materialized-view fast path", () => {
  // Was: the malformed lists below were asserted to bind as [99, 5, …] — every
  // bad element dropped, the summary quietly computed over a different set of
  // transactions than the caller asked to exclude. Rejecting surfaces it.
  // 2147483647 was in the dropped set only because of the old exclusive
  // `< MAX_INT4` bound; it is a legal int4 id and is kept now.
  it("rejects malformed exclusion lists instead of dropping the bad ids", async () => {
    mvAvailable.mockResolvedValue(true);

    await expect(
      getMonthlyFinancialSummary(
        // @ts-expect-error -- malformed ids on purpose: the repository must reject them at runtime
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

    const [, params] = must(query.mock.calls[0], "query.mock.calls[0]");
    expect(params).toEqual(expect.arrayContaining([2147483647, 99, 5]));
  });

  it("buckets per-(date,currency) grouped aggregates into income vs spending", async () => {
    mvAvailable.mockResolvedValueOnce(false);

    // Live path now returns SQL aggregates grouped by (date, currency): income
    // and spending are pre-summed per day. Empty months arrive with date null.
    // DATE columns arrive as local-midnight Dates.
    query.mockResolvedValueOnce({
      rows: [
        {
          month: 4,
          year: 2025,
          period_start: new Date(2025, 3, 1),
          period_end: new Date(2025, 3, 30),
          date: new Date(2025, 3, 5),
          currency: "EUR",
          cnt: "1",
          income_amount: "500",
          spending_amount: "0",
        },
        {
          month: 4,
          year: 2025,
          period_start: new Date(2025, 3, 1),
          period_end: new Date(2025, 3, 30),
          date: new Date(2025, 3, 10),
          currency: "EUR",
          cnt: "2",
          income_amount: "0",
          spending_amount: "-150",
        },
        {
          month: 5,
          year: 2025,
          period_start: new Date(2025, 4, 1),
          period_end: new Date(2025, 4, 31),
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

