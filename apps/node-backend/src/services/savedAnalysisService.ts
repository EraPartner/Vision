import {
  executeFinancialAnalysis,
  isFinancialAnalysisDataset,
} from "./analysisFinancialDatasets.ts";
import {
  applyAnalysisWorkbench,
  applyAnalysisScenarioModel,
  isCompleteAnalysisResult,
} from "./analysisWorkbenchService.ts";
/** Versioned saved-analysis persistence and refresh orchestration. */

import { randomUUID } from "node:crypto";
import { analysisDefinitionSchema } from "@vision/types/analysis";
import { assertAnalysisDatasetReference } from "@vision/types/analysis-datasets";
import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import type { Json } from "../database/schema.generated.ts";
import {
  savedAnalysisRowSchema,
  savedAnalysisTableRowSchema,
  savedAnalysisVersionRowSchema,
  savedAnalysisVersionSourceRowSchema,
  textIdRowSchema,
} from "../database/rows/analysis.ts";
import type { SavedAnalysisRow } from "../database/rows/analysis.ts";
import { compileVisualAnalysis } from "./analysisCatalog.ts";
import { executeAnalysisSql } from "./analysisExecutor.ts";
import { evaluateAnalysisFormulas } from "./analysisFormulaEngine.ts";
import {
  analysisScenarioModelSchema,
  validateScenarioBindings,
} from "./analysisScenarioInputs.ts";
import type {
  AnalysisAssumption,
  AnalysisDefinition,
} from "@vision/types/analysis";
import type { FinancialAnalysisPlan } from "./analysisFinancialDatasets.ts";
import type {
  AnalysisFormulaModel,
  AnalysisResultLike,
  AnalysisScenarioModelInput,
  AnalysisWorkbench,
} from "./analysisWorkbenchService.ts";
import type {
  CompiledVisualAnalysis,
  VisualAnalysisPlan,
} from "./analysisCatalog.ts";
import type { AnalysisColumn } from "./analysisExtensions.ts";
import type {
  AnalysisFormulaInput,
  FormulaUnit,
  FormulaUnitInput,
} from "./analysisFormulaEngine.ts";
import { nonZeroOr } from "../lib/math.ts";

interface StandardParameterValues {
  currency?: string;
  timezone?: string;
  date_from?: string;
  date_to?: string;
}

export interface SavedAnalysisParameters extends StandardParameterValues {
  formulaModel?: AnalysisFormulaModel;
  scenarioModel?: AnalysisScenarioModelInput;
  workbench?: AnalysisWorkbench;
  financialPlan?: Partial<FinancialAnalysisPlan>;
  sqlValues?: unknown[];
  [key: string]: unknown;
}

export type SavedAnalysisFormula = AnalysisFormulaInput & {
  dependencies?: string[];
  rounding?: { mode: string; scale: number };
};

// buildDefinition parses assumptions with the strict contract schema, so the
// input carries the full contract shape, not just the formula-model fields.
export type SavedAnalysisAssumption = AnalysisAssumption;

export type SavedAnalysisQuerySpec =
  | { mode: "visual"; plan: VisualAnalysisPlan }
  | {
      mode: "sql";
      sql: string;
      datasetIds: string[];
      columns?: Array<{
        id: string;
        label?: string;
        type?: string;
        nullable?: boolean;
      }>;
      visualOrigin?: VisualAnalysisPlan;
    };

export interface BuildDefinitionInput {
  definitionId: string;
  version: number;
  name: string;
  workspace: string;
  querySpec: SavedAnalysisQuerySpec;
  parameters?: SavedAnalysisParameters | undefined;
  formulas?: SavedAnalysisFormula[] | undefined;
  assumptions?: SavedAnalysisAssumption[] | undefined;
}

