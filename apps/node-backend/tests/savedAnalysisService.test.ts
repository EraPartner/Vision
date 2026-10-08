import { describe, expect, it } from "vitest";
import {
  __buildDefinition as buildDefinition,
  __runtimeRequest as runtimeRequest,
  __resolveFormulaModel,
  __finalizeSavedAnalysisResult,
} from "../src/services/savedAnalysisService.ts";
import type { SavedAnalysis } from "../src/services/savedAnalysisService.ts";
import type {
  AnalysisFormulaModel,
  AnalysisResultLike,
} from "../src/services/analysisWorkbenchService.ts";
import type {
  AnalysisCustomSqlSource,
  AnalysisVisualPlanSource,
} from "@vision/types/analysis";
import { partial } from "./helpers/partial.ts";

/** The visual branch of runtimeRequest's result (the only one with `limit`). */
type VisualRuntimeRequest = Extract<
  ReturnType<typeof runtimeRequest>,
  { limit: unknown }
>;

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
            filters: [{ fieldId: "currency", operator: "eq", value: "EUR" }],
            joins: [],
            orderBy: [{ id: "month", direction: "desc" }],
            limit: 500,
          },
        },
      });
      const source = definition.source as AnalysisVisualPlanSource;
      const saved = partial<SavedAnalysis>({ definition, parameters: {} });
      expect(definition.workspace).toBe(workspace);
      expect(definition.definitionVersion).toBe(2);
      expect(source.generatedSql).toContain("SUM(spending_amount)");
      expect(source.orderBy).toEqual([
        { outputId: "month", direction: "desc" },
      ]);
      expect(runtimeRequest(saved).sql).toBe(source.generatedSql);
      expect(source.generatedSql).toMatch(/ORDER BY.*month.*DESC/);
      expect((runtimeRequest(saved) as VisualRuntimeRequest).limit).toBe(500);
      expect(source.generatedSql).not.toMatch(/LIMIT/i);
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
    const source = definition.source as AnalysisCustomSqlSource;
    expect(source.text).toBe(sql);
    expect(source.visualConversion.status).toBe("unsupported");
    expect(source.visualOrigin!.datasetId).toBe("accounts");
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
            { fieldId: "currency", operator: "eq", value: "EUR" },
          ],
          joins: ["cash-flows.account"],
          orderBy: [],
          limit: 500,
        },
      },
    });

    const source = definition.source as AnalysisVisualPlanSource;
    expect(source.select[0].source).toEqual({
      kind: "field",
      datasetId: "accounts",
      columnId: "display_name",
    });
    expect(source.filters[0].left).toEqual({
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
    // Formulas carry only an id: resolution never reads their bodies.
    const current = partial<AnalysisFormulaModel>({
      formulas: [{ id: "old" }],
      assumptions: [],
      assumptionValues: {},
    });
    expect(
      __resolveFormulaModel(
        partial<Parameters<typeof __resolveFormulaModel>[0]>({
          parameters: {
            formulaModel: {
              formulas: [{ id: "edited" }],
              assumptions: [{ id: "rate" }],
              assumptionValues: { rate: "0.03" },
            },
          },
        }),
        current,
      ),
    ).toEqual({
      formulas: [{ id: "edited" }],
      assumptions: [{ id: "rate" }],
      assumptionValues: { rate: "0.03" },
    });
  });

  it("joins typed scenario values before evaluating formulas", () => {
    const finalized = __finalizeSavedAnalysisResult(
      {
        rows: [{ plan: "A", actual_cost: "38" }],
        columns: [
          { id: "plan", type: "string" },
          { id: "actual_cost", type: "decimal" },
        ],
        window: { kind: "page", hasMore: false },
      },
      {
        scenarioModel: {
          attachments: [
            {
              id: "options",
              fileName: "options.csv",
              importedAt: "2026-09-14T10:00:00Z",
              sha256: "a".repeat(64),
              columns: [
                { id: "plan", label: "Plan", type: "string" },
                { id: "cost", label: "Cost", type: "decimal" },
              ],
              rows: [{ plan: "A", cost: "40.5" }],
            },
          ],
          joins: [
            { inputId: "options", resultColumn: "plan", inputColumn: "plan" },
          ],
        },
        formulaModel: {
          assumptions: [],
          assumptionValues: {},
          formulas: [
            {
              id: "difference",
              scope: "row",
              expression: "options.cost - actual_cost",
            },
          ],
        },
      },
    );

    expect(finalized.complete).toBe(true);
    expect(finalized.result.columns).toContainEqual(
      expect.objectContaining({
        id: "difference",
        type: "decimal",
        calculationId: "difference",
      }),
    );
    expect(finalized.result.rows[0]).toMatchObject({
      "options.cost": "40.5",
      difference: "2.5",
    });
  });

  it.each([
    { kind: "page", hasMore: true, offset: 0 },
    { kind: "page", hasMore: false, offset: 100 },
    { kind: "truncated", reason: "byte-limit" },
  ] as const)(
    "withholds whole-result formulas for an incomplete window %j",
    (window) => {
      const finalized = __finalizeSavedAnalysisResult(
        partial<AnalysisResultLike>({
          rows: [{ amount: "10" }, { amount: "20" }],
          window,
        }),
        {
          formulaModel: {
            formulas: [
              { id: "total", scope: "summary", expression: "SUM(amount)" },
              {
                id: "twice_total",
                scope: "summary",
                expression: "formula.total * 2",
              },
              { id: "local", scope: "row", expression: "amount * 2" },
              { id: "constant", scope: "summary", expression: "2 + 3" },
            ],
          },
        },
      );
      expect(finalized.complete).toBe(false);
      expect(finalized.result.formulaSummaries).toEqual({
        total: null,
        twice_total: null,
        constant: "5",
      });
      expect(finalized.result.rows.map((row) => row.local)).toEqual([
        "20",
        "40",
      ]);
      expect(
        finalized.result.formulaErrors.map((error) => error.formulaId),
      ).toEqual(["total", "twice_total"]);
    },
  );

  it("calculates summaries when the entire source result is available", () => {
    const finalized = __finalizeSavedAnalysisResult(
      partial<AnalysisResultLike>({
        rows: [{ amount: "10" }, { amount: "20" }],
        window: { kind: "page", hasMore: false, offset: 0 },
      }),
      {
        formulaModel: {
          formulas: [
            { id: "total", scope: "summary", expression: "SUM(amount)" },
          ],
        },
      },
    );
    expect(finalized.complete).toBe(true);
    expect(finalized.result.formulaSummaries.total).toBe("30");
    expect(finalized.result.formulaErrors).toEqual([]);
  });
});
