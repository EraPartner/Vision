import { describe, it, expect } from "vitest";
import {
  applyAnalysisWorkbench,
  applyAnalysisFormulaModel,
  applyAnalysisScenarioModel,
  evaluateAnalysisExtension as rawEvaluateAnalysisExtension,
} from "../src/services/analysisWorkbenchService.ts";
import type {
  AnalysisExtensionRequest,
  AnalysisFormulaModel,
  AnalysisResultCoverage,
  AnalysisResultLike,
  AnalysisResultWindow,
  AnalysisWorkbench,
} from "../src/services/analysisWorkbenchService.ts";
import type {
  AnalysisColumn,
  PreparationStep,
} from "../src/services/analysisExtensions.ts";
import type { AnalysisFormulaEvaluation } from "../src/services/analysisFormulaEngine.ts";
import {
  __buildDefinition as buildDefinition,
  __finalizeSavedAnalysisResult as finalize,
  __runtimeRequest as runtimeRequest,
} from "../src/services/savedAnalysisService.ts";
import { compileVisualAnalysis } from "../src/services/analysisCatalog.ts";
import { loose, partial } from "./helpers/partial.ts";

/** The dispatcher returns unknown; these tests read formula and time previews. */
type ExtensionPreview = AnalysisFormulaEvaluation & {
  columns: AnalysisColumn[];
  window: AnalysisResultWindow;
  coverage: AnalysisResultCoverage;
};
/**
 * AnalysisExtensionRequest intersects every operation's input, so it requires
 * fields (time's dateColumn and valueColumns) that other operations never send.
 */
const evaluateAnalysisExtension = (
  input: Partial<AnalysisExtensionRequest> & { operation: string },
) =>
  rawEvaluateAnalysisExtension(
    input as AnalysisExtensionRequest,
  ) as ExtensionPreview;

