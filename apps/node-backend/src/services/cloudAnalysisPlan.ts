/** Validate and execute cloud-authored catalog plans without accepting SQL. */

import { aiCloudAnalysisPlanSchema } from "@vision/types/aiResearch";
import type { AiCloudAnalysisPlan } from "@vision/types/aiResearch";
import { randomUUID } from "node:crypto";
import {
  getAnalysisCatalog,
  compileVisualAnalysis,
} from "./analysisCatalog.ts";
import { executeAnalysisSql } from "./analysisExecutor.ts";
import type {
  AnalysisSqlRequest,
  AnalysisSqlResult,
} from "./analysisExecutor.ts";
import { evaluateAnalysisFormulas } from "./analysisFormulaEngine.ts";

/** Scope the trusted caller (never the cloud planner) imposes on a plan. */
export interface CloudAnalysisTrustedScope {
  workspaces?: string[];
  accountIds?: number[];
  investmentIds?: number[];
  dateFrom?: string | null;
  dateTo?: string | null;
}

type AnalysisCatalog = ReturnType<typeof getAnalysisCatalog>;

const WORKSPACE_DATASETS: Readonly<Record<string, Set<string>>> = Object.freeze(
  {
    budgeting: new Set(["transactions", "accounts", "cash-flows"]),
    portfolio: new Set(["holdings", "accounts"]),
    research: new Set<string>(),
    "cross-workspace": new Set([
      "transactions",
      "accounts",
      "holdings",
      "cash-flows",
    ]),
  },
);

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

function jsonObject(text: unknown) {
  const start = String(text).indexOf("{");
  const end = String(text).lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("Cloud planner did not return JSON");
  return JSON.parse(String(text).slice(start, end + 1)) as {
    analysisPlans?: unknown;
  };
}

function allowedDatasets(workspaces: string[] | undefined) {
  const allowed = new Set<string>();
  for (const workspace of workspaces ?? []) {
    for (const dataset of WORKSPACE_DATASETS[workspace] ?? [])
      allowed.add(dataset);
  }
  return allowed;
}

export function parseCloudAnalysisPlans(
  text: unknown,
  { workspaces }: { workspaces?: string[] },
): AiCloudAnalysisPlan[] {
  const value = jsonObject(text);
  if (!Array.isArray(value.analysisPlans)) return [];
  if (value.analysisPlans.length > 3)
    throw new Error("Cloud planner returned too many analysis plans");
  const catalog = getAnalysisCatalog();
  const allowed = allowedDatasets(workspaces);
  return value.analysisPlans.map((candidate: unknown) => {
    const plan = aiCloudAnalysisPlanSchema.parse(candidate);
    return validateCloudPlan(plan, catalog, allowed);
  });
}

function validateCloudPlan(
  plan: AiCloudAnalysisPlan,
  catalog: AnalysisCatalog,
  allowed: Set<string>,
) {
  if (plan.catalogVersion !== catalog.version)
    throw new Error("Cloud analysis catalog version is stale");
  if (!allowed.has(plan.datasetId))
    throw new Error(
      "Cloud analysis plan is outside the trusted workspace scope",
    );
  compileVisualAnalysis(plan);
  return plan;
}

function trustedPredicates(
  plan: AiCloudAnalysisPlan,
  scope: CloudAnalysisTrustedScope,
  existingValueCount: number,
) {
  const alias = plan.joins.length ? "analysis_base." : "";
  const predicates: string[] = [];
  const values: unknown[] = [];
  const push = (sql: string, value: unknown) => {
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
  const dateFields: Record<string, string | undefined> = {
    transactions: "transaction_date",
    holdings: "event_date",
    "cash-flows": "cash_flow_date",
  };
  const dateField = dateFields[plan.datasetId];
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

function injectPredicates(sql: string, predicates: string[]) {
  if (!predicates.length) return sql;
  const boundary = sql.search(/\n(?:GROUP BY|ORDER BY|LIMIT)\b/);
  const head = boundary < 0 ? sql : sql.slice(0, boundary);
  const tail = boundary < 0 ? "" : sql.slice(boundary);
  return `${head}${/\nWHERE\b/.test(head) ? " AND " : "\nWHERE "}${predicates.join(" AND ")}${tail}`;
}

export async function executeCloudAnalysisPlan(
  candidate: unknown,
  trustedScope: CloudAnalysisTrustedScope,
  {
    execute = executeAnalysisSql,
    requestId,
  }: {
    execute?: (request: AnalysisSqlRequest) => Promise<AnalysisSqlResult>;
    requestId?: string;
  } = {},
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
    inputComplete:
      result.window?.kind === "page" &&
      result.window.hasMore === false &&
      (result.window.offset || 0) === 0,
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