export interface SavedAnalysisInput {
  name: string;
  workspace: string;
  querySpec: SavedAnalysisQuerySpec;
  parameters?: SavedAnalysisParameters | undefined;
  charts?: unknown[] | undefined;
  sourceReferences?: unknown[] | undefined;
  refreshMode?: string | undefined;
  formulas?: SavedAnalysisFormula[] | undefined;
  assumptions?: SavedAnalysisAssumption[] | undefined;
  assumptionValues?: Record<string, unknown> | undefined;
}

export type SavedAnalysisUpdate = Partial<
  Omit<SavedAnalysisInput, "querySpec">
> & {
  querySpec: SavedAnalysisQuerySpec;
  expectedVersion?: number | string | null;
};

export interface SavedVersionState {
  parameters?: SavedAnalysisParameters;
  charts?: unknown[];
  sourceReferences?: unknown[];
  refreshMode?: string;
}

interface DefinitionColumn {
  id: string;
  label: string;
  type: string;
  nullable: boolean;
  unit?: FormulaUnit;
  calculationId?: string;
  calculationVersion?: string;
}

export type SavedAnalysis = ReturnType<typeof mapSaved>;

const WORKSPACES = new Set([
  "budgeting",
  "portfolio",
  "research",
  "cross-workspace",
]);

function standardParameters(values: StandardParameterValues = {}) {
  return [
    {
      id: "currency",
      label: "Reporting currency",
      type: "currency",
      required: true,
      defaultValue: values.currency || "EUR",
      sensitive: false,
    },
    {
      id: "timezone",
      label: "Reporting timezone",
      type: "string",
      required: true,
      defaultValue: values.timezone || "Europe/Helsinki",
      sensitive: false,
    },
    {
      id: "date_from",
      label: "From",
      type: "date",
      required: true,
      defaultValue: values.date_from || "2000-01-01",
      sensitive: false,
    },
    {
      id: "date_to",
      label: "To",
      type: "date",
      required: true,
      defaultValue: values.date_to || new Date().toISOString().slice(0, 10),
      sensitive: false,
    },
  ];
}

function datasetReferences(datasetIds: string[]) {
  return datasetIds.map((id) => {
    const reference = {
      id,
      schemaVersion: 1,
      requiredColumns: [],
      authorizationScope: "local-user-database",
    };
    assertAnalysisDatasetReference(reference);
    return reference;
  });
}

function visualFieldReference(baseDatasetId: string, fieldId: string) {
  if (fieldId.startsWith("account.")) {
    return {
      kind: "field",
      datasetId: "accounts",
      columnId: fieldId.slice("account.".length),
    };
  }
  return { kind: "field", datasetId: baseDatasetId, columnId: fieldId };
}

function definitionColumns(
  compiled: CompiledVisualAnalysis,
): DefinitionColumn[] {
  const measureIds = new Set(compiled.visualPlan.measures);
  return compiled.columns.map((column) => ({
    id: column.id,
    label: column.label,
    type: column.type,
    nullable: column.nullable,
    ...(column.type === "decimal" && column.unit ? { unit: column.unit } : {}),
    ...(measureIds.has(column.id)
      ? { calculationId: column.id, calculationVersion: "analysis-catalog-v1" }
      : {}),
  }));
}

