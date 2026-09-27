import { describe, expect, it } from "vitest";
import {
  compileVisualAnalysis,
  getAnalysisCatalog,
} from "../src/services/analysisCatalog.js";

describe("analysis catalog compiler", () => {
  it("compiles the no-AI monthly spending workflow with typed values", () => {
    const compiled = compileVisualAnalysis({
      datasetId: "cash-flows",
      fields: ["month", "category_general"],
      groups: ["month", "category_general"],
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
      'SELECT COUNT(*) AS "count"\nFROM vision_analysis.transactions_v2\nLIMIT 500',
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
      filters: [{ fieldId: "is_active", operator: "eq", value: true }],
      orderBy: [{ id: "sum_amount", direction: "desc" }],
    });
    expect(compiled.sql).not.toContain("GROUP BY");
    expect(compiled.sql).toContain(
      'WHERE is_active = $1\nORDER BY "sum_amount" DESC\nLIMIT 500',
    );
    expect(compiled.values).toEqual([true]);
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