const raw = {
  rows: [{ amount: "10", currency: "EUR" }],
  columns: [
    {
      id: "amount",
      type: "decimal",
      unit: { kind: "money", currencyColumn: "currency" },
    },
    { id: "currency", type: "currency" },
  ],
  window: {
    kind: "page",
    offset: 0,
    hasMore: false,
    limit: 1000,
    returnedRows: 1,
  },
} satisfies AnalysisResultLike;
describe("analysis workbench integration", () => {
  it("withholds paged formula previews through the public dispatch shape", () => {
    const result = evaluateAnalysisExtension({
      operation: "formulas",
      rows: raw.rows,
      columns: raw.columns,
      complete: false,
      formulas: [
        { id: "total", scope: "summary", expression: "SUM(row.amount)" },
      ],
    });
    expect(result.summaries.total).toBeNull();
    expect(result.errors[0].code).toBe("INCOMPLETE_INPUT");
  });
  it("preparation refresh repeats against original source rather than appending twice", () => {
    const config: AnalysisWorkbench = {
      steps: [
        {
          type: "append",
          input: {
            columns: raw.columns,
            rows: [{ amount: "20", currency: "EUR" }],
          },
        },
      ],
    };
    const first = applyAnalysisWorkbench(raw, config),
      second = applyAnalysisWorkbench(first, config);
    expect(first.rows).toHaveLength(2);
    expect(second.rows).toHaveLength(2);
    expect(second.sourceResult!.rows).toEqual(raw.rows);
  });
  it("fresh and saved runs apply attachment columns before identical formulas", () => {
    const model = {
      attachments: [
        {
          id: "input1",
          fileName: "rates.csv",
          importedAt: "2026-09-30T00:00:00Z",
          sha256: "a".repeat(64),
          columns: [
            { id: "currency", label: "Currency", type: "string" },
            { id: "rate", label: "Rate", type: "decimal" },
          ],
          rows: [{ currency: "EUR", rate: "2" }],
        },
      ],
      joins: [
        {
          inputId: "input1",
          resultColumn: "currency",
          inputColumn: "currency",
        },
      ],
    };
    const source = {
      ...raw,
      columns: raw.columns.map((c) =>
        c.id === "currency" ? { ...c, type: "string" } : c,
      ),
    };
    const formulas: AnalysisFormulaModel = {
      formulas: [
        {
          id: "scaled",
          scope: "row",
          expression: "row.amount * row.input1.rate",
        },
      ],
    };
    const fresh = applyAnalysisFormulaModel(
      applyAnalysisWorkbench(applyAnalysisScenarioModel(source, model), {}),
      formulas,
    );
    const saved = finalize(source, {
      scenarioModel: model,
      formulaModel: formulas,
    }).result;
    expect(fresh.rows[0].scaled).toBe("20");
    expect(saved.rows).toEqual(fresh.rows);
    expect(saved.declaredColumns!.find((c) => c.id === "scaled")!.unit).toEqual(
      fresh.declaredColumns.find((c) => c.id === "scaled")!.unit,
    );
  });
  it("persists grouped native currency and instrument provenance in definitions", () => {
    const plan = {
      datasetId: "cash-flows",
      fields: ["currency"],
      groups: ["currency"],
      measures: ["sum_spending"],
      filters: [],
      joins: [],
      orderBy: [],
      limit: 500,
    };
    const definition = buildDefinition({
      definitionId: "analysis:units",
      version: 1,
      name: "Units",
      workspace: "budgeting",
      parameters: {},
      querySpec: { mode: "visual", plan },
    });
    expect(
      definition.expectedResult!.columns.find((c) => c.id === "sum_spending")!
        .unit,
    ).toEqual({ kind: "money", currencyColumn: "currency" });
  });
  it("saves service-backed definitions and keeps options separate from dataset identity", () => {
    const plan = {
      datasetId: "positions",
      fields: ["investment_id", "currency"],
      groups: [],
      measures: [],
      filters: [],
      joins: [],
      orderBy: [],
      limit: 500,
      reportingCurrency: "USD",
    };
    const definition = buildDefinition({
      definitionId: "analysis:positions",
      version: 1,
      name: "Positions",
      workspace: "portfolio",
      parameters: {},
      querySpec: { mode: "visual", plan },
    });
    const request = runtimeRequest(
      partial<Parameters<typeof runtimeRequest>[0]>({
        definition,
        parameters: {
          financialPlan: { reportingCurrency: "USD", datasetId: "fx-history" },
        },
      }),
    );
    expect(request.financialPlan!.datasetId).toBe("positions");
    expect(request.financialPlan!.reportingCurrency).toBe("USD");
  });
  it("raw money without a visible currency retains unresolved provenance", () => {
    const compiled = compileVisualAnalysis({
      datasetId: "transactions",
      fields: ["amount"],
      groups: [],
      measures: [],
      filters: [],
      joins: [],
      orderBy: [],
    });
    const result = evaluateAnalysisExtension({
      operation: "formulas",
      rows: [{ amount: "10" }, { amount: "20" }],
      columns: compiled.columns,
      complete: true,
      formulas: [
        { id: "total", scope: "summary", expression: "SUM(row.amount)" },
      ],
    });
    expect(result.summaries.total).toBeNull();
    expect(result.errors[0].code).toBe("CURRENCY_PROVENANCE_REQUIRED");
  });
  it("saved runs keep unavailable financial coverage partial even without formulas", () => {
    const result = finalize(
      // Financial datasets report unavailableRows; AnalysisResultCoverage omits it.
      loose<AnalysisResultLike>({
        ...raw,
        rows: [{ amount: null, currency: "EUR" }],
        coverage: { status: "partial", unavailableRows: 1 },
      }),
      {},
    );
    expect(result.complete).toBe(false);
    expect(result.result.coverage.status).toBe("partial");
  });
  it("guided formulas and scenarios see derived preparation columns", () => {
    const result = evaluateAnalysisExtension({
      operation: "formulas",
      rows: raw.rows,
      columns: raw.columns,
      complete: true,
      workbench: {
        steps: [
          {
            type: "calculate",
            formula: {
              id: "doubled",
              scope: "row",
              expression: "row.amount * 2",
            },
          },
        ],
      },
      formulas: [
        { id: "total", scope: "summary", expression: "SUM(row.doubled)" },
      ],
    });
    expect(result.summaries.total).toBe("20");
    expect(result.errors).toEqual([]);
  });
});

