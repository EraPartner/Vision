/** Complete-source pivot levels. Every subtotal re-aggregates the original source. */
import {
  executeFinancialAnalysis,
  isFinancialAnalysisDataset,
} from "./analysisFinancialDatasets.ts";
import type { FinancialAnalysisDeps } from "./analysisFinancialDatasets.ts";
import Decimal from "decimal.js";
import { compileVisualAnalysis } from "./analysisCatalog.ts";
import type {
  CompiledVisualAnalysis,
  VisualAnalysisFilter,
  VisualAnalysisPlan,
} from "./analysisCatalog.ts";
import { executeAnalysisSql } from "./analysisExecutor.ts";
import type {
  AnalysisSqlRequest,
  AnalysisSqlResult,
} from "./analysisExecutor.ts";
import type { AnalysisColumn } from "./analysisExtensions.ts";
import type { FormulaRow } from "./analysisFormulaEngine.ts";

export interface AnalysisPivotRequest {
  plan: VisualAnalysisPlan;
  config?: {
    rows?: string[];
    columns?: string[];
    values?: string[];
    filters?: VisualAnalysisFilter[];
  };
  requestId?: string;
}

export interface AnalysisPivotDependencies {
  execute?: (request: AnalysisSqlRequest) => Promise<AnalysisSqlResult>;
  catalog?: { fields: Array<{ id: string }> };
  financialDeps?: FinancialAnalysisDeps;
}

interface PivotLevel {
  rowDepth: number;
  columnDepth: number;
  groups: string[];
  rows: FormulaRow[];
  columns: AnalysisColumn[];
}

/** Result cells are numeric strings or numbers; Decimal rejects anything else. */
const cellDecimal = (value: unknown) => new Decimal(value as Decimal.Value);

