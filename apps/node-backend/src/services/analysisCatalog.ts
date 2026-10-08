/** Allowlisted analysis fields, dimensions, measures, joins, and SQL compiler. */

import {
  FINANCIAL_ANALYSIS_DATASETS,
  isFinancialAnalysisDataset,
} from "./analysisFinancialDatasets.ts";
import type { FinancialAnalysisPlan } from "./analysisFinancialDatasets.ts";
import type { FormulaUnit } from "./analysisFormulaEngine.ts";

/** [label, value type, SQL expression, optional "currency" money marker] */
type CatalogEntry = [string, string, string, string?];

interface CatalogDataset {
  relation: string;
  label: string;
  primaryKey: string;
  fields: Record<string, CatalogEntry>;
  measures: Record<string, CatalogEntry>;
  joins: string[];
}

export interface VisualAnalysisFilter {
  fieldId: string;
  operator: string;
  value?: unknown;
}

export interface VisualAnalysisPlan extends Omit<
  FinancialAnalysisPlan,
  "joins" | "filters" | "orderBy"
> {
  joins?: string[];
  filters?: VisualAnalysisFilter[];
  orderBy?: Array<{ id: string; direction: string }>;
  generatedSql?: string;
}

export interface CompiledAnalysisColumn {
  id: string;
  label: string;
  type: string;
  nullable: boolean;
  unit?: FormulaUnit;
  temporalKind?: string;
  aggregation?: string;
  requiredTimeGroups?: string[];
}

export interface CompiledVisualAnalysis {
  sql: string;
  values: unknown[];
  datasetIds: string[];
  columns: CompiledAnalysisColumn[];
  primaryKey?: string;
  visualPlan: VisualAnalysisPlan & {
    fields: string[];
    groups: string[];
    measures: string[];
    joins: string[];
    limit: number;
  };
}