function buildDefinition({
  definitionId,
  version,
  name,
  workspace,
  querySpec,
  parameters,
  formulas = [],
  assumptions = [],
}: BuildDefinitionInput): AnalysisDefinition {
  if (!WORKSPACES.has(workspace))
    throw new Error("Unsupported analysis workspace");
  let source: object;
  let columns: DefinitionColumn[];
  let calculations: object[] = [];
  let datasetIds: string[];
  // Specs are stored JSON; reject a mode neither branch below handles.
  const queryMode: string = querySpec.mode;
  if (queryMode !== "visual" && queryMode !== "sql")
    throw new Error("Unsupported analysis query mode");
  if (querySpec.mode === "visual") {
    const compiled = compileVisualAnalysis(querySpec.plan);
    datasetIds = compiled.datasetIds;
    columns = definitionColumns(compiled);
    const measures = new Set(compiled.visualPlan.measures);
    calculations = columns
      .filter((column) => measures.has(column.id))
      .map((column) => ({
        id: column.id,
        label: column.label,
        kind: "metric",
        expression: column.id,
        resultType: column.type,
        languageVersion: "analysis-sql-v1",
        metricVersion: "analysis-catalog-v1",
        dependencies: [],
        ...(column.type === "decimal" && column.unit
          ? { unit: column.unit }
          : {}),
      }));
    source = {
      kind: "visual-plan",
      planVersion: 1,
      datasetId: querySpec.plan.datasetId,
      select: [
        ...compiled.visualPlan.fields.map((id) => ({
          id,
          source: visualFieldReference(querySpec.plan.datasetId, id),
        })),
        ...compiled.visualPlan.measures.map((id) => ({
          id,
          source: { kind: "metric", calculationId: id },
        })),
      ],
      joins: compiled.visualPlan.joins.map((pathId) => ({
        datasetId: "accounts",
        type: "left",
        pathId,
      })),
      filters: (compiled.visualPlan.filters ?? []).map((filter) => ({
        left: visualFieldReference(querySpec.plan.datasetId, filter.fieldId),
        operator: filter.operator,
        ...(["is-null", "is-not-null"].includes(filter.operator)
          ? {}
          : { right: { kind: "literal", value: filter.value } }),
      })),
      groupBy: compiled.visualPlan.groups,
      orderBy: (compiled.visualPlan.orderBy ?? []).map(({ id, direction }) => ({
        outputId: id,
        direction,
      })),
      limit: Math.min(
        Math.max(nonZeroOr(compiled.visualPlan.limit, 500), 1),
        1000,
      ),
      generatedSql: compiled.sql,
    };
  } else {
    datasetIds = querySpec.datasetIds;
    if (!Array.isArray(datasetIds) || datasetIds.length === 0)
      throw new Error("Custom SQL must declare datasets");
    columns = (querySpec.columns ?? []).map((column) => ({
      id: column.id,
      label: column.label || column.id,
      type: column.type || "string",
      nullable: column.nullable !== false,
    }));
    if (columns.length === 0)
      throw new Error("Custom SQL must declare result columns");
    const visualOrigin = querySpec.visualOrigin
      ? buildDefinition({
          definitionId: `${definitionId}:visual-origin`,
          version,
          name: `${name} visual origin`,
          workspace,
          querySpec: { mode: "visual", plan: querySpec.visualOrigin },
          parameters,
        }).source
      : undefined;
    source = {
      kind: "custom-sql",
      dialect: "postgresql",
      text: querySpec.sql,
      datasetIds,
      parameterBindings: [],
      visualConversion: {
        status: "unsupported",
        reasonCode: "manual-sql-edit",
      },
      ...(visualOrigin ? { visualOrigin } : {}),
    };
  }

  const formulaCalculations = formulas.map((formula) => ({
    id: formula.id,
    label: formula.label || formula.id,
    kind: "formula",
    expression: formula.expression,
    resultType: formula.resultType || "decimal",
    languageVersion: "vision-formula-v1",
    dependencies: formula.dependencies ?? [],
    ...(formula.unit ? { unit: formula.unit } : {}),
    ...(formula.rounding ? { rounding: formula.rounding } : {}),
  }));
  calculations.push(...formulaCalculations);
  columns.push(
    ...formulas
      .filter((formula) => formula.scope === "row")
      .map((formula) => ({
        id: formula.id,
        label: formula.label || formula.id,
        type: formula.resultType || "decimal",
        nullable: true,
        calculationId: formula.id,
        calculationVersion: "vision-formula-v1",
        ...(formula.unit ? { unit: formula.unit } : {}),
      })),
  );

  const definition = {
    contractVersion: 1,
    definitionId,
    definitionVersion: version,
    name,
    workspace,
    datasets: datasetReferences(datasetIds),
    source,
    parameters: standardParameters(parameters),
    calculations,
    assumptions,
    presentations: [],
    expectedResult: { columns },
    reporting: {
      currencyParameterId: "currency",
      timezoneParameterId: "timezone",
      dateFromParameterId: "date_from",
      dateToParameterId: "date_to",
    },
  };
  return analysisDefinitionSchema.parse(definition);
}