describe("workbench schema and coverage propagation", () => {
  it("formula dispatch returns transformed and formula columns with units", () => {
    const result = evaluateAnalysisExtension({
      operation: "formulas",
      rows: [{ date: "2024-01-01", amount: "10", currency: "EUR" }],
      columns: [{ id: "date", type: "date" }, ...raw.columns],
      complete: true,
      workbench: {
        time: { dateColumn: "date", valueColumns: ["amount"], missing: "zero" },
      },
      formulas: [{ id: "scaled", scope: "row", expression: "row.amount * 2" }],
    });
    expect(result.columns.map((column) => column.id)).toContain(
      "amount_cumulative",
    );
    expect(
      result.columns.find((column) => column.id === "scaled")!.unit,
    ).toEqual({ kind: "money", currency: "EUR" });
    expect(
      result.columns.find((column) => column.id === "amount")!.unit,
    ).toEqual({ kind: "money", currency: "EUR" });
    expect(result.rows[0].scaled).toBe("20");
    expect(result.window).toMatchObject({
      kind: "page",
      returnedRows: 1,
      hasMore: false,
    });
    expect(result.coverage).toMatchObject({
      complete: true,
      status: "complete",
    });
  });
  it("incomplete transformed values cannot be overridden by explicit preview completeness", () => {
    const source = {
      rows: [{ value: "10" }, { value: "invalid" }],
      columns: [{ id: "value", type: "string" }],
      window: { kind: "page", offset: 0, hasMore: false, returnedRows: 2 },
    };
    const workbench: AnalysisWorkbench = {
      steps: [
        {
          type: "convert",
          columnId: "value",
          targetType: "decimal",
          onError: "null",
        },
      ],
    };
    const formulas = [
      { id: "total", scope: "summary", expression: "SUM(value)" },
    ];
    const transformed = applyAnalysisWorkbench(source, workbench);
    expect(transformed.complete).toBe(false);
    expect(transformed.coverage).toMatchObject({
      complete: false,
      status: "partial",
    });
    expect(transformed.window.hasMore).toBe(false);
    const fresh = applyAnalysisFormulaModel(transformed, { formulas });
    expect(fresh.formulaSummaries.total).toBeNull();
    expect(fresh.formulaErrors[0].code).toBe("INCOMPLETE_INPUT");
    const preview = evaluateAnalysisExtension({
      operation: "formulas",
      rows: source.rows,
      columns: source.columns,
      complete: true,
      inputComplete: true,
      workbench,
      formulas,
    });
    expect(preview.complete).toBe(false);
    expect(preview.summaries.total).toBeNull();
    expect(preview.errors[0].code).toBe("INCOMPLETE_INPUT");
    expect(preview.columns.find((column) => column.id === "value")!.type).toBe(
      "decimal",
    );
    const saved = finalize(source, { workbench, formulaModel: { formulas } });
    expect(saved.complete).toBe(false);
    expect(saved.result.formulaSummaries.total).toBeNull();
    expect(saved.result.formulaErrors[0].code).toBe("INCOMPLETE_INPUT");
  });
  it("source financial coverage prevents population formulas and scenario calculations", () => {
    // Financial datasets report unavailableRows; AnalysisResultCoverage omits it.
    const source = {
      ...raw,
      coverage: {
        status: "partial",
        unavailableRows: 1,
      } as AnalysisResultCoverage,
    };
    const transformed = applyAnalysisWorkbench(source, {});
    expect(
      applyAnalysisFormulaModel(transformed, {
        formulas: [
          { id: "total", scope: "summary", expression: "SUM(amount)" },
        ],
      }).formulaErrors[0].code,
    ).toBe("INCOMPLETE_INPUT");
    expect(() =>
      evaluateAnalysisExtension({
        operation: "scenarios",
        ...source,
        complete: true,
        scenarios: [{ id: "base" }],
      }),
    ).toThrow("complete");
  });
});

it("prepares calendar previews once in the full-run order", () => {
  const source = { rows: [{ date: "2024-01-01", amount: "10" }], columns: [{ id: "date", type: "date" }, { id: "amount", type: "decimal", unit: { kind: "money", currency: "EUR" } }], window: { kind: "page", offset: 0, hasMore: false } };
  const steps: PreparationStep[] = [{ type: "calculate", formula: { id: "double", scope: "row", expression: "row.amount * 2" } }];
  const time = { dateColumn: "date", valueColumns: ["double"] };
  const full = applyAnalysisWorkbench(source, { steps, time });
  const preview = evaluateAnalysisExtension({ ...source, operation: "time", ...time, workbench: { steps, time } });
  expect(preview.rows).toEqual(full.rows);
  expect(preview.columns).toEqual(full.columns);
  expect(preview.rows[0].double).toBe("20");
});

it.each(["constructor", "toString", "__proto__"])(
  "rejects inherited object key %s as an extension operation",
  (operation) => {
    // "constructor" used to resolve to Object and echo the request back.
    expect(() =>
      evaluateAnalysisExtension({ operation, rows: [], columns: [] }),
    ).toThrow("Unsupported analysis operation");
  },
);
