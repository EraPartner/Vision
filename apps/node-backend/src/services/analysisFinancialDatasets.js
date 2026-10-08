/** Bounded service datasets with canonical portfolio replay and stored FX only. */
import { query } from "../database/connection.ts";
import { buildInvestmentSummaryCorePartitioned } from "@vision/shared-utils/portfolio";
import { UNIT_BASED_ASSET_CLASSES } from "@vision/types/assetClasses";
import { toDecimal } from "../lib/money.ts";
import { findRateOnOrBeforeInIndex } from "./currency/rateFetcher.ts";
import { todayAppDateString } from "../lib/timezone.ts";

const MAX_ROWS = 100000;
const marketAssetClasses = new Set(UNIT_BASED_ASSET_CLASSES);
const positionFields = {
  investment_id: "integer",
  investment_name: "string",
  symbol: "string",
  asset_class: "string",
  currency: "currency",
  original_currency: "currency",
  total_units: "decimal",
  current_value: "decimal",
  total_invested: "decimal",
  avg_cost_basis: "decimal",
  realized_gain: "decimal",
  unrealized_gain: "decimal",
  gain_loss: "decimal",
  return_pct: "decimal",
  coverage: "string",
};
const historyFields = {
  date: "date",
  currency: "currency",
  value: "decimal",
  invested: "decimal",
  gain_loss: "decimal",
  return_pct: "decimal",
};
const definitions = {
  positions: ["Current positions", positionFields],
  "cost-basis": ["Current cost basis", positionFields],
  "portfolio-history": ["Portfolio valuation history", historyFields],
  "broker-history": [
    "Broker valuation history",
    {
      ...historyFields,
      account_key: "string",
      account_id: "integer",
      account_name: "string",
    },
  ],
  "fx-history": [
    "Stored dated exchange rates",
    { date: "date", currency: "currency", rate_to_eur: "decimal" },
  ],
  "benchmark-history": [
    "Benchmark price history",
    {
      date: "date",
      symbol: "string",
      currency: "currency",
      close: "decimal",
      return_pct: "decimal",
    },
  ],
};
const nonAdditive = new Set([
  "avg_cost_basis",
  "return_pct",
  "rate_to_eur",
  "close",
]);
/** @returns {{unit?: {kind:string,currencyParameterId?:string,currencyColumn?:string,instrumentColumn?:string,percentageBasis?:string},temporalKind?:string,aggregation?:string,requiredTimeGroups?:string[]}} */
function financialColumnMetadata(datasetId, field, type) {
  if (type !== "decimal") return {};
  const unit =
    field === "total_units"
      ? { kind: "quantity", instrumentColumn: "investment_id" }
      : field === "return_pct"
        ? { kind: "percentage", percentageBasis: "percent" }
        : field === "rate_to_eur"
          ? { kind: "percentage", percentageBasis: "ratio" }
          : datasetId === "benchmark-history"
            ? { kind: "money", currencyColumn: "currency" }
            : { kind: "money", currencyParameterId: "currency" };
  const stock =
    [
      "portfolio-history",
      "broker-history",
      "benchmark-history",
      "fx-history",
    ].includes(datasetId) &&
    [
      "value",
      "invested",
      "gain_loss",
      "return_pct",
      "close",
      "rate_to_eur",
    ].includes(field);
  return {
    unit,
    ...(stock
      ? {
          temporalKind: "stock",
          aggregation: "last",
          ...(datasetId === "broker-history"
            ? { requiredTimeGroups: ["account_key"] }
            : {}),
        }
      : {}),
  };
}
export const FINANCIAL_ANALYSIS_DATASETS = Object.entries(definitions).map(
  ([id, [label, fields]]) => ({
    id,
    label,
    relation: `service:${id}@1`,
    fields: Object.entries(fields).map(([field, type]) => ({
      id: field,
      label: field.replaceAll("_", " "),
      type,
      ...financialColumnMetadata(id, field, type),
    })),
    measures: [
      {
        id: "count",
        label: "Row count",
        type: "integer",
        ...financialColumnMetadata(id, "count", "integer"),
      },
      ...Object.entries(fields)
        .filter(([, type]) => type === "decimal")
        .flatMap(([field]) =>
          ["avg", "min", "max", ...(nonAdditive.has(field) ? [] : ["sum"])].map(
            (op) => ({
              id: `${op}_${field}`,
              label: `${op} ${field.replaceAll("_", " ")}`,
              type: "decimal",
              ...financialColumnMetadata(id, field, "decimal"),
            }),
          ),
        ),
    ],
    joins: [],
  }),
);
export const isFinancialAnalysisDataset = (id) =>
  Object.hasOwn(definitions, id);

