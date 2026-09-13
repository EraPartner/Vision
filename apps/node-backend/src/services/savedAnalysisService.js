/** Versioned saved-analysis persistence and refresh orchestration. */

import { randomUUID } from "node:crypto";
import { analysisDefinitionSchema } from "@vision/types/analysis";
import { assertAnalysisDatasetReference } from "@vision/types/analysis-datasets";
import { query, withTransaction } from "../database/connection.js";
import { compileVisualAnalysis } from "./analysisCatalog.js";
import { executeAnalysisSql } from "./analysisExecutor.js";

const WORKSPACES = new Set([
  "budgeting",
  "portfolio",
  "research",
  "cross-workspace",
]);

function standardParameters(values = {}) {
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

function datasetReferences(datasetIds) {
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

function visualFieldReference(baseDatasetId, fieldId) {
  if (fieldId.startsWith("account.")) {
    return {
      kind: "field",
      datasetId: "accounts",
      columnId: fieldId.slice("account.".length),
    };
  }
  return { kind: "field", datasetId: baseDatasetId, columnId: fieldId };
}

function definitionColumns(compiled) {
  const measureIds = new Set(compiled.visualPlan?.measures ?? []);
  return compiled.columns.map((column) => ({
    id: column.id,
    label: column.label,
    type: column.type,
    nullable: column.nullable,
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
}) {
  if (!WORKSPACES.has(workspace))
    throw new Error("Unsupported analysis workspace");
  let source;
  let columns;
  let calculations = [];
  let datasetIds;
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
      orderBy: compiled.visualPlan.orderBy ?? [],
      limit: Math.min(
        Math.max(Number(compiled.visualPlan.limit) || 500, 1),
        1000,
      ),
      generatedSql: compiled.sql,
    };
  } else if (querySpec.mode === "sql") {
    datasetIds = querySpec.datasetIds;
    if (!Array.isArray(datasetIds) || datasetIds.length === 0)
      throw new Error("Custom SQL must declare datasets");
    columns = (querySpec.columns ?? []).map((column) => ({
      id: column.id,
      label: column.label || column.id,
      type: column.type || "string",
      nullable: column.nullable !== false,
    }));
    if (!columns.length)
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
  } else {
    throw new Error("Unsupported analysis query mode");
  }

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
    assumptions: [],
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

function mapSaved(row) {
  return {
    id: row.id,
    definitionId: row.definition_id,
    name: row.name,
    workspace: row.workspace,
    version: Number(row.current_version),
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

export async function listSavedAnalyses(workspace) {
  const params = [];
  const where = workspace ? "WHERE sa.workspace = $1" : "";
  if (workspace) {
    if (!WORKSPACES.has(workspace))
      throw new Error("Unsupported analysis workspace");
    params.push(workspace);
  }
  const result = await query(
    `SELECT sa.*, versions.definition_json, runs.result_json
       FROM saved_analyses sa
       JOIN saved_analysis_definition_versions versions
         ON versions.saved_analysis_id = sa.id AND versions.version = sa.current_version
       LEFT JOIN saved_analysis_runs runs ON runs.id = sa.last_successful_run_id
       ${where}
      ORDER BY sa.updated_at DESC`,
    params,
  );
  return result.rows.map(mapSaved);
}

export async function getSavedAnalysis(id) {
  const result = await query(
    `SELECT sa.*, versions.definition_json, runs.result_json
       FROM saved_analyses sa
       JOIN saved_analysis_definition_versions versions
         ON versions.saved_analysis_id = sa.id AND versions.version = sa.current_version
       LEFT JOIN saved_analysis_runs runs ON runs.id = sa.last_successful_run_id
      WHERE sa.id = $1`,
    [id],
  );
  return result.rows[0] ? mapSaved(result.rows[0]) : null;
}

export async function createSavedAnalysis(input) {
  const id = randomUUID();
  const definitionId = `analysis:${randomUUID()}`;
  const definition = buildDefinition({ ...input, definitionId, version: 1 });
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO saved_analyses
        (id, definition_id, name, workspace, current_version, refresh_mode,
         parameters_json, charts_json, source_references_json)
       VALUES ($1,$2,$3,$4,1,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [
        id,
        definitionId,
        input.name,
        input.workspace,
        input.refreshMode || "live",
        JSON.stringify(input.parameters || {}),
        JSON.stringify(input.charts || []),
        JSON.stringify(input.sourceReferences || []),
      ],
    );
    await client.query(
      `INSERT INTO saved_analysis_definition_versions
        (saved_analysis_id, version, definition_json) VALUES ($1,1,$2::jsonb)`,
      [id, JSON.stringify(definition)],
    );
  });
  return getSavedAnalysis(id);
}

export async function updateSavedAnalysis(id, input) {
  await withTransaction(async (client) => {
    const locked = await client.query(
      "SELECT * FROM saved_analyses WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!locked.rows[0])
      throw Object.assign(new Error("Saved analysis not found"), {
        status: 404,
      });
    const current = locked.rows[0];
    const version = Number(current.current_version) + 1;
    const definition = buildDefinition({
      ...input,
      name: input.name ?? current.name,
      workspace: input.workspace ?? current.workspace,
      definitionId: current.definition_id,
      version,
    });
    await client.query(
      `INSERT INTO saved_analysis_definition_versions
        (saved_analysis_id, version, definition_json) VALUES ($1,$2,$3::jsonb)`,
      [id, version, JSON.stringify(definition)],
    );
    await client.query(
      `UPDATE saved_analyses SET name=$2, workspace=$3, current_version=$4,
         refresh_mode=$5, parameters_json=$6::jsonb, charts_json=$7::jsonb,
         source_references_json=$8::jsonb, updated_at=now()
       WHERE id=$1`,
      [
        id,
        definition.name,
        definition.workspace,
        version,
        input.refreshMode || current.refresh_mode,
        JSON.stringify(input.parameters || current.parameters_json),
        JSON.stringify(input.charts || current.charts_json),
        JSON.stringify(
          input.sourceReferences || current.source_references_json,
        ),
      ],
    );
  });
  return getSavedAnalysis(id);
}

function runtimeRequest(saved) {
  const source = saved.definition.source;
  if (source.kind === "custom-sql") {
    return {
      sql: source.text,
      values: saved.parameters.sqlValues || [],
      datasetIds: source.datasetIds,
    };
  }
  const fields = source.select
    .filter((entry) => entry.source.kind === "field")
    .map((entry) => entry.id);
  const measures = source.select
    .filter((entry) => entry.source.kind === "metric")
    .map((entry) => entry.id);
  const plan = {
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
      ...("right" in filter && filter.right.kind === "literal"
        ? { value: filter.right.value }
        : {}),
    })),
    orderBy: source.orderBy,
    limit: source.limit,
  };
  const compiled = compileVisualAnalysis(plan);
  return {
    sql: compiled.sql,
    values: compiled.values,
    datasetIds: compiled.datasetIds,
  };
}

export async function runSavedAnalysis(id) {
  const saved = await getSavedAnalysis(id);
  if (!saved)
    throw Object.assign(new Error("Saved analysis not found"), { status: 404 });
  const runId = randomUUID();
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO saved_analysis_runs
        (id, saved_analysis_id, definition_version, status, parameters_json, started_at)
       VALUES ($1,$2,$3,'running',$4::jsonb,now())`,
      [runId, id, saved.version, JSON.stringify(saved.parameters)],
    );
    await client.query(
      "UPDATE saved_analyses SET refresh_status='running', last_error_json=NULL, updated_at=now() WHERE id=$1",
      [id],
    );
  });
  try {
    const result = await executeAnalysisSql({
      requestId: runId,
      ...runtimeRequest(saved),
    });
    const status =
      result.window.hasMore || result.window.kind === "truncated"
        ? "partial"
        : "completed";
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE saved_analysis_runs SET status=$2, result_json=$3::jsonb, completed_at=now() WHERE id=$1`,
        [runId, status, JSON.stringify(result)],
      );
      await client.query(
        `UPDATE saved_analyses SET refresh_status='succeeded', last_successful_run_id=$2,
           last_error_json=NULL, updated_at=now() WHERE id=$1`,
        [id, runId],
      );
    });
    return getSavedAnalysis(id);
  } catch (error) {
    const cancelled = error.code === "57014";
    const errorJson = {
      code: cancelled ? "cancelled" : "execution-failed",
      message: error.message,
    };
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE saved_analysis_runs SET status=$2, error_json=$3::jsonb, completed_at=now() WHERE id=$1`,
        [runId, cancelled ? "cancelled" : "failed", JSON.stringify(errorJson)],
      );
      await client.query(
        `UPDATE saved_analyses SET refresh_status=$2, last_error_json=$3::jsonb, updated_at=now() WHERE id=$1`,
        [id, cancelled ? "cancelled" : "failed", JSON.stringify(errorJson)],
      );
    });
    throw error;
  }
}

export async function deleteSavedAnalysis(id) {
  const result = await query(
    "DELETE FROM saved_analyses WHERE id = $1 RETURNING id",
    [id],
  );
  return result.rows.length > 0;
}

export { buildDefinition as __buildDefinition };
