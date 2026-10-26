import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { mockConnection } from "./helpers/repoMocks.ts";
import {
  mockCurrencyConversion,
  mockedConvertRowsToEur,
} from "./helpers/mockCurrencyConversion.ts";

vi.mock("../src/database/connection.ts", () => mockConnection());

vi.mock("../src/services/currency/currencyConversionService.ts", () =>
  mockCurrencyConversion(),
);

vi.mock("../src/repositories/infoRepositoryHelpers.ts", async () => {
  const actual = await vi.importActual(
    "../src/repositories/infoRepositoryHelpers.ts",
  );
  return {
    ...actual,
    mvAvailable: vi.fn(),
    getIncludeTransfers: vi.fn().mockResolvedValue(false),
  };
});

import {
  query as rawQuery,
  queryPrepared as rawQueryPrepared,
} from "../src/database/connection.ts";
import type { PgQueryResult } from "../src/database/connection.ts";
import { convertRowsToEur as rawConvertRowsToEur } from "../src/services/currency/currencyConversionService.ts";
import { mvAvailable as rawMvAvailable } from "../src/repositories/infoRepositoryHelpers.ts";
import { statisticsRepository } from "../src/repositories/infoRepositoryStatistics.ts";
import { must } from "./helpers/must.ts";

const query = rawQuery as unknown as Mock<
  (text: string, params?: readonly unknown[]) => Promise<Partial<PgQueryResult>>
>;
const queryPrepared = rawQueryPrepared as unknown as Mock<
  (
    name: string,
    text: string,
    params?: readonly unknown[],
  ) => Promise<Partial<PgQueryResult>>
>;
const convertRowsToEur = mockedConvertRowsToEur(rawConvertRowsToEur);
const mvAvailable = vi.mocked(rawMvAvailable);

beforeEach(() => vi.clearAllMocks());

describe("statisticsRepository.getCategoryBreakdown", () => {
  it("groups categories from live query and sorts by count desc", async () => {
    mvAvailable.mockResolvedValueOnce(false);
    // Live path now aggregates per (category, currency) in SQL, so rows arrive
    // pre-summed with a COUNT(*) AS cnt column.
    query.mockResolvedValueOnce({
      rows: [
        { category_id: 1, name: "A", amount: "-30", cnt: "2", currency: "EUR" },
        { category_id: 2, name: "B", amount: "-50", cnt: "1", currency: "EUR" },
      ],
    });
    convertRowsToEur.mockResolvedValueOnce([
      { category_id: 1, name: "A", amount_eur: -30, cnt: "2" },
      { category_id: 2, name: "B", amount_eur: -50, cnt: "1" },
    ]);

    const r = await statisticsRepository.getCategoryBreakdown();
    expect(r[0]).toMatchObject({ id: 1, count: 2, total: -30 });
    expect(r[1]).toMatchObject({ id: 2, count: 1, total: -50 });
  });
});

describe("statisticsRepository.getTransactionCount", () => {
  it("parses integer count from prepared query", async () => {
    queryPrepared.mockResolvedValueOnce({ rows: [{ count: "5000" }] });
    expect(await statisticsRepository.getTransactionCount()).toBe(5000);
  });
});

