import {
  applyScenarioInputs,
  validateScenarioBindings,
} from "./analysisScenarioInputs.ts";
import {
  prepareAnalysisData,
  compareAnalysisTime,
  runAnalysisScenarios,
  buildAnalysisSensitivity,
  seekAnalysisGoal,
} from "./analysisExtensions.ts";
import type {
  AnalysisColumn,
  AnalysisExtensionCoverage,
  AnalysisExtensionError,
  AnalysisLineageEntry,
  BuildAnalysisSensitivityInput,
  CompareAnalysisTimeInput,
  PrepareAnalysisDataInput,
  PreparationStep,
  RunAnalysisScenariosInput,
  SeekAnalysisGoalInput,
} from "./analysisExtensions.ts";
import { evaluateAnalysisFormulas } from "./analysisFormulaEngine.ts";
import type { AnalysisAssumption } from "@vision/types/analysis";
import type {
  AnalysisFormulaEvaluation,
  AnalysisFormulaInput,
  EvaluateAnalysisFormulasInput,
  FormulaRow,
  FormulaUnitInput,
} from "./analysisFormulaEngine.ts";

export interface AnalysisResultWindow {
  kind?: string;
  offset?: number;
  limit?: number;
  hasMore?: boolean;
  returnedRows?: number;
  totalRows?: number;
}

export interface AnalysisResultCoverage {
  complete?: boolean;
  status?: string;
  unavailableRows?: number;
}

/** The result shape shared by SQL, financial and workbench analysis runs. */
export interface AnalysisResultLike {
  rows: FormulaRow[];
  columns: AnalysisColumn[];
  declaredColumns?: AnalysisColumn[] | undefined;
  window?: AnalysisResultWindow | undefined;
  coverage?: AnalysisResultCoverage | undefined;
  complete?: boolean | undefined;
  transformationErrors?: AnalysisExtensionError[] | undefined;
  transformationCoverage?: Array<{ complete?: boolean }> | undefined;
  preparationLineage?: AnalysisLineageEntry[] | undefined;
  sourceResult?: AnalysisResultLike | undefined;
  generatedSql?: string | undefined;
}

export interface AnalysisWorkbench {
  steps?: PreparationStep[];
  time?:
    Omit<CompareAnalysisTimeInput, "rows" | "columns" | "complete"> | undefined;
}

export interface AnalysisFormulaModel {
  formulas?: AnalysisFormulaInput[] | undefined;
  assumptions?: AnalysisAssumption[] | undefined;
  assumptionValues?: Record<string, unknown> | undefined;
}

export interface AnalysisScenarioModelInput {
  attachments?: unknown[] | undefined;
  joins?: unknown[] | undefined;
}

export type AnalysisExtensionRequest = PrepareAnalysisDataInput &
  CompareAnalysisTimeInput &
  RunAnalysisScenariosInput &
  BuildAnalysisSensitivityInput &
  SeekAnalysisGoalInput &
  EvaluateAnalysisFormulasInput & {
    operation: string;
    columns?: AnalysisColumn[] | undefined;
    window?: AnalysisResultWindow | undefined;
    coverage?: AnalysisResultCoverage | undefined;
    workbench?: AnalysisWorkbench | undefined;
    inputComplete?: boolean | undefined;
  };