const DATASETS: Record<string, CatalogDataset> = {
  transactions: {
    relation: "vision_analysis.transactions_v2",
    label: "Transactions",
    primaryKey: "transaction_id",
    fields: {
      transaction_id: ["Transaction ID", "integer", "transaction_id"],
      transaction_date: ["Date", "date", "transaction_date"],
      month: ["Month", "date", "date_trunc('month', transaction_date)::date"],
      amount: ["Amount", "decimal", "amount"],
      currency: ["Currency", "currency", "currency"],
      account_id: ["Account ID", "integer", "account_id"],
      account_name: ["Account", "string", "account_name"],
      recipient_name: ["Recipient", "string", "recipient_name"],
      category_general: ["Category", "string", "category_general"],
      category_detail: ["Category detail", "string", "category_detail"],
      category_path: ["Category path", "string", "category_path"],
      category_path_segments: [
        "Category path segments",
        "string[]",
        "category_path_segments",
      ],
      category_path_ids: [
        "Category path IDs",
        "integer[]",
        "category_path_ids",
      ],
      memo: ["Memo", "string", "memo"],
      comment: ["Comment", "string", "comment"],
      is_transfer: ["Transfer", "boolean", "is_transfer"],
      is_active: ["Active", "boolean", "is_active"],
      "account.display_name": [
        "Account display name",
        "string",
        "analysis_account.display_name",
      ],
      "account.institution": [
        "Account institution",
        "string",
        "analysis_account.institution",
      ],
    },
    measures: {
      count: ["Transaction count", "integer", "COUNT(*)"],
      sum_amount: ["Net amount", "decimal", "SUM(amount)", "currency"],
    },
    joins: ["transactions.account"],
  },
  accounts: {
    relation: "vision_analysis.accounts_v1",
    label: "Accounts",
    primaryKey: "account_id",
    fields: {
      account_id: ["Account ID", "integer", "account_id"],
      account_name: ["Account", "string", "account_name"],
      display_name: ["Display name", "string", "display_name"],
      institution: ["Institution", "string", "institution"],
      currency: ["Currency", "currency", "currency"],
      account_type: ["Account type", "string", "account_type"],
      owner: ["Owner", "string", "owner"],
      is_active: ["Active", "boolean", "is_active"],
    },
    measures: { count: ["Account count", "integer", "COUNT(*)"] },
    joins: [],
  },
  holdings: {
    relation: "vision_analysis.holding_events_v1",
    label: "Holding events",
    primaryKey: "event_id",
    fields: {
      event_id: ["Event ID", "integer", "event_id"],
      event_date: ["Date", "date", "event_date"],
      month: ["Month", "date", "date_trunc('month', event_date)::date"],
      investment_id: ["Investment ID", "integer", "investment_id"],
      investment_name: ["Investment", "string", "investment_name"],
      symbol: ["Symbol", "string", "symbol"],
      asset_class: ["Asset class", "string", "asset_class"],
      account_id: ["Account ID", "integer", "account_id"],
      account_name: ["Account", "string", "account_name"],
      event_type: ["Event type", "string", "event_type"],
      amount: ["Amount", "decimal", "amount"],
      units: ["Units", "decimal", "units"],
      currency: ["Currency", "currency", "currency"],
      "account.display_name": [
        "Account display name",
        "string",
        "analysis_account.display_name",
      ],
      "account.institution": [
        "Account institution",
        "string",
        "analysis_account.institution",
      ],
    },
    measures: {
      count: ["Event count", "integer", "COUNT(*)"],
      sum_amount: [
        "Raw event amount total",
        "decimal",
        "SUM(amount)",
        "currency",
      ],
      sum_units: ["Raw event units total", "decimal", "SUM(units)"],
    },
    joins: ["holdings.account"],
  },
  "cash-flows": {
    relation: "vision_analysis.cash_flows_v2",
    label: "Cash flows",
    primaryKey: "cash_flow_id",
    fields: {
      cash_flow_id: ["Cash-flow ID", "integer", "cash_flow_id"],
      cash_flow_date: ["Date", "date", "cash_flow_date"],
      month: ["Month", "date", "date_trunc('month', cash_flow_date)::date"],
      account_id: ["Account ID", "integer", "account_id"],
      account_name: ["Account", "string", "account_name"],
      currency: ["Currency", "currency", "currency"],
      signed_amount: ["Signed amount", "decimal", "signed_amount"],
      spending_amount: ["Spending", "decimal", "spending_amount"],
      positive_flow_amount: [
        "Income and refunds",
        "decimal",
        "positive_flow_amount",
      ],
      flow_type: ["Flow type", "string", "flow_type"],
      is_transfer: ["Transfer", "boolean", "is_transfer"],
      recipient_name: ["Recipient", "string", "recipient_name"],
      category_general: ["Category", "string", "category_general"],
      category_detail: ["Category detail", "string", "category_detail"],
      category_path: ["Category path", "string", "category_path"],
      category_path_segments: [
        "Category path segments",
        "string[]",
        "category_path_segments",
      ],
      category_path_ids: [
        "Category path IDs",
        "integer[]",
        "category_path_ids",
      ],
      is_active: ["Active", "boolean", "is_active"],
      "account.display_name": [
        "Account display name",
        "string",
        "analysis_account.display_name",
      ],
      "account.institution": [
        "Account institution",
        "string",
        "analysis_account.institution",
      ],
    },
    measures: {
      count: ["Cash-flow count", "integer", "COUNT(*)"],
      sum_spending: ["Spending", "decimal", "SUM(spending_amount)", "currency"],
      sum_positive_flow: [
        "Income and refunds",
        "decimal",
        "SUM(positive_flow_amount)",
        "currency",
      ],
      sum_amount: [
        "Net cash flow",
        "decimal",
        "SUM(signed_amount)",
        "currency",
      ],
    },
    joins: ["cash-flows.account"],
  },
};