function mapSaved(row: SavedAnalysisRow) {
  return {
    id: row.id,
    definitionId: row.definition_id,
    name: row.name,
    workspace: row.workspace,
    version: row.current_version,
    refreshMode: row.refresh_mode,
    parameters: row.parameters_json,
    charts: row.charts_json,
    sourceReferences: row.source_references_json,
    refreshStatus: row.refresh_status,
    lastSuccessfulRunId: row.last_successful_run_id,
    lastError: row.last_error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    definition: row.definition_json,
    lastResult: row.result_json ?? null,
  };
}

function versionState({
  parameters,
  formulaModel,
  charts,
  sourceReferences,
  refreshMode,
}: {
  parameters?: SavedAnalysisParameters | undefined;
  formulaModel: AnalysisFormulaModel;
  charts?: unknown[] | undefined;
  sourceReferences?: unknown[] | undefined;
  refreshMode?: string | undefined;
}) {
  return {
    parameters: { ...(parameters ?? {}), formulaModel },
    charts: charts ?? [],
    sourceReferences: sourceReferences ?? [],
    refreshMode: refreshMode || "live",
  };
}

function resolveFormulaModel(
  input: Pick<
    SavedAnalysisUpdate,
    "formulas" | "assumptions" | "assumptionValues" | "parameters"
  >,
  currentFormulaModel: AnalysisFormulaModel,
): AnalysisFormulaModel {
  const nested = input.parameters?.formulaModel;
  return {
    formulas:
      input.formulas ?? nested?.formulas ?? currentFormulaModel.formulas,
    assumptions:
      input.assumptions ??
      nested?.assumptions ??
      currentFormulaModel.assumptions,
    assumptionValues:
      input.assumptionValues ??
      nested?.assumptionValues ??
      currentFormulaModel.assumptionValues,
  };
}

function jsonb(value: unknown) {
  return sql<Json>`${JSON.stringify(value)}::jsonb`;
}

function selectSaved() {
  return db
    .selectFrom("saved_analyses as sa")
    .innerJoin("saved_analysis_definition_versions as versions", (join) =>
      join
        .onRef("versions.saved_analysis_id", "=", "sa.id")
        .onRef("versions.version", "=", "sa.current_version"),
    )
    .leftJoin(
      "saved_analysis_runs as runs",
      "runs.id",
      "sa.last_successful_run_id",
    )
    .selectAll("sa")
    .select(["versions.definition_json", "runs.result_json"]);
}

export async function listSavedAnalyses(workspace?: string) {
  let builder = selectSaved();
  if (workspace) {
    if (!WORKSPACES.has(workspace))
      throw new Error("Unsupported analysis workspace");
    builder = builder.where("sa.workspace", "=", workspace);
  }
  const rows = await checkedRows(
    savedAnalysisRowSchema,
    builder.orderBy("sa.updated_at", "desc"),
  );
  return rows.map(mapSaved);
}

export async function getSavedAnalysis(id: string) {
  const row = await checkedRow(
    savedAnalysisRowSchema,
    selectSaved().where("sa.id", "=", id),
  );
  return row ? mapSaved(row) : null;
}

