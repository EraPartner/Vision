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

    expect(compiled.sql).toContain("FROM vision_analysis.cash_flows_v1");
    expect(compiled.sql).toContain(
      "date_trunc('month', analysis_base.cash_flow_date)::date",
    );
    expect(compiled.sql).toContain("SUM(spending_amount)");
    expect(compiled.sql).toContain("GROUP BY");
    expect(compiled.values).toEqual([false, true]);
    expect(compiled.visualPlan.generatedSql).toBe(compiled.sql);
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
});