/** Population completeness includes value coverage, not merely pagination. */
export function isCompleteAnalysisResult(result: AnalysisResultLike) {
  return (
    result.complete !== false &&
    result.window?.kind === "page" &&
    !result.window.hasMore &&
    (result.window.offset ?? 0) === 0 &&
    result.coverage?.complete !== false &&
    result.coverage?.status !== "partial" &&
    (result.transformationErrors ?? []).length === 0 &&
    (result.transformationCoverage ?? []).every(
      (coverage) => coverage.complete !== false,
    )
  );
}
function formulaOutputColumns(
  columns: AnalysisColumn[],
  formulas: AnalysisFormulaInput[],
  evaluated: AnalysisFormulaEvaluation,
): AnalysisColumn[] {
  const additions = formulas
    .filter((formula) => formula.scope === "row")
    .map((formula) => ({
      id: formula.id,
      label: formula.label || formula.id,
      type: formula.resultType || "decimal",
      nullable: true,
      ...(evaluated.formulaUnits?.[formula.id] || formula.unit
        ? { unit: evaluated.formulaUnits?.[formula.id] ?? formula.unit }
        : {}),
    }));
  const ids = new Set(additions.map((column) => column.id));
  return [...columns.filter((column) => !ids.has(column.id)), ...additions];
}
export function evaluateAnalysisExtension(input: AnalysisExtensionRequest) {
  const functions: Record<
    string,
    ((request: AnalysisExtensionRequest) => unknown) | undefined
  > = {
    prepare: prepareAnalysisData,
    time: compareAnalysisTime,
    scenarios: runAnalysisScenarios,
    sensitivity: buildAnalysisSensitivity,
    goal: seekAnalysisGoal,
    formulas: evaluateAnalysisFormulas,
  };
  const operation = input?.operation;
  const fn =
    typeof operation === "string" && Object.hasOwn(functions, operation)
      ? functions[operation]
      : undefined;
  if (!fn) throw new Error("Unsupported analysis operation");
  let request = input;
  let prepared: AnalysisResultLike = {
    rows: input.rows,
    columns: input.columns ?? [],
    window: input.window ?? {
      kind: "page",
      offset: 0,
      hasMore: input.complete === false,
      returnedRows: input.rows?.length ?? 0,
    },
    coverage: input.coverage,
    complete: input.complete,
  };
  if (
    ["time", "formulas", "scenarios", "sensitivity", "goal"].includes(
      input.operation,
    )
  ) {
    if (input.workbench)
      prepared = applyAnalysisWorkbench(
        prepared,
        input.operation === "time"
          ? { ...input.workbench, time: undefined }
          : input.workbench,
      );
    request = {
      ...input,
      rows: prepared.rows,
      columns: prepared.columns,
      complete:
        isCompleteAnalysisResult(prepared) && input.inputComplete !== false,
    };
  }
  if (request.operation !== "formulas") return fn(request);
  const evaluated = evaluateAnalysisFormulas({
    ...request,
    inputComplete: request.complete,
  });
  const columns = formulaOutputColumns(
    // Formula requests were rebuilt above with the prepared columns.
    request.columns!,
    request.formulas ?? [],
    evaluated,
  );
  return {
    ...evaluated,
    complete: request.complete && evaluated.complete,
    columns,
    declaredColumns: columns,
    window: { ...prepared.window, returnedRows: evaluated.rows.length },
    coverage: {
      ...prepared.coverage,
      complete: request.complete && evaluated.complete,
      status: request.complete && evaluated.complete ? "complete" : "partial",
    },
    transformationCoverage: prepared.transformationCoverage ?? [],
    transformationErrors: prepared.transformationErrors ?? [],
    preparationLineage: prepared.preparationLineage ?? [],
  };
}

/** The same repeatable pipeline is used for fresh and saved runs. */
export function applyAnalysisWorkbench(
  result: AnalysisResultLike,
  workbench: AnalysisWorkbench = {},
) {
  const source = result.sourceResult ?? result;
  let rows = source.rows;
  let columns = source.declaredColumns && source.declaredColumns.length > 0
    ? source.declaredColumns
    : source.columns;
  let complete = isCompleteAnalysisResult(source);
  const lineage: AnalysisLineageEntry[] = [];
  const coverage: AnalysisExtensionCoverage[] = [];
  const errors: AnalysisExtensionError[] = [];
  if (workbench.steps && workbench.steps.length > 0) {
    const prepared = prepareAnalysisData({
      rows,
      columns,
      complete,
      steps: workbench.steps,
    });
    rows = prepared.rows;
    columns = prepared.columns;
    lineage.push(...prepared.lineage);
    coverage.push(prepared.coverage);
    errors.push(...prepared.errors);
    complete =
      complete &&
      prepared.coverage.complete !== false &&
      prepared.errors.length === 0;
  }
  if (workbench.time?.dateColumn && workbench.time.valueColumns?.length > 0) {
    const compared = compareAnalysisTime({
      rows,
      columns,
      complete,
      ...workbench.time,
    });
    rows = compared.rows;
    columns = compared.columns;
    lineage.push(...compared.lineage);
    coverage.push(compared.coverage);
    errors.push(...compared.errors);
    complete =
      complete &&
      compared.coverage.complete !== false &&
      compared.errors.length === 0;
  }
  return {
    ...source,
    ...((workbench.steps && workbench.steps.length > 0) || workbench.time?.dateColumn
      ? { sourceResult: source }
      : {}),
    rows,
    columns,
    declaredColumns: columns,
    window: { ...source.window, returnedRows: rows.length },
    complete,
    coverage: {
      ...source.coverage,
      complete,
      status: complete ? "complete" : "partial",
    },
    byteLength: Buffer.byteLength(JSON.stringify(rows)),
    transformationErrors: errors,
    preparationLineage: lineage,
    transformationCoverage: coverage,
  };
}