export async function createSavedAnalysis(input: SavedAnalysisInput) {
  const id = randomUUID();
  const definitionId = `analysis:${randomUUID()}`;
  const formulaModel = {
    formulas: input.formulas ?? [],
    assumptions: input.assumptions ?? [],
    assumptionValues: input.assumptionValues ?? {},
  };
  const scenarioModel = analysisScenarioModelSchema.parse(
    input.parameters?.scenarioModel ?? { attachments: [], joins: [] },
  );
  const definition = buildDefinition({
    ...input,
    ...formulaModel,
    definitionId,
    version: 1,
  });
  validateScenarioBindings(
    scenarioModel,
    definition.expectedResult.columns.filter(
      ({ calculationVersion }) => calculationVersion !== "vision-formula-v1",
    ),
  );
  await withTransaction(async () => {
    await db
      .insertInto("saved_analyses")
      .values({
        id,
        definition_id: definitionId,
        name: input.name,
        workspace: input.workspace,
        current_version: 1,
        refresh_mode: input.refreshMode || "live",
        parameters_json: jsonb({
          ...(input.parameters ?? {}),
          formulaModel,
          scenarioModel,
        }),
        charts_json: jsonb(input.charts ?? []),
        source_references_json: jsonb(input.sourceReferences ?? []),
      })
      .execute();
    await db
      .insertInto("saved_analysis_definition_versions")
      .values({
        saved_analysis_id: id,
        version: 1,
        definition_json: jsonb(definition),
        state_json: jsonb(
          versionState({
            parameters: { ...(input.parameters ?? {}), scenarioModel },
            formulaModel,
            charts: input.charts,
            sourceReferences: input.sourceReferences,
            refreshMode: input.refreshMode,
          }),
        ),
      })
      .execute();
  });
  return getSavedAnalysis(id);
}

function lockSaved(id: string) {
  return db
    .selectFrom("saved_analyses")
    .selectAll()
    .where("id", "=", id)
    .forUpdate();
}

