import { describe, expect, it } from "vitest";
import {
  compileVisualAnalysis,
  getAnalysisCatalog,
} from "../src/services/analysisCatalog.js";

describe("analysis catalog compiler", () => {
  it("compiles the no-AI monthly spending workflow with typed values", () => {
    const compiled = compileVisualAnalysis({
      datasetId: "cash-flows",
      fields: ["month", "category_general", "currency"],
      groups: ["month", "category_general", "currency"],
      measures: ["sum_spending"],
      filters: [
        { fieldId: "is_transfer", operator: "eq", value: false },
        { fieldId: "is_active", operator: "eq", value: true },
      ],
      joins: ["cash-flows.account"],
      orderBy: [{ id: "month", direction: "asc" }],
      limit: 500,
    });

    expect(compiled.sql).toContain("FROM vision_analysis.cash_flows_v2");
    expect(compiled.sql).toContain(
      "date_trunc('month', analysis_base.cash_flow_date)::date",
    );
    expect(compiled.sql).toContain("SUM(spending_amount)");
    expect(compiled.sql).toContain("GROUP BY");
    expect(compiled.values).toEqual([false, true]);
    expect(compiled.visualPlan.generatedSql).toBe(compiled.sql);
  });

  it("compiles a single total without emitting an empty GROUP BY clause", () => {
    const compiled = compileVisualAnalysis({
      datasetId: "transactions",
      fields: [],
      groups: [],
      measures: ["count"],
      filters: [],
      joins: [],
      limit: 500,
    });
    expect(compiled.sql).toBe(
      'SELECT COUNT(*) AS "count"\nFROM vision_analysis.transactions_v2',
    );
    expect(compiled.columns).toEqual([
      {
        id: "count",
        label: "Transaction count",
        type: "integer",
        nullable: false,
      },
    ]);
  });

  it("retains filters and measure ordering for ungrouped totals", () => {
    const compiled = compileVisualAnalysis({
      datasetId: "transactions",
      fields: [],
      groups: [],
      measures: ["count", "sum_amount"],
      filters: [
        { fieldId: "is_active", operator: "eq", value: true },
        { fieldId: "currency", operator: "eq", value: "EUR" },
      ],
      orderBy: [{ id: "sum_amount", direction: "desc" }],
    });
    expect(compiled.sql).not.toContain("GROUP BY");
    expect(compiled.sql).toContain(
      'WHERE is_active = $1 AND currency = $2\nORDER BY "sum_amount" DESC',
    );
    expect(compiled.values).toEqual([true, "EUR"]);
  });

  it.each([
    ["transactions", "sum_amount"],
    ["holdings", "sum_amount"],
    ["cash-flows", "sum_spending"],
    ["cash-flows", "sum_positive_flow"],
    ["cash-flows", "sum_amount"],
  ])("requires a common currency for %s %s", (datasetId, measure) => {
    const plan = { datasetId, fields: [], groups: [], measures: [measure] };
    expect(() => compileVisualAnalysis(plan)).toThrow("grouping by currency");
    const grouped = compileVisualAnalysis({
      ...plan,
      fields: ["currency"],
      groups: ["currency"],
    });
    expect(grouped.sql).toContain("GROUP BY currency");
    const filtered = compileVisualAnalysis({
      ...plan,
      filters: [{ fieldId: "currency", operator: "eq", value: "USD" }],
    });
    expect(filtered.values).toEqual(["USD"]);
  });

  it.each([
    { fieldId: "currency", operator: "neq", value: "EUR" },
    { fieldId: "currency", operator: "contains", value: "EUR" },
    { fieldId: "currency", operator: "is-not-null" },
    { fieldId: "currency", operator: "eq", value: ["EUR", "USD"] },
    { fieldId: "currency", operator: "eq", value: "EUR,USD" },
    { fieldId: "account_id", operator: "eq", value: 1 },
  ])("does not mistake filter %j for single-currency evidence", (filter) => {
    expect(() =>
      compileVisualAnalysis({
        datasetId: "transactions",
        fields: [],
        groups: [],
        measures: ["sum_amount"],
        filters: [filter],
      }),
    ).toThrow("grouping by currency");
  });

  it("labels holding event sums as raw totals rather than positions or net flows", () => {
    const compiled = compileVisualAnalysis({
      datasetId: "holdings",
      fields: ["currency"],
      groups: ["currency"],
      measures: ["sum_amount", "sum_units"],
      filters: [{ fieldId: "investment_id", operator: "eq", value: 42 }],
    });
    expect(compiled.columns.map(({ label }) => label)).toEqual([
      "Currency",
      "Raw event amount total",
      "Raw event units total",
    ]);
    expect(compiled.sql).toContain('SUM(units) AS "sum_units"');
    const holdings = getAnalysisCatalog().datasets.find(
      ({ id }) => id === "holdings",
    );
    expect(holdings.measures.map(({ label }) => label)).toEqual([
      "Event count",
      "Raw event amount total",
      "Raw event units total",
    ]);
  });

  it("does not combine unrelated investment units", () => {
    const plan = {
      datasetId: "holdings",
      fields: [],
      groups: [],
      measures: ["sum_units"],
    };
    expect(() => compileVisualAnalysis(plan)).toThrow(
      "grouping by investment_id",
    );
    const grouped = compileVisualAnalysis({
      ...plan,
      fields: ["investment_id"],
      groups: ["investment_id"],
    });
    expect(grouped.sql).toContain("GROUP BY investment_id");
    expect(() =>
      compileVisualAnalysis({
        ...plan,
        filters: [{ fieldId: "investment_id", operator: "neq", value: 42 }],
      }),
    ).toThrow("grouping by investment_id");
  });

  it("keeps the page limit out of SQL so the executor can detect additional rows", () => {
    const compiled = compileVisualAnalysis({
      datasetId: "transactions",
      fields: ["amount"],
      limit: 25,
    });
    expect(compiled.sql).not.toContain("LIMIT");
    expect(compiled.visualPlan.limit).toBe(25);
    expect(
      compileVisualAnalysis({
        datasetId: "transactions",
        fields: ["amount"],
        limit: 5000,
      }).visualPlan.limit,
    ).toBe(1000);
  });

  it("rejects unknown fields, outputs, and duplication-unsafe joins", () => {
    expect(() =>
      compileVisualAnalysis({
        datasetId: "cash-flows",
        fields: ["secret"],
        groups: [],
        measures: [],
      }),
    ).toThrow("Unsupported analysis field");
    expect(() =>
      compileVisualAnalysis({
        datasetId: "cash-flows",
        fields: ["month"],
        groups: [],
        measures: [],
        joins: ["raw.join"],
      }),
    ).toThrow("duplication-unsafe");
    expect(() =>
      compileVisualAnalysis({
        datasetId: "cash-flows",
        fields: ["month"],
        groups: [],
        measures: [],
        orderBy: [{ id: "secret" }],
      }),
    ).toThrow("Unsupported sort output");
  });

  it("publishes only explicit, safe many-to-one joins", () => {
    const catalog = getAnalysisCatalog();
    expect(
      catalog.datasets.find((dataset) => dataset.id === "cash-flows").joins,
    ).toEqual([
      expect.objectContaining({
        id: "cash-flows.account",
        cardinality: "many-to-one",
        duplicationSafe: true,
      }),
    ]);
  });

  it("compiles new analysis paths from the versioned hierarchy view", () => {
    const compiled = compileVisualAnalysis({
      datasetId: "transactions",
      fields: ["category_path", "category_path_segments", "category_path_ids"],
      groups: [],
      measures: [],
    });
    expect(compiled.sql).toContain("FROM vision_analysis.transactions_v2");
    expect(compiled.sql).toContain("category_path_segments");
    expect(compiled.columns.map((column) => column.type)).toEqual([
      "string",
      "string[]",
      "integer[]",
    ]);
  });
});
