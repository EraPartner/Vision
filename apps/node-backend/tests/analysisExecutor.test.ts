import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import pg from "pg";
import { compileVisualAnalysis } from "../src/services/analysisCatalog.ts";
import {
  __validateAnalysisSql,
  executeAnalysisSql,
} from "../src/services/analysisExecutor.ts";
import { loose } from "./helpers/partial.ts";

/**
 * spyOn types pg's overloaded connect by its callback form; the executor
 * awaits the promise form.
 */
const spyOnConnect = () =>
  vi.spyOn(pg.Pool.prototype, "connect") as unknown as MockInstance<
    () => Promise<pg.PoolClient>
  >;

describe("analysis result dates", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves calendar dates while retaining timestamp and numeric parsers", async () => {
    const defaultDateParser = pg.types.getTypeParser(1082, "text");
    const parserSpy = vi.spyOn(pg.types, "getTypeParser");
    const release = vi.fn();
    const fields = [
      { name: "month", dataTypeID: 1082 },
      { name: "recorded_at", dataTypeID: 1184 },
      { name: "amount", dataTypeID: 1700 },
    ];
    const query = vi.fn(async (config) => {
      if (typeof config === "string") return { rows: [{ pid: 123 }] };
      const raw = ["2026-04-01", "2026-04-01 00:00:00+03", "123.45"];
      return {
        fields,
        rows: [
          Object.fromEntries(
            fields.map((field, index) => [
              field.name,
              config.types.getTypeParser(field.dataTypeID, "text")(raw[index]),
            ]),
          ),
        ],
      };
    });
    // executeAnalysisSql only calls query and release on the client.
    spyOnConnect().mockResolvedValue(loose<pg.PoolClient>({ query, release }));

    const result = await executeAnalysisSql({
      requestId: "date-regression",
      sql: "SELECT * FROM vision_analysis.transactions_v1",
      datasetIds: ["transactions"],
    });

    expect(result.rows).toEqual([
      {
        month: "2026-04-01",
        recorded_at: "2026-03-31T21:00:00.000Z",
        amount: "123.45",
      },
    ]);
    expect(result.columns.map((column) => column.type)).toEqual([
      "date",
      "datetime",
      "decimal",
    ]);
    expect(parserSpy).not.toHaveBeenCalledWith(1082, "text");
    expect(parserSpy).toHaveBeenCalledWith(1184, "text");
    expect(parserSpy).toHaveBeenCalledWith(1700, "text");
    const config = query.mock.calls.find(
      ([value]) => typeof value === "object",
    )![0];
    expect(config.types.getTypeParser(1082, "binary")).toBe(
      pg.types.getTypeParser(1082, "binary"),
    );
    expect(pg.types.getTypeParser(1082, "text")).toBe(defaultDateParser);
    expect(release).toHaveBeenCalledWith(undefined);
  });
});