for (const dataset of Object.values(DATASETS)) {
  const dateField = Object.keys(dataset.fields).find((id) =>
    id.endsWith("_date"),
  );
  if (dateField)
    for (const bucket of ["day", "week", "quarter", "year"]) {
      dataset.fields[bucket] = [
        bucket[0].toUpperCase() + bucket.slice(1),
        "date",
        `date_trunc('${bucket}', ${dateField})::date`,
      ];
    }
}

const OPERATORS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  contains: "ILIKE",
  "starts-with": "ILIKE",
  "is-null": "IS NULL",
  "is-not-null": "IS NOT NULL",
};

const quoteIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;

export function getAnalysisCatalog() {
  return {
    version: 1,
    datasets: [
      ...Object.entries(DATASETS).map(([id, dataset]) => ({
        id,
        label: dataset.label,
        relation: dataset.relation,
        fields: Object.entries(dataset.fields).map(([fieldId, field]) => ({
          id: fieldId,
          label: field[0],
          type: field[1],
        })),
        measures: Object.entries(dataset.measures).map(
          ([measureId, measure]) => ({
            id: measureId,
            label: measure[0],
            type: measure[1],
          }),
        ),
        joins: dataset.joins.map((id) => ({
          id,
          datasetId: "accounts",
          cardinality: "many-to-one",
          duplicationSafe: true,
        })),
      })),
      ...FINANCIAL_ANALYSIS_DATASETS,
    ],
  };
}

// Plan ids come from the request: look up own keys only, so "toString" or
// "constructor" cannot resolve to an Object.prototype member.
function own<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

function selectedField(dataset: CatalogDataset, id: string) {
  const field = own(dataset.fields, id);
  if (!field) throw new Error(`Unsupported analysis field: ${id}`);
  return field;
}

function fieldExpression(dataset: CatalogDataset, id: string, joined: boolean) {
  const expression = selectedField(dataset, id)[2];
  if (expression.startsWith("analysis_account.")) {
    if (!joined)
      throw new Error(`Field ${id} requires the validated account join`);
    return expression;
  }
  if (!joined) return expression;
  if (/^[a-z_][a-z0-9_]*$/i.test(expression))
    return `analysis_base.${expression}`;
  return expression.replace(
    /date_trunc\('(day|week|month|quarter|year)',\s*([a-z_][a-z0-9_]*)\)/i,
    "date_trunc('$1', analysis_base.$2)",
  );
}

