import {
  applyScenarioInputs,
  validateScenarioBindings,
} from "./analysisScenarioInputs.js";
import {
  prepareAnalysisData,
  compareAnalysisTime,
  runAnalysisScenarios,
  buildAnalysisSensitivity,
  seekAnalysisGoal,
} from "./analysisExtensions.js";
import { evaluateAnalysisFormulas } from "./analysisFormulaEngine.js";

/** Population completeness includes value coverage, not merely pagination. */
export function isCompleteAnalysisResult(result) {
  return (
    result.complete !== false &&
    result.window?.kind === "page" &&
    !result.window.hasMore &&
    !result.window.offset &&
    result.coverage?.complete !== false &&
    result.coverage?.status !== "partial" &&
    !(result.transformationErrors || []).length &&
    (result.transformationCoverage || []).every(
      (coverage) => coverage.complete !== false,
    )
  );
}
function formulaOutputColumns(columns, formulas, evaluated) {
  const additions = formulas
    .filter((formula) => formula.scope === "row")
    .map((formula) => ({
      id: formula.id,
      label: formula.label || formula.id,
      type: formula.resultType || "decimal",
      nullable: true,
      ...(evaluated.formulaUnits?.[formula.id] || formula.unit
        ? { unit: evaluated.formulaUnits?.[formula.id] || formula.unit }
        : {}),
    }));
  const ids = new Set(additions.map((column) => column.id));
  return [...columns.filter((column) => !ids.has(column.id)), ...additions];
}
export function evaluateAnalysisExtension(input) {
  const functions = {
    prepare: prepareAnalysisData,
    time: compareAnalysisTime,
    scenarios: runAnalysisScenarios,
    sensitivity: buildAnalysisSensitivity,
    goal: seekAnalysisGoal,
    formulas: evaluateAnalysisFormulas,
  };
  const fn = functions[input?.operation];
  if (!fn) throw new Error("Unsupported analysis operation");
  let request = input;
  let prepared = {
    rows: input.rows,
    columns: input.columns || [],
    window: input.window || {
      kind: "page",
      offset: 0,
      hasMore: input.complete === false,
      returnedRows: input.rows?.length || 0,
    },
    coverage: input.coverage,
    complete: input.complete,
  };
  if (
    ["time", "formulas", "scenarios", "sensitivity", "goal"].includes(input.operation)
  ) {
    if (input.workbench)
      prepared = applyAnalysisWorkbench(prepared, input.operation === "time"
        ? { ...input.workbench, time: undefined }
        : input.workbench);
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
    request.columns,
    request.formulas || [],
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
    transformationCoverage: prepared.transformationCoverage || [],
    transformationErrors: prepared.transformationErrors || [],
    preparationLineage: prepared.preparationLineage || [],
  };
}

/** The same repeatable pipeline is used for fresh and saved runs. */
export function applyAnalysisWorkbench(result, workbench = {}) {
  const source = result.sourceResult || result;
  let rows = source.rows;
  let columns = source.declaredColumns?.length
    ? source.declaredColumns
    : source.columns;
  let complete = isCompleteAnalysisResult(source);
  const lineage = [];
  const coverage = [];
  const errors = [];
  if (workbench.steps?.length) {
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
  if (workbench.time?.dateColumn && workbench.time?.valueColumns?.length) {
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
    ...(workbench.steps?.length || workbench.time?.dateColumn
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

export function applyAnalysisFormulaModel(result, model = {}) {
  const assumptions = Object.fromEntries(
    (model.assumptions || []).map((item) => [
      item.id,
      model.assumptionValues?.[item.id] ?? item.defaultValue,
    ]),
  );
  const columns = result.declaredColumns?.length
    ? result.declaredColumns
    : result.columns;
  const evaluated = evaluateAnalysisFormulas({
    rows: result.rows,
    columns,
    formulas: model.formulas || [],
    assumptions,
    assumptionUnits: Object.fromEntries(
      (model.assumptions || [])
        .filter((item) => item.unit)
        .map((item) => [item.id, item.unit]),
    ),
    inputComplete: isCompleteAnalysisResult(result),
  });
  const formulaColumns = (model.formulas || [])
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
    ...((model.formulas || []).length
      ? { sourceResult: result.sourceResult || result }
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

export function applyAnalysisScenarioModel(result, model) {
  if (!model?.joins?.length) return result;
  const columns = result.declaredColumns?.length
    ? result.declaredColumns
    : result.columns;
  const validated = validateScenarioBindings(model, columns);
  const rows = applyScenarioInputs(result.rows, validated, columns);
  const additions = validated.joins.flatMap((binding) => {
    const input = validated.attachments.find(
      (item) => item.id === binding.inputId,
    );
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
      sha256: validated.attachments.find((item) => item.id === binding.inputId)
        .sha256,
      cardinality: "many-to-one",
    })),
  };
}
