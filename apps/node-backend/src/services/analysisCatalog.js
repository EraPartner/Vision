/** Allowlisted analysis fields, dimensions, measures, joins, and SQL compiler. */

const DATASETS = {
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
      sum_amount: ["Net amount", "decimal", "SUM(amount)"],
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
      sum_amount: ["Net event amount", "decimal", "SUM(amount)"],
      sum_units: ["Net units", "decimal", "SUM(units)"],
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
      sum_spending: ["Spending", "decimal", "SUM(spending_amount)"],
      sum_positive_flow: [
        "Income and refunds",
        "decimal",
        "SUM(positive_flow_amount)",
      ],
      sum_amount: ["Net cash flow", "decimal", "SUM(signed_amount)"],
    },
    joins: ["cash-flows.account"],
  },
};

const OPERATORS = {
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

const quoteIdent = (value) => `"${value.replace(/"/g, '""')}"`;

export function getAnalysisCatalog() {
  return {
    version: 1,
    datasets: Object.entries(DATASETS).map(([id, dataset]) => ({
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
  };
}

function selectedField(dataset, id) {
  const field = dataset.fields[id];
  if (!field) throw new Error(`Unsupported analysis field: ${id}`);
  return field;
}

function fieldExpression(dataset, id, joined) {
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
    /date_trunc\('month',\s*([a-z_][a-z0-9_]*)\)/i,
    "date_trunc('month', analysis_base.$1)",
  );
}

export function compileVisualAnalysis(plan) {
  const dataset = DATASETS[plan?.datasetId];
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
  const selected = [];
  const columns = [];
  for (const id of fields) {
    const field = selectedField(dataset, id);
    selected.push(
      `${fieldExpression(dataset, id, joined)} AS ${quoteIdent(id)}`,
    );
    columns.push({ id, label: field[0], type: field[1], nullable: true });
  }
  for (const id of measures) {
    const measure = dataset.measures[id];
    if (!measure) throw new Error(`Unsupported analysis measure: ${id}`);
    selected.push(`${measure[2]} AS ${quoteIdent(id)}`);
    columns.push({ id, label: measure[0], type: measure[1], nullable: false });
  }
  if (measures.length && groups.some((id) => !fields.includes(id))) {
    throw new Error("Every group must also be a selected field");
  }
  if (measures.length && fields.some((id) => !groups.includes(id))) {
    throw new Error(
      "Selected fields must be grouped when measures are present",
    );
  }

  const values = [];
  const where = [];
  for (const filter of plan.filters ?? []) {
    selectedField(dataset, filter.fieldId);
    const operator = OPERATORS[filter.operator];
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

  const groupSql = measures.length
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
  }${groupSql}${orderSql}\nLIMIT ${limit}`;

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