/** Missing historical evidence never becomes a 1:1 estimate. */
const rateIndexes = new WeakMap();
function strictDatedConversion(amount, from, to, date, rateRows) {
  // Use the canonical on-or-before selector while retaining stored decimal rates.
  let index = rateIndexes.get(rateRows);
  if (!index) {
    index = new Map();
    for (const row of rateRows) {
      if (!index.has(row.currency_code)) index.set(row.currency_code, []);
      index
        .get(row.currency_code)
        .push({ date: row.rate_date, rate: row.rate_to_eur });
    }
    for (const entries of index.values())
      entries.sort((a, b) => a.date.localeCompare(b.date));
    rateIndexes.set(rateRows, index);
  }
  const rate = (code) => {
    const value = findRateOnOrBeforeInIndex(index, code, date);
    return value !== undefined && toDecimal(value).gt(0)
      ? toDecimal(value)
      : undefined;
  };
  if (from === to)
    return {
      value: toDecimal(amount).toString(),
      coverage: "complete",
      from,
      to,
      date,
    };
  const source = rate(from);
  const target = rate(to);
  return {
    value:
      source && target
        ? toDecimal(amount).times(source).div(target).toString()
        : null,
    coverage: source && target ? "complete" : "partial",
    from,
    to,
    date,
  };
}

