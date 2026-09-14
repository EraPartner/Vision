import { describe, expect, it } from "vitest";
import {
  __buildDefinition as buildDefinition,
  __resolveFormulaModel,
} from "../src/services/savedAnalysisService.js";

describe("saved analysis definitions", () => {
  it("builds a strict, versioned visual definition for every workspace", () => {
    for (const workspace of [
      "budgeting",
      "portfolio",
      "research",
      "cross-workspace",
    ]) {
      const definition = buildDefinition({
        definitionId: `analysis:${workspace}`,
        version: 2,
        name: "Monthly spending",
        workspace,
        parameters: {
          currency: "EUR",
          timezone: "Europe/Helsinki",
          date_from: "2026-01-01",
          date_to: "2026-12-31",
        },
        querySpec: {
          mode: "visual",
          plan: {
            datasetId: "cash-flows",
            fields: ["month"],
            groups: ["month"],
            measures: ["sum_spending"],
            filters: [],
            joins: [],
            orderBy: [],
            limit: 500,
          },
        },
      });
      expect(definition.workspace).toBe(workspace);
      expect(definition.definitionVersion).toBe(2);
      expect(definition.source.generatedSql).toContain("SUM(spending_amount)");
    }
  });

  it("preserves custom SQL verbatim and marks visual conversion unsupported", () => {
    const sql =
      "SELECT account_name FROM vision_analysis.accounts_v1 ORDER BY account_name";
    const definition = buildDefinition({
      definitionId: "analysis:sql",
      version: 1,
      name: "Accounts",
      workspace: "budgeting",
      parameters: {},
      querySpec: {
        mode: "sql",
        sql,
        datasetIds: ["accounts"],
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
        columns: [
          {
            id: "account_name",
            label: "Account",
            type: "string",
            nullable: true,
          },
        ],
      },
    });
    expect(definition.source.text).toBe(sql);
    expect(definition.source.visualConversion.status).toBe("unsupported");
    expect(definition.source.visualOrigin.datasetId).toBe("accounts");
  });

  it("records joined account fields against the accounts dataset", () => {
    const definition = buildDefinition({
      definitionId: "analysis:joined-account",
      version: 1,
      name: "Spending by account",
      workspace: "budgeting",
      parameters: {},
      querySpec: {
        mode: "visual",
        plan: {
          datasetId: "cash-flows",
          fields: ["account.display_name"],
          groups: ["account.display_name"],
          measures: ["sum_spending"],
          filters: [
            {
              fieldId: "account.display_name",
              operator: "contains",
              value: "Current",
            },
          ],
          joins: ["cash-flows.account"],
          orderBy: [],
          limit: 500,
        },
      },
    });

    expect(definition.source.select[0].source).toEqual({
      kind: "field",
      datasetId: "accounts",
      columnId: "display_name",
    });
    expect(definition.source.filters[0].left).toEqual({
      kind: "field",
      datasetId: "accounts",
      columnId: "display_name",
    });
    expect(definition.datasets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cash-flows", requiredColumns: [] }),
        expect.objectContaining({ id: "accounts", requiredColumns: [] }),
      ]),
    );
  });

  it("persists typed formulas and isolated assumptions in the shared definition", () => {
    const definition = buildDefinition({
      definitionId: "analysis:formula",
      version: 1,
      name: "Scenario",
      workspace: "budgeting",
      parameters: {},
      querySpec: {
        mode: "sql",
        sql: "SELECT amount FROM vision_analysis.cash_flows_v1",
        datasetIds: ["cash-flows"],
        columns: [
          { id: "amount", label: "Amount", type: "decimal", nullable: false },
        ],
      },
      assumptions: [
        {
          id: "growth",
          label: "Growth",
          type: "decimal",
          defaultValue: "0.02",
          editable: true,
          source: "user",
        },
      ],
      formulas: [
        {
          id: "adjusted",
          label: "Adjusted",
          scope: "row",
          expression: "row.amount * (1 + assumption.growth)",
          resultType: "decimal",
          dependencies: [],
        },
      ],
    });
    expect(definition.assumptions[0].id).toBe("growth");
    expect(definition.calculations.at(-1)).toMatchObject({
      id: "adjusted",
      kind: "formula",
      languageVersion: "vision-formula-v1",
    });
    expect(definition.expectedResult.columns.at(-1)).toMatchObject({
      id: "adjusted",
      calculationVersion: "vision-formula-v1",
    });
  });

  it("keeps formula edits carried inside an inspected proposal", () => {
    const current = {
      formulas: [{ id: "old" }],
      assumptions: [],
      assumptionValues: {},
    };
    expect(
      __resolveFormulaModel(
        {
          parameters: {
            formulaModel: {
              formulas: [{ id: "edited" }],
              assumptions: [{ id: "rate" }],
              assumptionValues: { rate: "0.03" },
            },
          },
        },
        current,
      ),
    ).toEqual({
      formulas: [{ id: "edited" }],
      assumptions: [{ id: "rate" }],
      assumptionValues: { rate: "0.03" },
    });
  });
});
