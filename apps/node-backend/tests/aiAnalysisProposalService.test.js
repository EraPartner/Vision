import { describe, expect, it } from "vitest";
import { __buildDefinition } from "../src/services/savedAnalysisService.js";
import {
  __applyOperations,
  __querySpecFromDefinition,
} from "../src/services/aiAnalysisProposalService.js";

describe("AI analysis proposal boundary", () => {
  it("edits only the requested path without losing the existing scope", () => {
    const before = {
      name: "Spending",
      querySpec: {
        mode: "visual",
        plan: {
          datasetId: "cash-flows",
          fields: ["month", "category_general"],
          groups: ["month", "category_general"],
          measures: ["sum_spending"],
          filters: [{ fieldId: "is_transfer", operator: "eq", value: false }],
          joins: [],
          orderBy: [],
          limit: 500,
        },
      },
    };
    const after = __applyOperations(before, [
      {
        op: "add",
        path: "/querySpec/plan/filters/-",
        value: { fieldId: "category_general", operator: "neq", value: "Rent" },
      },
    ]);
    expect(after.querySpec.plan.datasetId).toBe("cash-flows");
    expect(after.querySpec.plan.filters).toHaveLength(2);
    expect(before.querySpec.plan.filters).toHaveLength(1);
  });

  it("round-trips a custom SQL visual origin into an editable plan", () => {
    const definition = __buildDefinition({
      definitionId: "analysis:proposal",
      version: 1,
      name: "Accounts",
      workspace: "budgeting",
      parameters: {},
      querySpec: {
        mode: "sql",
        sql: "SELECT account_name FROM vision_analysis.accounts_v1",
        datasetIds: ["accounts"],
        columns: [{ id: "account_name", type: "string", nullable: true }],
        visualOrigin: {
          datasetId: "accounts",
          fields: ["account_name"],
          groups: [],
          measures: [],
          filters: [],
          joins: [],
          orderBy: [],
          limit: 500,
        },
      },
    });
    expect(__querySpecFromDefinition(definition)).toMatchObject({
      mode: "sql",
      visualOrigin: { datasetId: "accounts", fields: ["account_name"] },
    });
  });

  it("rejects prototype and invalid array paths", () => {
    expect(() =>
      __applyOperations({ querySpec: { plan: { filters: [] } } }, [
        {
          op: "add",
          path: "/querySpec/__proto__/polluted",
          value: true,
        },
      ]),
    ).toThrow(/forbidden/);
    expect(() =>
      __applyOperations({ querySpec: { plan: { filters: [] } } }, [
        { op: "replace", path: "/querySpec/plan/filters/2", value: {} },
      ]),
    ).toThrow(/array index/);
  });
});