async function localRows(plan, deps) {
  const run = deps.query ?? query;
  const bounded = async (sql, values = []) => {
    const rows = (await run(`${sql} LIMIT ${MAX_ROWS + 1}`, values)).rows;
    if (rows.length > MAX_ROWS)
      throw new Error("Financial dataset exceeds source row limit");
    return rows;
  };
  const currency = plan.reportingCurrency ?? "EUR";
  if (!/^[A-Z]{3}$/.test(currency))
    throw new Error("Reporting currency must be an uppercase currency code");
  const from = plan.from ?? "1900-01-01";
  const to = plan.to ?? todayAppDateString();
  if (
    ![from, to].every(
      (date) =>
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date,
    ) ||
    from > to
  )
    throw new Error("Invalid financial date range");
  if (plan.datasetId === "fx-history")
    return bounded(
      "SELECT to_char(rate_date,'YYYY-MM-DD') AS date, currency_code AS currency, rate_to_eur FROM exchange_rates WHERE rate_date BETWEEN $1 AND $2 ORDER BY rate_date,currency_code",
      [from, to],
    );
  if (plan.datasetId.endsWith("history")) {
    const broker = plan.datasetId === "broker-history";
    if (
      broker &&
      !(
        await run(
          "SELECT to_regclass('public.portfolio_broker_snapshots') AS relation",
        )
      ).rows[0]?.relation
    )
      return [];
    return bounded(
      `SELECT to_char(snapshot_date,'YYYY-MM-DD') AS date, currency, value, invested, gain_loss, ${broker ? "CASE WHEN invested <> 0 THEN gain_loss/invested*100 ELSE NULL END AS return_pct, account_key, account_id, account_name" : "return_pct"} FROM ${broker ? "portfolio_broker_snapshots" : "portfolio_performance_snapshots"} WHERE currency=$1 AND snapshot_date BETWEEN $2 AND $3 ORDER BY snapshot_date${broker ? ",account_key" : ""}`,
      [currency, from, to],
    );
  }
  if (plan.from || plan.to)
    throw new Error("Current positions cannot be valued at a historical date");
  const storedMethod = plan.costBasisMethod
    ? undefined
    : (
        await run("SELECT value FROM user_settings WHERE key=$1", [
          "cost_basis_method",
        ])
      ).rows[0]?.value;
  const costBasisMethod =
    plan.costBasisMethod ??
    (["weighted_avg", "fifo", "lifo"].includes(storedMethod)
      ? storedMethod
      : "weighted_avg");
  if (!["weighted_avg", "fifo", "lifo"].includes(costBasisMethod))
    throw new Error("Unsupported cost basis method");
  const [investments, events, rates] = await Promise.all([
    bounded(
      "SELECT id,name,symbol,asset_class,currency,current_price,interest_rate FROM investments WHERE is_active=true ORDER BY id",
    ),
    bounded(
      "SELECT p.id,p.investment_id,p.account_id,p.type,to_char(p.date,'YYYY-MM-DD') AS date,p.amount,p.units,p.fees,p.taxes,p.currency,p.fx_rate_to_eur FROM portfolio_transactions p JOIN investments i ON i.id=p.investment_id WHERE i.is_active=true ORDER BY p.date,p.id",
    ),
    bounded(
      "SELECT currency_code,to_char(rate_date,'YYYY-MM-DD') AS rate_date,rate_to_eur FROM exchange_rates ORDER BY rate_date,currency_code",
    ),
  ]);
  const eventsByInvestment = new Map();
  for (const row of events) {
    const id = Number(row.investment_id);
    if (!eventsByInvestment.has(id)) eventsByInvestment.set(id, []);
    eventsByInvestment.get(id).push(row);
  }
  return investments.map((inv) => {
    const native = inv.currency ?? "EUR";
    const today = todayAppDateString();
    const current = strictDatedConversion(1, native, currency, today, rates);
    let missing = current.value === null;
    const txns = (eventsByInvestment.get(Number(inv.id)) ?? []).map((row) => {
      const converted =
        row.currency === currency
          ? { value: "1" }
          : row.fx_rate_to_eur && toDecimal(row.fx_rate_to_eur).gt(0)
            ? strictDatedConversion(
                row.fx_rate_to_eur,
                "EUR",
                currency,
                row.date,
                rates,
              )
            : strictDatedConversion(
                1,
                row.currency ?? native,
                currency,
                row.date,
                rates,
              );
      missing ||= converted.value === null;
      return { ...row, fxMultiplier: converted.value ?? "1" };
    });
    const { core } = buildInvestmentSummaryCorePartitioned(inv, txns, {
      todayYmd: today,
      costBasisMethod,
      fxMultiplierNow: current.value ?? "1",
    });
    const cv = core.converted;
    const quoteMissing =
      marketAssetClasses.has(inv.asset_class) &&
      core.totalUnits.gt(0) &&
      (inv.current_price == null ||
        inv.current_price === "" ||
        !toDecimal(inv.current_price).isFinite());
    const valuationMissing = missing || quoteMissing;
    return {
      investment_id: Number(inv.id),
      investment_name: inv.name,
      symbol: inv.symbol,
      asset_class: inv.asset_class,
      currency,
      original_currency: native,
      total_units: core.totalUnits.toString(),
      current_value:
        current.value === null || quoteMissing
          ? null
          : cv.currentValue.toString(),
      total_invested: missing ? null : cv.totalInvested.toString(),
      avg_cost_basis: missing ? null : cv.avgCostBasis.toString(),
      realized_gain: missing ? null : cv.realizedGain.toString(),
      unrealized_gain: valuationMissing ? null : cv.unrealizedGain.toString(),
      gain_loss: valuationMissing ? null : cv.gainLoss.toString(),
      return_pct: valuationMissing ? null : cv.gainLossPercent.toString(),
      coverage: valuationMissing ? "partial" : "complete",
      missing_quote: quoteMissing,
      missing_fx: missing,
    };
  });
}