export function compileVisualAnalysis(
  plan: VisualAnalysisPlan,
): CompiledVisualAnalysis {
  if (isFinancialAnalysisDataset(plan?.datasetId)) {
    // Every financial dataset id has a descriptor.
    const descriptor = FINANCIAL_ANALYSIS_DATASETS.find(
      (d) => d.id === plan.datasetId,
    )!;
    const fields = [...new Set(plan.fields || [])],
      measures = [...new Set(plan.measures || [])];
    const available = [...descriptor.fields, ...descriptor.measures];
    const columns = [...fields, ...measures].map((id) => {
      const column = available.find((c) => c.id === id);
      if (!column) throw new Error(`Unsupported analysis output: ${id}`);
      const unit: FormulaUnit | undefined =
        column.unit?.kind === "money" &&
        !["benchmark-history", "fx-history"].includes(plan.datasetId)
          ? { kind: "money", currency: plan.reportingCurrency || "EUR" }
          : column.unit;
      return { ...column, nullable: true, ...(unit ? { unit } : {}) };
    });
    if (!columns.length)
      throw new Error("Select at least one field or measure");
    return {
      sql: "/* Canonical financial service; SQL execution is unavailable */",
      values: [],
      datasetIds: [plan.datasetId],
      columns,
      visualPlan: {
        ...plan,
        fields,
        measures,
        groups: plan.groups || [],
        joins: [],
        limit: Math.min(plan.limit || 500, 1000),
      },
    };
  }
  const dataset = own(DATASETS, plan?.datasetId);
  if (!dataset)
    throw new Error(`Unsupported analysis dataset: ${plan?.datasetId}`);
  const fields = [...new Set(plan.fields ?? [])];
  const groups = [...new Set(plan.groups ?? [])];
  const measures = [...new Set(plan.measures ?? [])];
  const joins = [...new Set(plan.joins ?? [])];
  for (const join of joins) {
    if (!dataset.joins.includes(join)) {
      throw new Error(`Unsupported or duplication-unsafe join: ${join}`);
    }
  }
  const joined = joins.length > 0;
  if (fields.length + measures.length === 0) {
    throw new Error("Select at least one field or measure");
  }
  const selected: string[] = [];
  const columns: CompiledAnalysisColumn[] = [];
  for (const id of fields) {
    const field = selectedField(dataset, id);
    selected.push(
      `${fieldExpression(dataset, id, joined)} AS ${quoteIdent(id)}`,
    );
    const fixedCurrency = (plan.filters || []).find(
      (f) => f.fieldId === "currency" && f.operator === "eq",
    )?.value;
    const investment = (plan.filters || []).find(
      (f) => f.fieldId === "investment_id" && f.operator === "eq",
    )?.value;
    const unit: FormulaUnit | undefined = [
      "amount",
      "signed_amount",
      "spending_amount",
      "positive_flow_amount",
    ].includes(id)
      ? {
          kind: "money",
          ...(fixedCurrency
            ? { currency: fixedCurrency }
            : { currencyColumn: "currency" }),
        }
      : id === "units"
        ? {
            kind: "quantity",
            ...(investment
              ? { instrumentId: String(investment) }
              : { instrumentColumn: "investment_id" }),
          }
        : undefined;
    columns.push({
      id,
      label: field[0],
      type: field[1],
      nullable: true,
      ...(unit ? { unit } : {}),
    });
  }
  for (const id of measures) {
    const measure = own(dataset.measures, id);
    if (!measure) throw new Error(`Unsupported analysis measure: ${id}`);
    selected.push(`${measure[2]} AS ${quoteIdent(id)}`);
    const currency = (plan.filters || []).find(
      (f) => f.fieldId === "currency" && f.operator === "eq",
    )?.value;
    columns.push({
      id,
      label: measure[0],
      type: measure[1],
      nullable: false,
      ...(measure[3] === "currency"
        ? {
            unit: {
              kind: "money",
              ...(currency ? { currency } : { currencyColumn: "currency" }),
            },
          }
        : id === "count"
          ? { unit: { kind: "count" } }
          : id === "sum_units"
            ? {
                unit: {
                  kind: "quantity",
                  ...((plan.filters || []).find(
                    (f) => f.fieldId === "investment_id" && f.operator === "eq",
                  )?.value
                    ? {
                        // Guarded by the identical find above.
                        instrumentId: String(
                          (plan.filters || []).find(
                            (f) =>
                              f.fieldId === "investment_id" &&
                              f.operator === "eq",
                          )!.value,
                        ),
                      }
                    : { instrumentColumn: "investment_id" }),
                },
              }
            : {}),
    });
  }
  if (measures.length && groups.some((id) => !fields.includes(id))) {
    throw new Error("Every group must also be a selected field");
  }
  if (measures.length && fields.some((id) => !groups.includes(id))) {
    throw new Error(
      "Selected fields must be grouped when measures are present",
    );
  }

  const values: unknown[] = [];
  const where: string[] = [];
  for (const filter of plan.filters ?? []) {
    selectedField(dataset, filter.fieldId);
    const operator = own(OPERATORS, filter.operator);
    if (!operator)
      throw new Error(`Unsupported analysis filter: ${filter.operator}`);
    if (filter.operator === "is-null" || filter.operator === "is-not-null") {
      where.push(
        `${fieldExpression(dataset, filter.fieldId, joined)} ${operator}`,
      );
      continue;
    }
    if (
      filter.value === undefined ||
      filter.value === null ||
      filter.value === ""
    ) {
      throw new Error(`Filter ${filter.fieldId} requires a value`);
    }
    values.push(
      filter.operator === "contains"
        ? `%${filter.value}%`
        : filter.operator === "starts-with"
          ? `${filter.value}%`
          : filter.value,
    );
    where.push(
      `${fieldExpression(dataset, filter.fieldId, joined)} ${operator} $${values.length}`,
    );
  }

  // Native amounts have no common unit until currency is fixed or grouped.
  // All visual filters are joined with AND, so one equality is sufficient.
  const hasMoneyMeasure = measures.some(
    (id) => dataset.measures[id][3] === "currency",
  );
  const hasSingleCurrencyFilter = (plan.filters ?? []).some(
    (filter) =>
      filter.fieldId === "currency" &&
      filter.operator === "eq" &&
      typeof filter.value === "string" &&
      /^[A-Z]{3}$/.test(filter.value),
  );
  if (
    hasMoneyMeasure &&
    !groups.includes("currency") &&
    !hasSingleCurrencyFilter
  ) {
    throw new Error(
      "Money measures require grouping by currency or an equality filter for one currency",
    );
  }

  const hasSingleInvestmentFilter = (plan.filters ?? []).some(
    (filter) =>
      filter.fieldId === "investment_id" &&
      filter.operator === "eq" &&
      ((typeof filter.value === "number" &&
        Number.isSafeInteger(filter.value) &&
        filter.value > 0) ||
        (typeof filter.value === "string" &&
          /^[1-9][0-9]*$/.test(filter.value))),
  );
  if (
    plan.datasetId === "holdings" &&
    measures.includes("sum_units") &&
    !groups.includes("investment_id") &&
    !hasSingleInvestmentFilter
  ) {
    throw new Error(
      "Event units totals require grouping by investment_id or an equality filter for one investment",
    );
  }

  const groupSql =
    measures.length && groups.length
      ? `\nGROUP BY ${groups.map((id) => fieldExpression(dataset, id, joined)).join(", ")}`
      : "";
  const allowedOutputs = new Set([...fields, ...measures]);
  const order = (plan.orderBy ?? []).map(({ id, direction }) => {
    if (!allowedOutputs.has(id))
      throw new Error(`Unsupported sort output: ${id}`);
    return `${quoteIdent(id)} ${direction === "desc" ? "DESC" : "ASC"}`;
  });
  const orderSql = order.length ? `\nORDER BY ${order.join(", ")}` : "";
  const limit = Math.min(Math.max(Number(plan.limit) || 500, 1), 1000);
  const fromSql = joined
    ? `${dataset.relation} AS analysis_base LEFT JOIN vision_analysis.accounts_v1 AS analysis_account ON analysis_account.account_id = analysis_base.account_id`
    : dataset.relation;
  const sql = `SELECT ${selected.join(", ")}\nFROM ${fromSql}${
    where.length ? `\nWHERE ${where.join(" AND ")}` : ""
  }${groupSql}${orderSql}`;

  return {
    sql,
    values,
    columns,
    datasetIds: [plan.datasetId, ...(joined ? ["accounts"] : [])],
    primaryKey: dataset.primaryKey,
    visualPlan: {
      ...plan,
      fields,
      groups,
      measures,
      joins,
      limit,
      generatedSql: sql,
    },
  };
}

export const APPROVED_ANALYSIS_RELATIONS = new Set([
  ...Object.values(DATASETS).map((dataset) => dataset.relation),
  // Existing saved analyses keep their immutable v1 SQL after the catalog
  // starts generating v2 paths for newly created analyses.
  "vision_analysis.transactions_v1",
  "vision_analysis.cash_flows_v1",
]);