export function applyAnalysisFormulaModel(
  result: AnalysisResultLike,
  model: AnalysisFormulaModel = {},
) {
  const assumptions = Object.fromEntries(
    (model.assumptions ?? []).map((item): [string, unknown] => [
      item.id,
      model.assumptionValues?.[item.id] ?? item.defaultValue,
    ]),
  );
  const columns = result.declaredColumns && result.declaredColumns.length > 0
    ? result.declaredColumns
    : result.columns;
  const evaluated = evaluateAnalysisFormulas({
    rows: result.rows,
    columns,
    formulas: model.formulas ?? [],
    assumptions,
    assumptionUnits: Object.fromEntries(
      (model.assumptions ?? [])
        .filter((item) => item.unit)
        .map((item): [string, FormulaUnitInput] => [item.id, item.unit]),
    ),
    inputComplete: isCompleteAnalysisResult(result),
  });
  const formulaColumns = (model.formulas ?? [])
    .filter((f) => f.scope === "row")
    .map((f) => ({
      id: f.id,
      label: f.label || f.id,
      type: f.resultType || "decimal",
      nullable: true,
      ...(evaluated.formulaUnits?.[f.id]
        ? { unit: evaluated.formulaUnits[f.id] }
        : {}),
    }));
  const ids = new Set(formulaColumns.map((c) => c.id));
  return {
    ...result,
    ...((model.formulas ?? []).length > 0
      ? { sourceResult: result.sourceResult ?? result }
      : {}),
    rows: evaluated.rows,
    complete: isCompleteAnalysisResult(result) && evaluated.complete,
    coverage: {
      ...result.coverage,
      complete: isCompleteAnalysisResult(result) && evaluated.complete,
      status:
        isCompleteAnalysisResult(result) && evaluated.complete
          ? "complete"
          : "partial",
    },
    columns: [...columns.filter((c) => !ids.has(c.id)), ...formulaColumns],
    declaredColumns: [
      ...columns.filter((c) => !ids.has(c.id)),
      ...formulaColumns,
    ],
    formulaSummaries: evaluated.summaries,
    formulaErrors: evaluated.errors,
    formulaLanguageVersion: evaluated.languageVersion,
  };
}

export function applyAnalysisScenarioModel(
  result: AnalysisResultLike,
  model: AnalysisScenarioModelInput | null | undefined,
) {
  if ((model?.joins?.length ?? 0) === 0) return result;
  const columns = result.declaredColumns && result.declaredColumns.length > 0
    ? result.declaredColumns
    : result.columns;
  const validated = validateScenarioBindings(model, columns);
  const rows = applyScenarioInputs(result.rows, validated, columns);
  const additions = validated.joins.flatMap((binding) => {
    // validateScenarioBindings rejected joins without an attached input.
    const input = validated.attachments.find(
      (item) => item.id === binding.inputId,
    )!;
    return input.columns
      .filter((c) => c.id !== binding.inputColumn)
      .map((c) => ({ ...c, id: `${input.id}.${c.id}`, nullable: true }));
  });
  return {
    ...result,
    rows,
    columns: [...columns, ...additions],
    declaredColumns: [...columns, ...additions],
    inputLineage: validated.joins.map((binding) => ({
      inputId: binding.inputId,
      sha256: validated.attachments.find((item) => item.id === binding.inputId)!
        .sha256,
      cardinality: "many-to-one",
    })),
  };
}
