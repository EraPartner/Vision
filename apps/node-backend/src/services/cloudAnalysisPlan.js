/** Validate and execute cloud-authored catalog plans without accepting SQL. */

import { aiCloudAnalysisPlanSchema } from "@vision/types/aiResearch";
import { randomUUID } from "node:crypto";
import {
  getAnalysisCatalog,
  compileVisualAnalysis,
} from "./analysisCatalog.js";
import { executeAnalysisSql } from "./analysisExecutor.js";
import { evaluateAnalysisFormulas } from "./analysisFormulaEngine.js";

const WORKSPACE_DATASETS = Object.freeze({
  budgeting: new Set(["transactions", "accounts", "cash-flows"]),
  portfolio: new Set(["holdings", "accounts"]),
  research: new Set(),
  "cross-workspace": new Set([
    "transactions",
    "accounts",
    "holdings",
    "cash-flows",
  ]),
});

export function getPublicCloudAnalysisCatalog() {
  const catalog = getAnalysisCatalog();
  return {
    version: catalog.version,
    operators: [
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
      "contains",
      "starts-with",
      "is-null",
      "is-not-null",
    ],
    datasets: catalog.datasets.map(({ id, fields, measures, joins }) => ({
      id,
      fields: fields.map(({ id: fieldId, type }) => ({ id: fieldId, type })),
      measures: measures.map(({ id: measureId, type }) => ({
        id: measureId,
        type,
      })),
      joins: joins.map(({ id: joinId }) => joinId),
    })),
  };
}

function jsonObject(text) {
  const start = String(text).indexOf("{");
  const end = String(text).lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("Cloud planner did not return JSON");
  return JSON.parse(String(text).slice(start, end + 1));
}

function allowedDatasets(workspaces) {
  const allowed = new Set();
  for (const workspace of workspaces ?? []) {
    for (const dataset of WORKSPACE_DATASETS[workspace] ?? [])
      allowed.add(dataset);
  }
  return allowed;
}

export function parseCloudAnalysisPlans(text, { workspaces }) {
  const value = jsonObject(text);
  if (!Array.isArray(value.analysisPlans)) return [];
  if (value.analysisPlans.length > 3)
    throw new Error("Cloud planner returned too many analysis plans");
  const catalog = getAnalysisCatalog();
  const allowed = allowedDatasets(workspaces);
  return value.analysisPlans.map((candidate) => {
    const plan = aiCloudAnalysisPlanSchema.parse(candidate);
    return validateCloudPlan(plan, catalog, allowed);
  });
}

function validateCloudPlan(plan, catalog, allowed) {
  if (plan.catalogVersion !== catalog.version)
    throw new Error("Cloud analysis catalog version is stale");
  if (!allowed.has(plan.datasetId))
    throw new Error(
      "Cloud analysis plan is outside the trusted workspace scope",
    );
  compileVisualAnalysis(plan);
  return plan;
}

function trustedPredicates(plan, scope, existingValueCount) {
  const alias = plan.joins.length ? "analysis_base." : "";
  const predicates = [];
  const values = [];
  const push = (sql, value) => {
    values.push(value);
    predicates.push(sql.replace("?", `$${existingValueCount + values.length}`));
  };
  const accountField = {
    transactions: "account_id",
    accounts: "account_id",
    holdings: "account_id",
    "cash-flows": "account_id",
  }[plan.datasetId];
  if (scope.accountIds?.length && accountField) {
    const placeholders = scope.accountIds.map((id) => {
      values.push(id);
      return `$${existingValueCount + values.length}`;
    });
    predicates.push(`${alias}${accountField} IN (${placeholders.join(", ")})`);
  }
  const dateField = {
    transactions: "transaction_date",
    holdings: "event_date",
    "cash-flows": "cash_flow_date",
  }[plan.datasetId];
  if (scope.dateFrom && dateField)
    push(`${alias}${dateField} >= ?`, scope.dateFrom);
  if (scope.dateTo && dateField)
    push(`${alias}${dateField} <= ?`, scope.dateTo);
  if (scope.investmentIds?.length && plan.datasetId === "holdings") {
    const placeholders = scope.investmentIds.map((id) => {
      values.push(id);
      return `$${existingValueCount + values.length}`;
    });
    predicates.push(`${alias}investment_id IN (${placeholders.join(", ")})`);
  }
  return { predicates, values };
}

function injectPredicates(sql, predicates) {
  if (!predicates.length) return sql;
  const boundary = sql.search(/\n(?:GROUP BY|ORDER BY|LIMIT)\b/);
  const head = boundary < 0 ? sql : sql.slice(0, boundary);
  const tail = boundary < 0 ? "" : sql.slice(boundary);
  return `${head}${/\nWHERE\b/.test(head) ? " AND " : "\nWHERE "}${predicates.join(" AND ")}${tail}`;
}

export async function executeCloudAnalysisPlan(
  candidate,
  trustedScope,
  { execute = executeAnalysisSql, requestId } = {},
) {
  const plan = validateCloudPlan(
    aiCloudAnalysisPlanSchema.parse(candidate),
    getAnalysisCatalog(),
    allowedDatasets(trustedScope?.workspaces),
  );
  const compiled = compileVisualAnalysis(plan);
  const trusted = trustedPredicates(plan, trustedScope, compiled.values.length);
  const scopedSql = injectPredicates(compiled.sql, trusted.predicates);
  const result = await execute({
    requestId: requestId ?? `cloud-plan-${randomUUID()}`,
    sql: scopedSql,
    values: [...compiled.values, ...trusted.values],
    datasetIds: compiled.datasetIds,
    limit: plan.limit,
  });
  const formulas = evaluateAnalysisFormulas({
    rows: result.rows,
    formulas: plan.formulas,
    assumptions: {},
  });
  return {
    ...result,
    rows: formulas.rows,
    formulaSummaries: formulas.summaries,
    formulaErrors: formulas.errors,
    formulaLanguageVersion: formulas.languageVersion,
    generatedSql: scopedSql,
    declaredColumns: compiled.columns,
  };
}