describe("statisticsRepository.getCategoryPivot", () => {
  it("returns ordered path IDs and names without parsing display labels", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          period: "2025-04",
          category_id: 3,
          category_name: "Home:Kitchen:Apples",
          category_path_ids: [1, 2, 3],
          category_path_segments: ["Home", "Kitchen:Tools", "Apples"],
          date: new Date(2025, 3, 1),
          currency: "EUR",
          income: null,
          expense: "-10",
          cnt: "1",
        },
      ],
    });
    convertRowsToEur.mockImplementationOnce((rows) =>
      Promise.resolve(
        rows.map((row) => ({
          ...row,
          // Already numeric: the repository maps `amount` through toNumber.
          amount_eur: Number(row.amount),
        })),
      ),
    );
    const pivot = await statisticsRepository.getCategoryPivot();
    expect(
      must(pivot.categoryPivot["2025-04"], 'pivot.categoryPivot["2025-04"]')[0],
    ).toMatchObject({
      categoryPathIds: [1, 2, 3],
      categoryPathSegments: ["Home", "Kitchen:Tools", "Apples"],
      total: -10,
      transactionCount: 1,
    });
  });

  it("splits income booked on partner and joint accounts into incomeByOwner", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          period: "2025-04",
          category_id: 7,
          category_name: "Income:Salary",
          category_path_ids: [6, 7],
          category_path_segments: ["Income", "Salary"],
          date: new Date(2025, 3, 25),
          currency: "EUR",
          income: "3000",
          expense: null,
          income_partner: "1200.004",
          income_joint: "300",
          cnt: "3",
        },
        {
          period: "2025-04",
          category_id: 8,
          category_name: "Income:Other",
          category_path_ids: [6, 8],
          category_path_segments: ["Income", "Other"],
          date: new Date(2025, 3, 26),
          currency: "EUR",
          income: "50",
          expense: null,
          income_partner: null,
          income_joint: null,
          cnt: "1",
        },
      ],
    });
    convertRowsToEur.mockImplementationOnce((rows) =>
      Promise.resolve(
        rows.map((row) => ({ ...row, amount_eur: Number(row.amount) })),
      ),
    );
    const pivot = await statisticsRepository.getCategoryPivot();
    const cells = must(
      pivot.categoryPivot["2025-04"],
      'pivot.categoryPivot["2025-04"]',
    );
    const salary = cells.find((c) => c.categoryId === 7);
    const other = cells.find((c) => c.categoryId === 8);
    // Owner legs never change the totals; `me` is the remainder of `income`.
    expect(salary).toMatchObject({
      total: 3000,
      income: 3000,
      transactionCount: 3,
      incomeByOwner: { partner: 1200, joint: 300 },
    });
    expect(other).not.toHaveProperty("incomeByOwner");
  });

  it("groups by period and category, sorts ascending by total", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    // The repo now converts two legs (income/expense) per grouped row; cnt is the
    // group's transaction count, counted once on the income leg.
    convertRowsToEur.mockResolvedValueOnce([
      {
        period: "2025-04",
        category_id: 1,
        category_name: "Food",
        _leg: "income",
        cnt: 1,
        amount_eur: 0,
      },
      {
        period: "2025-04",
        category_id: 1,
        category_name: "Food",
        _leg: "expense",
        cnt: 1,
        amount_eur: -100,
      },
      {
        period: "2025-04",
        category_id: 2,
        category_name: "Bills",
        _leg: "income",
        cnt: 1,
        amount_eur: 0,
      },
      {
        period: "2025-04",
        category_id: 2,
        category_name: "Bills",
        _leg: "expense",
        cnt: 1,
        amount_eur: -500,
      },
      {
        period: "2025-04",
        category_id: 1,
        category_name: "Food",
        _leg: "income",
        cnt: 1,
        amount_eur: 0,
      },
      {
        period: "2025-04",
        category_id: 1,
        category_name: "Food",
        _leg: "expense",
        cnt: 1,
        amount_eur: -50,
      },
    ]);

    const r = await statisticsRepository.getCategoryPivot();
    expect(r.categoryPivot["2025-04"]).toEqual([
      {
        categoryId: 2,
        categoryName: "Bills",
        categoryPathIds: [],
        categoryPathSegments: [],
        total: -500,
        income: 0,
        expense: -500,
        transactionCount: 1,
      },
      {
        categoryId: 1,
        categoryName: "Food",
        categoryPathIds: [],
        categoryPathSegments: [],
        total: -150,
        income: 0,
        expense: -150,
        transactionCount: 2,
      },
    ]);
  });

  it("reports explicit income/expense for a mixed-sign category-month", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([
      {
        period: "2025-04",
        category_id: 1,
        category_name: "Food",
        _leg: "income",
        cnt: 2,
        amount_eur: 500,
      },
      {
        period: "2025-04",
        category_id: 1,
        category_name: "Food",
        _leg: "expense",
        cnt: 2,
        amount_eur: -300,
      },
    ]);
    const r = await statisticsRepository.getCategoryPivot();
    // Net +200, but income (500) and expense (-300) are reported separately so
    // consumers don't have to misclassify by the sign of the net.
    expect(
      must(r.categoryPivot["2025-04"], 'r.categoryPivot["2025-04"]')[0],
    ).toEqual({
      categoryId: 1,
      categoryName: "Food",
      categoryPathIds: [],
      categoryPathSegments: [],
      total: 200,
      income: 500,
      expense: -300,
      transactionCount: 2,
    });
  });

  // Was: asserted to bind as [5, 7] — the pivot silently included the
  // categories the caller asked to exclude. See the note in filterBuilder.test.ts.
  it("rejects malformed exclusion lists instead of dropping the bad ids", async () => {
    await expect(
      statisticsRepository.getCategoryPivot({
        // @ts-expect-error -- malformed ids on purpose: the repository must reject them at runtime
        excludedCategoryIds: [0, -1, "evil", 1.5, 2147483647, 5],
        targetCurrency: "EUR",
        // @ts-expect-error -- malformed ids on purpose: the repository must reject them at runtime
        excludedRecipientIds: [null, undefined, 7],
      }),
    ).rejects.toThrow(/excludedCategoryIds contains invalid value/);

    expect(query).not.toHaveBeenCalled();
  });

  it("binds an exclusion id at the int4 ceiling instead of dropping it", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await statisticsRepository.getCategoryPivot({
      excludedCategoryIds: [2147483647, 5],
      targetCurrency: "EUR",
      excludedRecipientIds: [7],
    });
    expect(must(query.mock.calls[0], "query.mock.calls[0]")[1]).toEqual([
      2147483647, 5, 7,
    ]);
  });

  it("treats missing category_id as Uncategorised", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([
      {
        period: "2025-04",
        category_id: null,
        category_name: null,
        _leg: "income",
        cnt: 1,
        amount_eur: 0,
      },
      {
        period: "2025-04",
        category_id: null,
        category_name: null,
        _leg: "expense",
        cnt: 1,
        amount_eur: -10,
      },
    ]);
    const r = await statisticsRepository.getCategoryPivot();
    expect(
      must(r.categoryPivot["2025-04"], 'r.categoryPivot["2025-04"]')[0],
    ).toMatchObject({
      categoryId: null,
      categoryName: "Uncategorised",
    });
  });
});
