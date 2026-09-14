import { describe, expect, it, vi } from "vitest";
import {
  executeCloudAnalysisPlan,
  getPublicCloudAnalysisCatalog,
  parseCloudAnalysisPlans,
} from "../src/services/cloudAnalysisPlan.js";

const spendingPlan = {
  schemaVersion: 1,
  catalogVersion: 1,
  datasetId: "cash-flows",
  fields: ["month", "category_general"],
  filters: [
    { fieldId: "is_transfer", operator: "eq", value: false },
    { fieldId: "is_active", operator: "eq", value: true },
  ],
  groups: ["month", "category_general"],
  measures: ["sum_spending"],
  joins: [],
  orderBy: [{ id: "month", direction: "asc" }],
  limit: 100,
  formulas: [],
};

describe("cloud-authored analysis plans", () => {
  it("publishes identifiers and types without SQL relations", () => {
    const catalog = getPublicCloudAnalysisCatalog();
    const serialized = JSON.stringify(catalog);
    expect(catalog.datasets.map(({ id }) => id)).toContain("cash-flows");
    expect(serialized).not.toContain("vision_analysis");
    expect(serialized).not.toContain("SELECT");
  });

  it("accepts only strict catalog plans inside the trusted workspace", () => {
    const text = JSON.stringify({ analysisPlans: [spendingPlan] });
    expect(
      parseCloudAnalysisPlans(text, { workspaces: ["budgeting"] }),
    ).toEqual([spendingPlan]);
    expect(() =>
      parseCloudAnalysisPlans(
        JSON.stringify({
          analysisPlans: [
            { ...spendingPlan, sql: "SELECT * FROM public.transactions" },
          ],
        }),
        { workspaces: ["budgeting"] },
      ),
    ).toThrow();
    expect(() =>
      parseCloudAnalysisPlans(
        JSON.stringify({
          analysisPlans: [{ ...spendingPlan, datasetId: "holdings" }],
        }),
        { workspaces: ["budgeting"] },
      ),
    ).toThrow(/workspace scope/);
  });

  it("intersects private scope locally and never returns it to a provider", async () => {
    const execute = vi.fn().mockResolvedValue({
      requestId: "cloud-plan-test",
      rows: [
        { month: "2026-09-01", category_general: "Food", sum_spending: "100" },
      ],
      columns: [],
      window: {
        kind: "page",
        offset: 0,
        limit: 100,
        hasMore: false,
        returnedRows: 1,
      },
    });
    const result = await executeCloudAnalysisPlan(
      spendingPlan,
      {
        workspaces: ["budgeting"],
        accountIds: [41, 42],
        investmentIds: [],
        dateFrom: "2026-01-01",
        dateTo: "2026-06-30",
      },
      { execute, requestId: "cloud-plan-test" },
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [false, true, 41, 42, "2026-01-01", "2026-06-30"],
        sql: expect.stringMatching(
          /account_id IN \(\$3, \$4\).*cash_flow_date >= \$5.*cash_flow_date <= \$6/s,
        ),
      }),
    );
    expect(result.rows[0].sum_spending).toBe("100");
  });

  it("rechecks workspace authority at the local execution boundary", async () => {
    await expect(
      executeCloudAnalysisPlan(
        { ...spendingPlan, datasetId: "holdings", fields: ["investment_id"] },
        { workspaces: ["budgeting"] },
        { execute: vi.fn() },
      ),
    ).rejects.toThrow(/workspace scope/);
  });

  it.each([
    { ...spendingPlan, datasetId: "unknown" },
    { ...spendingPlan, fields: ["secret_column"] },
    { ...spendingPlan, measures: ["pg_read_file"] },
    { ...spendingPlan, resultCallback: "https://attacker.invalid" },
  ])("rejects malformed or privilege-expanding plans", (candidate) => {
    expect(() =>
      parseCloudAnalysisPlans(JSON.stringify({ analysisPlans: [candidate] }), {
        workspaces: ["cross-workspace"],
      }),
    ).toThrow();
  });
});
