import { describe, it, expect } from "vitest";
import { __validateAnalysisSql } from "../src/services/analysisExecutor.ts";
import { executeAnalysisPivot } from "../src/services/analysisPivotService.ts";

const plan = {
  datasetId: "cash-flows",
  fields: ["month", "category_general", "currency"],
  groups: ["month", "category_general", "currency"],
  measures: ["sum_spending"],
  filters: [],
  joins: [],
  orderBy: [],
  limit: 1,
};
describe("complete-source pivots", () => {
  it("compiles totals and hierarchy against original population with currency partitions", async () => {
    const queries = [];
    const result = await executeAnalysisPivot(
      {
        plan,
        requestId: "pivot-test",
        config: {
          rows: ["category_general"],
          columns: ["month"],
          values: ["sum_spending", "sum_amount"],
        },
      },
      {
        execute: async (request) => {
          queries.push(request);
          return {
            rows: [0, 1].flatMap((r) =>
              [0, 1].map((c) => ({
                __row_depth: r,
                __column_depth: c,
                currency: "EUR",
                sum_spending: r ? "25" : "100",
                sum_amount: r ? "-25" : "-100",
              })),
            ),
            window: { kind: "page", offset: 0, hasMore: false },
          };
        },
      },
    );
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("UNION ALL");
    expect(queries[0].sql).toContain('NULL::date AS "month"');
    expect(queries[0].sql).toContain('NULL::text AS "category_general"');
    expect(() =>
      __validateAnalysisSql(queries[0].sql, queries[0].datasetIds),
    ).not.toThrow();
    expect(
      queries.every(
        (q) =>
          q.sql.includes("FROM vision_analysis.cash_flows_v2") &&
          !q.sql.includes("LIMIT"),
      ),
    ).toBe(true);
    expect(
      queries.every(
        (q) =>
          q.sql.includes("GROUP BY currency") || q.sql.includes(", currency"),
      ),
    ).toBe(true);
    expect(result.levels[3].rows[0].__percentages.sum_spending).toBe("0.25");
    expect(result.levels[0].rowDepth).toBe(0);
    expect(result.coverage.complete).toBe(true);
  });
  it.each([
    ["120", true],
    [null, false],
  ])(
    "uses closing history totals and inherits unavailable coverage (%s)",
    async (closing, complete) => {
      const result = await executeAnalysisPivot(
        {
          plan: { datasetId: "portfolio-history", filters: [], joins: [] },
          requestId: "pivot-history",
          config: { rows: ["date"], columns: [], values: ["sum_value"] },
        },
        {
          financialDeps: {
            query: async () => ({
              rows: [
                { date: "2026-01-01", currency: "EUR", value: "100" },
                { date: "2026-01-02", currency: "EUR", value: closing },
              ],
            }),
          },
        },
      );
      expect(result.levels[0].rows[0].sum_value).toBe(closing);
      expect(result.levels[1].rows.map((row) => row.sum_value)).toEqual([
        "100",
        closing,
      ]);
      expect(result.coverage).toMatchObject({
        complete,
        financialComplete: complete,
        unavailableRows: complete ? 0 : 1,
      });
    },
  );
  it("rejects partial grouped output instead of giving misleading totals", async () => {
    await expect(
      executeAnalysisPivot(
        {
          plan,
          requestId: "pivot-test",
          config: { rows: [], columns: [], values: ["sum_spending"] },
        },
        {
          execute: async () => ({
            rows: [],
            window: { kind: "page", offset: 0, hasMore: true },
          }),
        },
      ),
    ).rejects.toThrow("complete-output");
  });
  it("keeps investment identity in every units subtotal", async () => {
    const queries = [];
    await executeAnalysisPivot(
      {
        plan: { ...plan, datasetId: "holdings" },
        requestId: "pivot-units",
        config: { rows: ["month"], columns: [], values: ["sum_units"] },
      },
      {
        execute: async (request) => {
          queries.push(request.sql);
          return {
            rows: [],
            window: { kind: "page", offset: 0, hasMore: false },
          };
        },
      },
    );
    expect(queries.every((sql) => sql.includes("investment_id"))).toBe(true);
  });
});