describe("visual analysis pagination", () => {
  afterEach(() => vi.restoreAllMocks());

  it("detects additional groups and retrieves the next page without an inner result limit", async () => {
    const compiled = compileVisualAnalysis({
      datasetId: "transactions",
      fields: ["month"],
      groups: ["month"],
      measures: ["sum_amount"],
      filters: [{ fieldId: "currency", operator: "eq", value: "EUR" }],
      orderBy: [{ id: "month", direction: "asc" }],
      limit: 2,
    });
    const allRows = [
      { month: "2026-01-01", sum_amount: "10" },
      { month: "2026-02-01", sum_amount: "20" },
      { month: "2026-03-01", sum_amount: "30" },
      { month: "2026-04-01", sum_amount: "40" },
    ];
    const query = vi.fn(async (config) => {
      if (typeof config === "string") return { rows: [{ pid: 123 }] };
      // Simulate PostgreSQL applying the executor's outer pagination only.
      expect(config.text).toBe(
        `SELECT * FROM (${compiled.sql}) AS vision_analysis_result LIMIT $2 OFFSET $3`,
      );
      expect(compiled.sql).not.toMatch(/\bLIMIT\b/i);
      expect(config.values[0]).toBe("EUR");
      const [, fetchLimit, offset] = config.values;
      return {
        fields: [
          { name: "month", dataTypeID: 1082 },
          { name: "sum_amount", dataTypeID: 1700 },
        ],
        rows: allRows.slice(offset, offset + fetchLimit),
      };
    });
    const release = vi.fn();
    // executeAnalysisSql only calls query and release on the client.
    spyOnConnect().mockResolvedValue(loose<pg.PoolClient>({ query, release }));
    const request = {
      sql: compiled.sql,
      values: compiled.values,
      datasetIds: compiled.datasetIds,
      limit: compiled.visualPlan.limit,
    };

    const first = await executeAnalysisSql({
      ...request,
      requestId: "first-page",
      offset: 0,
    });
    expect(first.rows).toEqual(allRows.slice(0, 2));
    expect(first.window).toMatchObject({
      kind: "page",
      offset: 0,
      limit: 2,
      hasMore: true,
    });

    const second = await executeAnalysisSql({
      ...request,
      requestId: "second-page",
      offset: 2,
    });
    expect(second.rows).toEqual(allRows.slice(2));
    expect(second.window).toMatchObject({
      kind: "page",
      offset: 2,
      limit: 2,
      hasMore: false,
    });

    const exact = await executeAnalysisSql({
      ...request,
      requestId: "exact-page",
      limit: 4,
      offset: 0,
    });
    expect(exact.rows).toEqual(allRows);
    expect(exact.window).toMatchObject({
      kind: "page",
      offset: 0,
      limit: 4,
      hasMore: false,
    });
    expect(
      query.mock.calls
        .filter(([config]) => typeof config === "object")
        .map(([config]) => config.values),
    ).toEqual([
      ["EUR", 3, 0],
      ["EUR", 3, 2],
      ["EUR", 5, 0],
    ]);
    expect(release).toHaveBeenCalledTimes(3);
  });
});

describe("analysis SQL boundary", () => {
  it("accepts declared approved datasets, CTEs, joins, aggregates, and windows", () => {
    const sql = `WITH monthly AS (
      SELECT account_id, SUM(spending_amount) AS spend
      FROM vision_analysis.cash_flows_v1 GROUP BY account_id
    )
    SELECT a.account_name, m.spend, rank() OVER (ORDER BY m.spend DESC)
    FROM monthly m JOIN vision_analysis.accounts_v1 a ON a.account_id = m.account_id`;
    expect(__validateAnalysisSql(sql, ["cash-flows", "accounts"])).toContain(
      "rank()",
    );
  });

  it.each([
    "UPDATE vision_analysis.cash_flows_v1 SET signed_amount=0",
    "SELECT * FROM public.transactions",
    "SELECT pg_read_file('/etc/passwd') FROM vision_analysis.accounts_v1",
    "SELECT pg_sleep(1) FROM vision_analysis.accounts_v1",
    "SELECT * FROM vision_analysis.accounts_v1; SELECT 1",
    "COPY vision_analysis.accounts_v1 TO PROGRAM 'false'",
    'SELECT * FROM "public"."transactions"',
  ])("rejects unsafe SQL: %s", (sql) => {
    expect(() => __validateAnalysisSql(sql, ["accounts"])).toThrow();
  });

  it("rejects an inherited object key as a dataset id", () => {
    expect(() =>
      __validateAnalysisSql("SELECT * FROM vision_analysis.accounts_v1", [
        "constructor",
      ]),
    ).toThrow("Dataset is not approved: constructor");
  });

  it("rejects approved but undeclared datasets", () => {
    expect(() =>
      __validateAnalysisSql("SELECT * FROM vision_analysis.transactions_v1", [
        "accounts",
      ]),
    ).toThrow("not declared");
    expect(() =>
      __validateAnalysisSql(
        'SELECT * FROM "vision_analysis"."transactions_v1"',
        ["accounts"],
      ),
    ).toThrow("not declared");
  });

  it("requires a non-empty set of known dataset declarations", () => {
    expect(() => __validateAnalysisSql("SELECT 1", [])).toThrow(
      "must be declared",
    );
    expect(() => __validateAnalysisSql("SELECT 1", ["unknown"])).toThrow(
      "not approved",
    );
  });

  it("permits v2 hierarchy analysis while retaining saved v1 SQL", () => {
    expect(
      __validateAnalysisSql(
        "SELECT category_path FROM vision_analysis.transactions_v2",
        ["transactions"],
      ),
    ).toContain("category_path");
    expect(
      __validateAnalysisSql(
        "SELECT category_general FROM vision_analysis.transactions_v1",
        ["transactions"],
      ),
    ).toContain("category_general");
  });
});