export async function executeAnalysisPivot(
  { plan, config, requestId }: AnalysisPivotRequest,
  dependencies: AnalysisPivotDependencies = {},
) {
  const execute = dependencies.execute || executeAnalysisSql;
  const rows = [...new Set(config?.rows || [])];
  const columns = [...new Set(config?.columns || [])];
  const measures = [...new Set(config?.values || plan?.measures || [])];
  if (
    rows.length > 3 ||
    columns.length > 3 ||
    !measures.length ||
    measures.length > 8
  )
    throw new Error(
      "Pivot permits up to three row/column levels and eight measures",
    );
  if (rows.some((id) => columns.includes(id)))
    throw new Error("Pivot axes must be distinct");
  const filters = [...(plan.filters || []), ...(config?.filters || [])];
  const partitions: string[] = [];
  const catalog = dependencies.catalog;
  // Currency and instrument stay present at every subtotal level.
  if (
    !filters.some((f) => f.fieldId === "currency" && f.operator === "eq") &&
    (plan.datasetId !== "accounts" ||
      [...rows, ...columns].includes("currency"))
  )
    partitions.push("currency");
  if (
    ((plan.datasetId === "holdings" && measures.includes("sum_units")) ||
      (["positions", "cost-basis"].includes(plan.datasetId) &&
        measures.some((id) => id.endsWith("_total_units")))) &&
    !filters.some((f) => f.fieldId === "investment_id" && f.operator === "eq")
  )
    partitions.push("investment_id");
  if (catalog && !catalog.fields.some((f) => f.id === "currency"))
    partitions.splice(partitions.indexOf("currency"), 1);
  if (!/^[A-Za-z0-9_-]{8,110}$/.test(requestId || ""))
    throw new Error("Invalid pivot request ID");
  const levels: PivotLevel[] = [];
  const compiledLevels: Array<{
    rowDepth: number;
    columnDepth: number;
    groups: string[];
    compiled: CompiledVisualAnalysis;
  }> = [];
  const sourceCache: NonNullable<FinancialAnalysisDeps["sourceCache"]> =
    new Map();
  const financial = isFinancialAnalysisDataset(plan.datasetId);
  let totalRows = 0;
  let unavailableRows = 0;
  let financialComplete = true;
  for (let r = 0; r <= rows.length; r++) {
    for (let c = 0; c <= columns.length; c++) {
      const groups = [
        ...new Set([
          ...rows.slice(0, r),
          ...columns.slice(0, c),
          ...partitions,
        ]),
      ];
      const levelPlan = {
        ...plan,
        filters,
        groups,
        fields: groups,
        measures,
        orderBy: [],
        limit: 1000,
      };
      const compiled = compileVisualAnalysis(levelPlan);
      if (!financial) {
        compiledLevels.push({ rowDepth: r, columnDepth: c, groups, compiled });
        continue;
      }
      const result = await executeFinancialAnalysis(levelPlan, {
        requestId: `${requestId}-${r}-${c}`,
        limit: 1000,
        offset: 0,
        deps: { ...dependencies.financialDeps, sourceCache },
      });
      if (
        result.window.kind !== "page" ||
        result.window.hasMore ||
        result.window.offset
      )
        throw new Error(
          "Pivot exceeds the complete-output limit; narrow its filters",
        );
      financialComplete &&= result.coverage?.status !== "partial";
      unavailableRows = Math.max(
        unavailableRows,
        result.coverage?.unavailableRows || 0,
      );
      totalRows += result.rows.length;
      if (totalRows > 4000)
        throw new Error(
          "Pivot exceeds 4,000 rows across its hierarchy; narrow its filters",
        );
      levels.push({
        rowDepth: r,
        columnDepth: c,
        groups,
        rows: result.rows,
        columns: result.declaredColumns || compiled.columns,
      });
    }
  }
  if (!financial) {
    const fields = [...new Set([...rows, ...columns, ...partitions])];
    const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;
    const sqlTypes: Record<string, string> = {
      date: "date",
      datetime: "timestamptz",
      integer: "bigint",
      decimal: "numeric",
      boolean: "boolean",
    };
    // Explicit types prevent earlier all-NULL UNION branches resolving dates/numbers as text.
    const nullType = (id: string) => {
      const column = compiledLevels
        .flatMap((level) => level.compiled.columns)
        .find((column) => column.id === id);
      return (column && sqlTypes[column.type]) || "text";
    };
    const sql = compiledLevels
      .map((level) => {
        const selected = [
          ...fields.map((id) =>
            level.groups.includes(id)
              ? quote(id)
              : `NULL::${nullType(id)} AS ${quote(id)}`,
          ),
          ...measures.map(quote),
          `${level.rowDepth} AS "__row_depth"`,
          `${level.columnDepth} AS "__column_depth"`,
        ];
        return `SELECT ${selected.join(", ")} FROM (${level.compiled.sql}) AS pivot_level`;
      })
      .join(" UNION ALL ");
    const result = await execute({
      requestId,
      sql,
      values: compiledLevels[0].compiled.values,
      datasetIds: compiledLevels[0].compiled.datasetIds,
      limit: 1000,
      offset: 0,
    });
    if (
      result.window.kind !== "page" ||
      result.window.hasMore ||
      result.window.offset
    )
      throw new Error(
        "Pivot exceeds the complete-output limit; narrow its filters",
      );
    totalRows = result.rows.length;
    for (const level of compiledLevels)
      levels.push({
        rowDepth: level.rowDepth,
        columnDepth: level.columnDepth,
        groups: level.groups,
        columns: level.compiled.columns,
        rows: result.rows
          .filter(
            (row) =>
              Number(row.__row_depth) === level.rowDepth &&
              Number(row.__column_depth) === level.columnDepth,
          )
          .map((row) =>
            Object.fromEntries(
              [...level.groups, ...measures].map((id) => [id, row[id]]),
            ),
          ),
      });
  }
  const totals = levels[0].rows;
  for (const level of levels) {
    level.rows = level.rows.map((row) => {
      const total = totals.find((candidate) =>
        partitions.every((id) => candidate[id] === row[id]),
      );
      const percentages: Record<string, string | null> = {};
      for (const id of measures) {
        const denominator = total?.[id];
        percentages[id] =
          row[id] == null ||
          denominator == null ||
          cellDecimal(denominator).isZero()
            ? null
            : cellDecimal(row[id]).div(cellDecimal(denominator)).toString();
      }
      return { ...row, __percentages: percentages };
    });
  }
  return {
    levels,
    partitions,
    config: { rows, columns, values: measures, filters: config?.filters || [] },
    coverage: {
      complete: financialComplete,
      financialComplete,
      unavailableRows,
      rows: totalRows,
      population: "complete filtered source",
      maxRows: financial ? 4000 : 1000,
      snapshot: financial
        ? "one canonical source snapshot"
        : "one PostgreSQL statement",
    },
  };
}