export async function executeFinancialAnalysis(plan, options = {}) {
  const startedAt = new Date().toISOString();
  if (
    options.requestId !== undefined &&
    !/^[A-Za-z0-9_-]{8,128}$/.test(options.requestId)
  )
    throw new Error("A valid request ID is required");
  if (
    options.offset !== undefined &&
    (!Number.isSafeInteger(options.offset) || options.offset < 0)
  )
    throw new Error("Financial offset must be a nonnegative integer");
  for (const date of [plan?.from, plan?.to].filter(
    (date) => date !== undefined,
  )) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    )
      throw new Error("Invalid financial date range");
  }
  if (plan?.from && plan?.to && plan.from > plan.to)
    throw new Error("Invalid financial date range");
  const descriptor = FINANCIAL_ANALYSIS_DATASETS.find(
    (d) => d.id === plan?.datasetId,
  );
  if (!descriptor) throw new Error("Unsupported financial analysis dataset");
  const deps = options.deps ?? {};
  const fields = [...new Set(plan.fields ?? [])];
  const groups = [...new Set(plan.groups ?? [])];
  const measures = [...new Set(plan.measures ?? [])];
  const fieldMap = new Map(descriptor.fields.map((f) => [f.id, f]));
  const measureMap = new Map(descriptor.measures.map((m) => [m.id, m]));
  if (!fields.length && !measures.length)
    throw new Error("Select a financial field or measure");
  if (
    (plan.joins ?? []).length ||
    fields.some((f) => !fieldMap.has(f)) ||
    groups.some((f) => !fields.includes(f)) ||
    measures.some((m) => !measureMap.has(m))
  )
    throw new Error("Unsupported financial field, measure or join");
  if (measures.length && fields.some((f) => !groups.includes(f)))
    throw new Error("Financial measure fields must be grouped");
  const filters = plan.filters ?? [];
  if (
    filters.some(
      (f) =>
        !["is-null", "is-not-null"].includes(f.operator) &&
        (f.value == null || f.value === ""),
    )
  )
    throw new Error("Financial filters require a value");
  for (const f of filters)
    if (
      !fieldMap.has(f.fieldId) ||
      ![
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
      ].includes(f.operator) ||
      (f.value != null &&
        !["string", "number", "boolean"].includes(typeof f.value))
    )
      throw new Error("Unsupported financial filter");
  if (
    measures.some((m) => m.endsWith("total_units")) &&
    !groups.includes("investment_id") &&
    !filters.some((f) => f.fieldId === "investment_id" && f.operator === "eq")
  )
    throw new Error("Units require one investment or investment grouping");
  if (
    plan.datasetId === "fx-history" &&
    measures.length &&
    !groups.includes("currency") &&
    !filters.some((f) => f.fieldId === "currency" && f.operator === "eq")
  )
    throw new Error("Exchange rates require currency partitions");
  let source;
  let provider;
  let benchmarkCurrency;
  const sourceKey = JSON.stringify({
    id: plan.datasetId,
    currency: plan.reportingCurrency,
    from: plan.from,
    to: plan.to,
    symbol: plan.symbol,
    range: plan.range,
    costBasisMethod: plan.costBasisMethod,
  });
  const cached = deps.sourceCache?.get(sourceKey);
  if (cached) ({ source, provider, benchmarkCurrency } = cached);
  else {
    if (plan.datasetId === "benchmark-history") {
      if (!/^[A-Za-z0-9^=._-]{1,40}$/.test(plan.symbol ?? ""))
        throw new Error("A benchmark symbol is required");
      if (
        !["1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max"].includes(
          plan.range ?? "1y",
        )
      )
        throw new Error("Unsupported benchmark range");
      const fetch =
        deps.fetchBenchmark ??
        (async (params) =>
          (
            await import("./research/researchAggregator.ts")
          ).researchAggregator.fetch("chart", params));
      const result = await fetch({
        symbol: plan.symbol,
        assetClass: "stock",
        range: plan.range ?? "1y",
      });
      provider = result.provider;
      benchmarkCurrency = result.data?.currency;
      const points = [...(result.data?.points ?? [])].sort(
        (a, b) => a.time - b.time,
      );
      if (points.length > MAX_ROWS)
        throw new Error("Benchmark exceeds source row limit");
      const selectedPoints = points.filter((p) => {
        const date = new Date(p.time).toISOString().slice(0, 10);
        return (
          (!plan.from || date >= plan.from) && (!plan.to || date <= plan.to)
        );
      });
      const first = selectedPoints.find(
        (p) => p.close != null && toDecimal(p.close).gt(0),
      );
      source = selectedPoints
        .map((p) => ({
          date: new Date(p.time).toISOString().slice(0, 10),
          symbol: plan.symbol,
          currency: benchmarkCurrency ?? null,
          close: p.close == null ? null : toDecimal(p.close).toString(),
          return_pct:
            !first || p.close == null
              ? null
              : toDecimal(p.close)
                  .div(first.close)
                  .minus(1)
                  .times(100)
                  .toString(),
        }))
        .filter(
          (row) =>
            (!plan.from || row.date >= plan.from) &&
            (!plan.to || row.date <= plan.to),
        );
    } else source = await localRows(plan, deps);
    deps.sourceCache?.set(sourceKey, { source, provider, benchmarkCurrency });
  }
  if (
    source.length > MAX_ROWS ||
    Buffer.byteLength(JSON.stringify(source)) > 20 * 1024 * 1024
  )
    throw new Error("Financial source exceeds resource limit");
  source = source.filter((row) =>
    filters.every((f) => {
      const value = row[f.fieldId];
      const target = f.value;
      if (f.operator === "is-null") return value == null;
      if (f.operator === "is-not-null") return value != null;
      if (value == null || target == null) return false;
      if (f.operator === "contains")
        return String(value)
          .toLowerCase()
          .includes(String(target).toLowerCase());
      if (f.operator === "starts-with")
        return String(value)
          .toLowerCase()
          .startsWith(String(target).toLowerCase());
      const compare = ["decimal", "integer"].includes(
        fieldMap.get(f.fieldId).type,
      )
        ? toDecimal(value).comparedTo(target)
        : String(value).localeCompare(String(target));
      return {
        eq: compare === 0,
        neq: compare !== 0,
        lt: compare < 0,
        lte: compare <= 0,
        gt: compare > 0,
        gte: compare >= 0,
      }[f.operator];
    }),
  );
  let rows;
  if (measures.length) {
    const buckets = new Map();
    for (const row of source) {
      const key = JSON.stringify(groups.map((f) => row[f]));
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
    if (!groups.length && !buckets.size) buckets.set("[]", []);
    rows = [...buckets.values()].map((bucket) =>
      Object.fromEntries([
        ...fields.map((f) => [f, bucket[0]?.[f] ?? null]),
        ...measures.map((m) => {
          if (m === "count") return [m, bucket.length];
          const [op, ...rest] = m.split("_");
          const field = rest.join("_");
          // Stocks close once per entity within a bucket; summing dated snapshots
          // would count the same holding repeatedly at subtotal levels.
          let contributors = bucket;
          if (fieldMap.get(field)?.aggregation === "last") {
            const closing = new Map();
            for (const row of bucket) {
              const key = JSON.stringify([
                row.currency,
                ...(plan.datasetId === "broker-history"
                  ? [row.account_key]
                  : []),
                ...(plan.datasetId === "benchmark-history" ? [row.symbol] : []),
              ]);
              const previous = closing.get(key);
              if (!previous || row.date >= previous.date) closing.set(key, row);
            }
            contributors = [...closing.values()];
          }
          const values = contributors.map((r) => r[field]);
          if (!values.length || values.some((v) => v == null)) return [m, null];
          const decimals = values.map((v) => toDecimal(v));
          let value = decimals[0];
          if (op === "sum" || op === "avg")
            value = decimals.reduce((sum, v) => sum.plus(v), toDecimal(0));
          if (op === "avg") value = value.div(decimals.length);
          if (op === "min")
            value = decimals.reduce((min, v) => (min.lt(v) ? min : v));
          if (op === "max")
            value = decimals.reduce((max, v) => (max.gt(v) ? max : v));
          return [m, value.toString()];
        }),
      ]),
    );
  } else
    rows = source.map((row) =>
      Object.fromEntries(fields.map((f) => [f, row[f] ?? null])),
    );
  const columns = [
    ...fields.map((f) => fieldMap.get(f)),
    ...measures.map((m) => measureMap.get(m)),
  ].map((f) => ({ ...f, nullable: true }));
  for (const sort of plan.orderBy ?? [])
    if (
      !columns.some((c) => c.id === sort.id) ||
      !["asc", "desc"].includes(sort.direction)
    )
      throw new Error("Unsupported financial sort");
  rows.sort((a, b) => {
    for (const sort of plan.orderBy ?? []) {
      const type = columns.find((c) => c.id === sort.id).type;
      const x = a[sort.id];
      const y = b[sort.id];
      const cmp =
        x == null
          ? y == null
            ? 0
            : 1
          : y == null
            ? -1
            : ["decimal", "integer"].includes(type)
              ? toDecimal(x).comparedTo(y)
              : String(x).localeCompare(String(y));
      if (cmp) return sort.direction === "desc" ? -cmp : cmp;
    }
    return 0;
  });
  const limit = Math.min(
    Math.max(Number(options.limit ?? plan.limit) || 500, 1),
    1000,
  );
  const offset = Math.max(Number(options.offset) || 0, 0);
  const totalRows = rows.length;
  rows = rows.slice(offset, offset + limit);
  if (Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024)
    throw new Error("Financial output exceeds 2 MiB; narrow the query");
  const selectedNumericFields = new Set([
    ...fields.filter((id) => fieldMap.get(id)?.type === "decimal"),
    ...measures
      .filter((id) => id !== "count")
      .map((id) => id.split("_").slice(1).join("_")),
    ...(plan.datasetId === "benchmark-history" ? ["close"] : []),
    ...(["portfolio-history", "broker-history"].includes(plan.datasetId)
      ? ["value"]
      : []),
    ...(plan.datasetId === "fx-history" ? ["rate_to_eur"] : []),
  ]);
  const unavailable = (row) =>
    row.coverage === "partial" ||
    [...selectedNumericFields].some((id) => row[id] == null);
  const partial =
    source.some(unavailable) ||
    (plan.datasetId.endsWith("history") && !source.length) ||
    (plan.datasetId === "benchmark-history" &&
      (!source.length || !benchmarkCurrency));
  const declaredColumns = columns.map((c) => ({
    ...c,
    ...(c.type === "decimal"
      ? {
          unit: c.id.includes("units")
            ? {
                kind: "quantity",
                ...(filters.some(
                  (f) => f.fieldId === "investment_id" && f.operator === "eq",
                )
                  ? {
                      instrumentId: String(
                        filters.find(
                          (f) =>
                            f.fieldId === "investment_id" &&
                            f.operator === "eq",
                        ).value,
                      ),
                    }
                  : { instrumentColumn: "investment_id" }),
              }
            : c.id.includes("return_pct")
              ? { kind: "percentage", percentageBasis: "percent" }
              : c.id.includes("rate_to_eur")
                ? { kind: "percentage", percentageBasis: "ratio" }
                : plan.datasetId === "benchmark-history" && !benchmarkCurrency
                  ? { kind: "money", currencyColumn: "currency" }
                  : {
                      kind: "money",
                      currency:
                        benchmarkCurrency ?? plan.reportingCurrency ?? "EUR",
                    },
        }
      : {}),
  }));
  return {
    requestId: options.requestId,
    startedAt,
    completedAt: new Date().toISOString(),
    byteLength: Buffer.byteLength(JSON.stringify(rows)),
    executor: "canonical-financial-v1",
    columns,
    declaredColumns,
    rows,
    window: {
      kind: "page",
      offset,
      limit,
      hasMore: offset + rows.length < totalRows,
      returnedRows: rows.length,
      totalRows,
    },
    coverage: {
      status: partial ? "partial" : "complete",
      sourceRows: source.length,
      unavailableRows: source.filter(unavailable).length,
      missingQuoteRows: source.filter((row) => row.missing_quote).length,
      missingRateRows: source.filter((row) => row.missing_fx).length,
    },
    provenance: {
      datasetId: plan.datasetId,
      schemaVersion: 1,
      engine: "canonical-portfolio-v1",
      reportingCurrency:
        plan.datasetId === "benchmark-history"
          ? (benchmarkCurrency ?? null)
          : (plan.reportingCurrency ?? "EUR"),
      methodology:
        plan.datasetId === "benchmark-history"
          ? "price-return from first positive close in selected date range; excludes dividend reinvestment"
          : "gain divided by invested capital; not time-weighted return",
      ...(provider ? { provider } : {}),
      coverageReasons: [
        ...new Set(
          source.flatMap((row) => [
            ...(row.missing_quote ? ["market-quote-missing"] : []),
            ...(row.missing_fx ? ["dated-exchange-rate-missing"] : []),
            ...(unavailable(row) && row.coverage !== "partial"
              ? ["financial-observation-missing"]
              : []),
          ]),
        ),
      ],
    },
  };
}

export { strictDatedConversion as __strictDatedConversion };