export async function updateSavedAnalysis(
  id: string,
  input: SavedAnalysisUpdate,
) {
  await withTransaction(async () => {
    const current = await checkedRow(
      savedAnalysisTableRowSchema,
      lockSaved(id),
    );
    if (!current)
      throw Object.assign(new Error("Saved analysis not found"), {
        status: 404,
      });
    if (
      input.expectedVersion != null &&
      Number(input.expectedVersion) !== current.current_version
    )
      throw Object.assign(
        new Error("Saved analysis changed since this edit was prepared"),
        { status: 409, code: "ANALYSIS_VERSION_CONFLICT" },
      );
    const version = current.current_version + 1;
    const currentFormulaModel: AnalysisFormulaModel = current.parameters_json.formulaModel ?? {
      formulas: [],
      assumptions: [],
      assumptionValues: {},
    };
    const formulaModel = resolveFormulaModel(input, currentFormulaModel);
    const scenarioModel = analysisScenarioModelSchema.parse(
      input.parameters?.scenarioModel ??
        current.parameters_json.scenarioModel ?? {
          attachments: [],
          joins: [],
        },
    );
    const definition = buildDefinition({
      ...input,
      name: input.name ?? current.name,
      workspace: input.workspace ?? current.workspace,
      definitionId: current.definition_id,
      version,
      ...formulaModel,
    });
    validateScenarioBindings(
      scenarioModel,
      definition.expectedResult.columns.filter(
        ({ calculationVersion }) => calculationVersion !== "vision-formula-v1",
      ),
    );
    const state = versionState({
      parameters: {
        ...(input.parameters ?? current.parameters_json),
        scenarioModel,
      },
      formulaModel,
      charts: input.charts ?? current.charts_json,
      sourceReferences:
        input.sourceReferences ?? current.source_references_json,
      refreshMode: input.refreshMode || current.refresh_mode,
    });
    await db
      .insertInto("saved_analysis_definition_versions")
      .values({
        saved_analysis_id: id,
        version,
        definition_json: jsonb(definition),
        state_json: jsonb(state),
      })
      .execute();
    await db
      .updateTable("saved_analyses")
      .set({
        name: definition.name,
        workspace: definition.workspace,
        current_version: version,
        refresh_mode: input.refreshMode || current.refresh_mode,
        parameters_json: jsonb({
          ...(input.parameters ?? current.parameters_json),
          formulaModel,
          scenarioModel,
        }),
        charts_json: jsonb(input.charts ?? current.charts_json),
        source_references_json: jsonb(
          input.sourceReferences ?? current.source_references_json,
        ),
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", id)
      .execute();
  });
  return getSavedAnalysis(id);
}

function runtimeRequest(saved: SavedAnalysis) {
  const source = saved.definition.source;
  if (source.kind === "custom-sql") {
    return {
      financialPlan: undefined,
      declaredColumns: saved.definition.expectedResult.columns.filter(
        (column) =>
          !saved.definition.calculations.some(
            (calculation) =>
              calculation.kind === "formula" && calculation.id === column.id,
          ),
      ),
      sql: source.text,
      values: saved.parameters.sqlValues ?? [],
      datasetIds: source.datasetIds,
    };
  }
  const fields = source.select
    .filter((entry) => entry.source.kind === "field")
    .map((entry) => entry.id);
  const measures = source.select
    .filter((entry) => entry.source.kind === "metric")
    .map((entry) => entry.id);
  const plan: VisualAnalysisPlan = {
    datasetId: source.datasetId,
    fields,
    measures,
    groups: source.groupBy,
    joins: source.joins.map((join) => join.pathId),
    filters: source.filters.map((filter) => ({
      fieldId:
        filter.left.datasetId === "accounts"
          ? `account.${filter.left.columnId}`
          : filter.left.columnId,
      operator: filter.operator,
      ...("right" in filter && filter.right?.kind === "literal"
        ? { value: filter.right.value }
        : {}),
    })),
    orderBy: source.orderBy.map(({ outputId, direction }) => ({
      id: outputId,
      direction,
    })),
    limit: source.limit,
  };
  for (const key of [
    "reportingCurrency",
    "from",
    "to",
    "symbol",
    "range",
    "costBasisMethod",
  ] as const) {
    if (saved.parameters.financialPlan?.[key] !== undefined)
      plan[key] = saved.parameters.financialPlan[key];
  }
  const compiled = compileVisualAnalysis(plan);
  return {
    ...(isFinancialAnalysisDataset(plan.datasetId)
      ? { financialPlan: plan }
      : {}),
    declaredColumns: compiled.columns,
    sql: compiled.sql,
    values: compiled.values,
    datasetIds: compiled.datasetIds,
    limit: compiled.visualPlan.limit,
  };
}

function finalizeSavedAnalysisResult(
  result: AnalysisResultLike,
  parameters: SavedAnalysisParameters,
) {
  result = applyAnalysisWorkbench(
    applyAnalysisScenarioModel(result, parameters.scenarioModel),
    parameters.workbench,
  );
  const formulaModel = parameters.formulaModel ?? {
    formulas: [],
    assumptions: [],
    assumptionValues: {},
  };
  const assumptions = Object.fromEntries(
    (formulaModel.assumptions ?? []).map((item): [string, unknown] => [
      item.id,
      formulaModel.assumptionValues?.[item.id] ?? item.defaultValue,
    ]),
  );
  const scenarioRows = result.rows;
  const formulaResult = evaluateAnalysisFormulas({
    rows: scenarioRows,
    inputComplete: isCompleteAnalysisResult(result),
    formulas: formulaModel.formulas ?? [],
    columns: result.declaredColumns ?? result.columns,
    assumptionUnits: Object.fromEntries(
      (formulaModel.assumptions ?? [])
        .filter((item) => item.unit)
        .map((item): [string, FormulaUnitInput] => [item.id, item.unit]),
    ),
    assumptions,
  });
  const formulaColumns = (formulaModel.formulas ?? [])
    .filter((formula) => formula.scope === "row")
    .map((formula) => ({
      id: formula.id,
      label: formula.label || formula.id,
      type: formula.resultType || "decimal",
      nullable: true,
      calculationId: formula.id,
      calculationVersion: formulaResult.languageVersion,
      ...(formulaResult.formulaUnits[formula.id] || formula.unit
        ? { unit: formulaResult.formulaUnits[formula.id] ?? formula.unit }
        : {}),
    }));
  const formulaIds = new Set(formulaColumns.map((column) => column.id));
  const appendFormulaColumns = (columns: AnalysisColumn[] = []) => [
    ...columns.filter((column) => !formulaIds.has(column.id)),
    ...formulaColumns,
  ];
  return {
    complete: formulaResult.complete && isCompleteAnalysisResult(result),
    result: {
      ...result,
      complete: formulaResult.complete && isCompleteAnalysisResult(result),
      coverage: {
        ...result.coverage,
        complete: formulaResult.complete && isCompleteAnalysisResult(result),
        status:
          formulaResult.complete && isCompleteAnalysisResult(result)
            ? "complete"
            : "partial",
      },
      ...((formulaModel.formulas ?? []).length > 0
        ? { sourceResult: result.sourceResult ?? result }
        : {}),
      rows: formulaResult.rows,
      columns: appendFormulaColumns(result.columns),
      ...(result.declaredColumns && result.declaredColumns.length > 0
        ? { declaredColumns: appendFormulaColumns(result.declaredColumns) }
        : {}),
      formulaSummaries: formulaResult.summaries,
      formulaErrors: formulaResult.errors,
      formulaLanguageVersion: formulaResult.languageVersion,
    },
  };
}

export async function runSavedAnalysis(
  id: string,
  options: { includeRunId: true },
): Promise<{ saved: SavedAnalysis | null; runId: string }>;
export async function runSavedAnalysis(
  id: string,
  options?: { includeRunId?: false },
): Promise<SavedAnalysis | null>;
export async function runSavedAnalysis(
  id: string,
  options: { includeRunId?: boolean } = {},
): Promise<
  SavedAnalysis | null | { saved: SavedAnalysis | null; runId: string }
> {
  const saved = await getSavedAnalysis(id);
  if (!saved)
    throw Object.assign(new Error("Saved analysis not found"), { status: 404 });
  const runId = randomUUID();
  await withTransaction(async () => {
    await db
      .insertInto("saved_analysis_runs")
      .values({
        id: runId,
        saved_analysis_id: id,
        definition_version: saved.version,
        status: "running",
        parameters_json: jsonb(saved.parameters),
        started_at: sql<Date>`now()`,
      })
      .execute();
    await db
      .updateTable("saved_analyses")
      .set({
        refresh_status: "running",
        last_error_json: null,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", id)
      .execute();
  });
  try {
    const request = runtimeRequest(saved);
    const rawResult = request.financialPlan
      ? await executeFinancialAnalysis(request.financialPlan, {
          requestId: runId,
        })
      : await executeAnalysisSql({ requestId: runId, ...request });
    const result = {
      ...rawResult,
      declaredColumns:
        ("declaredColumns" in rawResult ? rawResult.declaredColumns : undefined) ??
        request.declaredColumns,
    };
    const finalized = finalizeSavedAnalysisResult(result, saved.parameters);
    const completedResult = finalized.result;
    const status =
      ("hasMore" in result.window && result.window.hasMore) ||
      result.window.kind === "truncated" ||
      !finalized.complete
        ? "partial"
        : "completed";
    await withTransaction(async () => {
      await db
        .updateTable("saved_analysis_runs")
        .set({
          status,
          result_json: jsonb(completedResult),
          completed_at: sql<Date>`now()`,
        })
        .where("id", "=", runId)
        .execute();
      await db
        .updateTable("saved_analyses")
        .set({
          refresh_status: "succeeded",
          last_successful_run_id: runId,
          last_error_json: null,
          updated_at: sql<Date>`now()`,
        })
        .where("id", "=", id)
        .execute();
    });
    const updated = await getSavedAnalysis(id);
    return options.includeRunId ? { saved: updated, runId } : updated;
  } catch (caught) {
    // Execution failures are pg or service Errors, optionally with a SQLSTATE.
    const error = caught as Error & { code?: string; monitorRunId?: string };
    const cancelled = error.code === "57014";
    const errorJson = {
      code: cancelled ? "cancelled" : "execution-failed",
      message: error.message,
    };
    const failedStatus = cancelled ? "cancelled" : "failed";
    await withTransaction(async () => {
      await db
        .updateTable("saved_analysis_runs")
        .set({
          status: failedStatus,
          error_json: jsonb(errorJson),
          completed_at: sql<Date>`now()`,
        })
        .where("id", "=", runId)
        .execute();
      await db
        .updateTable("saved_analyses")
        .set({
          refresh_status: failedStatus,
          last_error_json: jsonb(errorJson),
          updated_at: sql<Date>`now()`,
        })
        .where("id", "=", id)
        .execute();
    });
    error.monitorRunId = runId;
    throw error;
  }
}

export async function listSavedAnalysisVersions(id: string) {
  return checkedRows(
    savedAnalysisVersionRowSchema,
    db
      .selectFrom("saved_analysis_definition_versions")
      .select([
        "version",
        "definition_json as definition",
        "state_json as state",
        "created_at as createdAt",
      ])
      .where("saved_analysis_id", "=", id)
      .orderBy("version", "desc"),
  );
}

export async function restoreSavedAnalysisVersion(
  id: string,
  version: number | string,
  expectedVersion: number | string,
) {
  await withTransaction(async () => {
    const locked = await checkedRow(savedAnalysisTableRowSchema, lockSaved(id));
    if (!locked)
      throw Object.assign(new Error("Saved analysis not found"), {
        status: 404,
      });
    if (locked.current_version !== Number(expectedVersion))
      throw Object.assign(
        new Error("Saved analysis changed since this restore was prepared"),
        { status: 409, code: "ANALYSIS_VERSION_CONFLICT" },
      );
    const source = await checkedRow(
      savedAnalysisVersionSourceRowSchema,
      db
        .selectFrom("saved_analysis_definition_versions")
        .select(["definition_json", "state_json"])
        .where("saved_analysis_id", "=", id)
        .where("version", "=", sql<number>`${version}`),
    );
    if (!source)
      throw Object.assign(new Error("Saved analysis version not found"), {
        status: 404,
      });
    if (source.state_json == null)
      throw Object.assign(
        new Error(
          "This legacy version does not contain enough state for a safe restore",
        ),
        { status: 409, code: "ANALYSIS_LEGACY_VERSION_STATE_UNAVAILABLE" },
      );
    const next = locked.current_version + 1;
    const restored = { ...source.definition_json, definitionVersion: next };
    const state = source.state_json;
    await db
      .insertInto("saved_analysis_definition_versions")
      .values({
        saved_analysis_id: id,
        version: next,
        definition_json: jsonb(restored),
        state_json: jsonb(state),
      })
      .execute();
    await db
      .updateTable("saved_analyses")
      .set({
        current_version: next,
        name: restored.name,
        workspace: restored.workspace,
        parameters_json: jsonb(state.parameters ?? locked.parameters_json),
        charts_json: jsonb(state.charts ?? locked.charts_json),
        source_references_json: jsonb(
          state.sourceReferences ?? locked.source_references_json,
        ),
        refresh_mode: state.refreshMode || locked.refresh_mode,
        updated_at: sql<Date>`NOW()`,
      })
      .where("id", "=", id)
      .execute();
  });
  return getSavedAnalysis(id);
}

export async function deleteSavedAnalysis(id: string) {
  const rows = await checkedRows(
    textIdRowSchema,
    db.deleteFrom("saved_analyses").where("id", "=", id).returning("id"),
  );
  return rows.length > 0;
}

export {
  buildDefinition as __buildDefinition,
  runtimeRequest as __runtimeRequest,
  resolveFormulaModel as __resolveFormulaModel,
  finalizeSavedAnalysisResult as __finalizeSavedAnalysisResult,
};
