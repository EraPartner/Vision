/** Bounded deterministic analysis operations. No operation writes ledger data. */
import Decimal from "decimal.js";
import { createHash } from "node:crypto";
import { evaluateAnalysisFormulas } from "./analysisFormulaEngine.ts";
import type {
  AnalysisFormulaInput,
  FormulaRow,
  FormulaUnit,
  FormulaUnitInput,
} from "./analysisFormulaEngine.ts";

/** A result column as carried through analysis pipelines. */
export interface AnalysisColumn {
  id: string;
  label?: string;
  type: string;
  nullable?: boolean;
  unit?: FormulaUnit;
  temporalKind?: string;
  aggregation?: string;
  requiredTimeGroups?: string[];
  calculationId?: string;
  calculationVersion?: string;
}

export interface AnalysisExtensionError {
  message: string;
  code?: string;
  formulaId?: string;
  stepIndex?: number;
  rowIndex?: number;
  columnId?: string;
  period?: string;
  combinationIndex?: number;
}

export type AnalysisLineageEntry = Record<string, unknown>;

export interface AnalysisExtensionCoverage {
  complete: boolean;
  returnedRows: number;
  missingPeriods?: number;
  combinations?: number;
}

export interface AnalysisExtensionResult {
  rows: FormulaRow[];
  columns: AnalysisColumn[];
  lineage: AnalysisLineageEntry[];
  coverage: AnalysisExtensionCoverage;
  errors: AnalysisExtensionError[];
}

interface PreparationInputTable {
  rows: FormulaRow[];
  columns: AnalysisColumn[];
}

interface PreparationStepBase {
  input?: PreparationInputTable;
}

export type PreparationStep =
  | (PreparationStepBase & {
      type: "convert";
      columnId: string;
      targetType: string;
      onError?: string;
    })
  | (PreparationStepBase & {
      type: "lookup" | "merge";
      input: PreparationInputTable;
      keys?: string[];
      inputKeys?: string[];
      resultColumn?: string;
      inputColumn?: string;
      columns?: Array<{ inputId: string; outputId: string }>;
      prefix?: string;
      requireMatch?: boolean;
    })
  | (PreparationStepBase & { type: "append"; input: PreparationInputTable })
  | (PreparationStepBase & {
      type: "calculate";
      formula: AnalysisFormulaInput;
      assumptions?: Record<string, unknown>;
    })
  | (PreparationStepBase & {
      type: "unpivot";
      columnIds?: string[];
      nameColumn?: string;
      valueColumn?: string;
    })
  | (PreparationStepBase & {
      type: "pivot";
      groupColumns?: string[];
      nameColumn: string;
      valueColumn: string;
      aggregate?: string;
    });

export interface PrepareAnalysisDataInput {
  rows: FormulaRow[];
  columns?: AnalysisColumn[];
  complete?: boolean;
  steps?: PreparationStep[];
}

export interface CompareAnalysisTimeInput {
  rows: FormulaRow[];
  columns?: AnalysisColumn[];
  complete?: boolean;
  dateColumn: string;
  valueColumns: string[];
  groupColumns?: string[];
  bucket?: string;
  missing?: string;
  rollingWindow?: number;
  aggregation?: string;
  from?: string;
  to?: string;
}

interface FormulaModelInput {
  rows: FormulaRow[];
  columns?: AnalysisColumn[];
  complete?: boolean;
  formulas?: AnalysisFormulaInput[];
  assumptions?: Record<string, unknown>;
  assumptionUnits?: Record<string, FormulaUnitInput>;
}

export interface RunAnalysisScenariosInput extends FormulaModelInput {
  scenarios?: Array<{
    id: string;
    name?: string;
    assumptions?: Record<string, unknown>;
  }>;
}

export interface BuildAnalysisSensitivityInput extends FormulaModelInput {
  outcomeId: string;
  variables?: Array<{ id: string; values: unknown[] }>;
}

export interface SeekAnalysisGoalInput extends FormulaModelInput {
  outcomeId: string;
  variableId: string;
  target: Decimal.Value;
  lower: Decimal.Value;
  upper: Decimal.Value;
  tolerance?: Decimal.Value;
  maxIterations?: number;
}

/** Untyped result cells go straight to Decimal, which rejects non-numeric input. */
const cellDecimal = (value: unknown) => new Decimal(value as Decimal.Value);
/** Callers first reject lists that contain a missing (null) contributor. */
const presentDecimals = (values: Array<Decimal | null>) => values as Decimal[];

const MAX_ROWS = 1000;
const MAX_COLUMNS = 128;
const MAX_BYTES = 2 * 1024 * 1024;
const numericTypes = new Set(["decimal", "integer"]);
const identifier = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "INVALID_ANALYSIS_EXTENSION",
  });
}
function bounded(rows: unknown, columns: AnalysisColumn[] = []) {
  if (
    !Array.isArray(rows) ||
    rows.length > MAX_ROWS ||
    columns.length > MAX_COLUMNS
  )
    fail("Analysis extensions allow at most 1000 rows and 128 columns");
  if (Buffer.byteLength(JSON.stringify(rows)) > MAX_BYTES)
    fail("Analysis extension output exceeds 2 MiB");
}
function population(complete: boolean) {
  if (!complete) fail("This operation requires the complete analysis result");
}
function field(columns: AnalysisColumn[], id: string | undefined) {
  const found = columns.find((column) => column.id === id);
  if (!found) fail(`Unknown analysis column: ${id}`);
  return found;
}
function newField(columns: AnalysisColumn[], id: string | undefined) {
  if (!identifier.test(id || "") || columns.some((column) => column.id === id))
    fail(`New column identifier is invalid or already exists: ${id}`);
}
function scalar(
  value: unknown,
  type: string,
): string | number | boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (type === "string" || type === "currency") return String(value);
  if (type === "boolean") {
    if (value === true || value === "true" || value === 1) return true;
    if (value === false || value === "false" || value === 0) return false;
    fail(`Cannot convert ${String(value)} to boolean`);
  }
  if (type === "date") {
    const raw = String(value);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
      new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw
    )
      fail(`Cannot convert ${raw} to date`);
    return raw;
  }
  if (numericTypes.has(type)) {
    const result = cellDecimal(value);
    if (!result.isFinite() || (type === "integer" && !result.isInteger()))
      fail(`Cannot convert ${String(value)} to ${type}`);
    if (type === "integer" && result.abs().gt(Number.MAX_SAFE_INTEGER))
      fail("Integer exceeds the safe integer range");
    return type === "integer" ? result.toNumber() : result.toFixed();
  }
  fail(`Unsupported conversion type: ${type}`);
}
function key(row: FormulaRow, ids: string[], columns: AnalysisColumn[]) {
  return JSON.stringify(
    ids.map((id) => {
      const type = field(columns, id).type;
      const value = scalar(row[id], type);
      return value == null
        ? null
        : numericTypes.has(type)
          ? new Decimal(String(value)).toString()
          : value;
    }),
  );
}
function requireUnits(
  rows: FormulaRow[],
  columns: AnalysisColumn[],
  groups: string[],
  measureIds: string[],
) {
  if (
    columns.some((column) => column.id === "currency") &&
    !groups.includes("currency") &&
    new Set(rows.map((row) => row.currency).filter(Boolean)).size > 1
  )
    fail("Aggregation requires currency separation");
  if (
    columns.some((column) => column.id === "investment_id") &&
    !groups.includes("investment_id") &&
    measureIds.some(
      (id) =>
        id.includes("units") || field(columns, id).unit?.kind === "quantity",
    ) &&
    new Set(
      rows.map((row) => row.investment_id).filter((value) => value != null),
    ).size > 1
  )
    fail("Unit quantities require investment separation");
  for (const id of measureIds) {
    const unit = field(columns, id).unit;
    if (unit?.kind === "money" && !unit.currency) {
      const scope = unit.currencyColumn || "currency";
      const values = rows.map((row) => row[scope]);
      if (
        values.some(
          (value) => typeof value !== "string" || !/^[A-Z]{3}$/.test(value),
        ) ||
        (!groups.includes(scope) && new Set(values).size !== 1)
      )
        fail("Money aggregation requires resolved currency provenance");
    }
    if (unit?.kind === "quantity" && !unit.instrumentId) {
      const scope = unit.instrumentColumn || "investment_id";
      const values = rows.map((row) => row[scope]);
      if (
        values.some((value) => value == null) ||
        (!groups.includes(scope) && new Set(values.map(String)).size !== 1)
      )
        fail(
          "Quantity aggregation requires one instrument or instrument grouping",
        );
    }
  }
}
function scopedColumn(
  column: AnalysisColumn,
  sourceRows: FormulaRow[],
  retainedColumns: string[],
): AnalysisColumn {
  const unit = column.unit;
  if (!unit) return column;
  if (unit.kind === "money" && !unit.currency) {
    const scope = unit.currencyColumn || "currency";
    if (retainedColumns.includes(scope)) return column;
    const values = sourceRows.map((row) => row[scope]);
    if (
      !values.length ||
      values.some(
        (value) => typeof value !== "string" || !/^[A-Z]{3}$/.test(value),
      ) ||
      new Set(values).size !== 1
    )
      fail("Output money unit cannot resolve its omitted currency scope");
    const {
      currencyColumn: _currencyColumn,
      currencyParameterId: _currencyParameterId,
      ...resolved
    } = unit;
    return { ...column, unit: { ...resolved, currency: values[0] } };
  }
  if (unit.kind === "quantity" && !unit.instrumentId) {
    const scope = unit.instrumentColumn || "investment_id";
    if (retainedColumns.includes(scope))
      return { ...column, unit: { ...unit, instrumentColumn: scope } };
    const values = sourceRows.map((row) => row[scope]);
    if (
      !values.length ||
      values.some((value) => value == null) ||
      new Set(values.map(String)).size !== 1
    )
      fail("Output quantity unit cannot resolve its omitted instrument scope");
    const { instrumentColumn: _instrumentColumn, ...resolved } = unit;
    return {
      ...column,
      unit: { ...resolved, instrumentId: String(values[0]) },
    };
  }
  return column;
}
function result(
  rows: FormulaRow[],
  columns: AnalysisColumn[],
  lineage: AnalysisLineageEntry[],
  coverage: Partial<AnalysisExtensionCoverage> = {},
  errors: AnalysisExtensionError[] = [],
): AnalysisExtensionResult {
  bounded(rows, columns);
  return {
    rows,
    columns,
    lineage,
    coverage: { complete: true, returnedRows: rows.length, ...coverage },
    errors,
  };
}

/** Steps: convert, lookup/merge, append, calculate, pivot, unpivot. Input tables carry columns/rows. */
export function prepareAnalysisData({
  rows,
  columns = [],
  complete = true,
  steps = [],
}: PrepareAnalysisDataInput): AnalysisExtensionResult {
  bounded(rows, columns);
  if (!Array.isArray(steps) || steps.length > 32)
    fail("At most 32 preparation steps are allowed");
  let data: FormulaRow[] = rows.map((row) => ({ ...row }));
  let schema: AnalysisColumn[] = columns.map((column) => ({ ...column }));
  const lineage: AnalysisLineageEntry[] = [];
  const errors: AnalysisExtensionError[] = [];
  for (const [index, step] of steps.entries()) {
    const before = data.length;
    const stepType: string = step.type;
    let unmatchedRows = 0;
    if (step.type === "convert") {
      field(schema, step.columnId);
      if (
        ![
          "string",
          "currency",
          "decimal",
          "integer",
          "date",
          "boolean",
        ].includes(step.targetType)
      )
        fail("Unsupported conversion type");
      data = data.map((row, rowIndex) => {
        try {
          return {
            ...row,
            [step.columnId]: scalar(row[step.columnId], step.targetType),
          };
        } catch (error) {
          if (step.onError !== "null") throw error;
          errors.push({
            stepIndex: index,
            rowIndex,
            columnId: step.columnId,
            // scalar() only throws Errors.
            message: (error as Error).message,
          });
          return { ...row, [step.columnId]: null };
        }
      });
      schema = schema.map((column) => {
        if (column.id !== step.columnId) return column;
        const { unit, ...rest } = column;
        return {
          ...rest,
          type: step.targetType,
          nullable: true,
          ...(step.targetType === "decimal" && unit ? { unit } : {}),
        };
      });
    } else if (step.type === "lookup" || step.type === "merge") {
      const input = step.input;
      bounded(input?.rows, input?.columns);
      // Single-key lookups name the columns; field() rejects a missing id.
      const left = step.keys || [step.resultColumn as string];
      const right = step.inputKeys || [step.inputColumn as string];
      if (!left.length || left.length !== right.length || left.length > 8)
        fail("Lookup requires one to eight corresponding keys");
      for (const [i, id] of left.entries()) {
        const a = field(schema, id);
        const b = field(input.columns, right[i]);
        if (
          a.type !== b.type &&
          !(numericTypes.has(a.type) && numericTypes.has(b.type))
        )
          fail("Lookup key types do not match");
      }
      const lookup = new Map<string, FormulaRow>();
      for (const row of input.rows) {
        if (right.some((id) => row[id] == null)) continue;
        const match = key(row, right, input.columns);
        if (lookup.has(match))
          fail("Lookup would multiply rows: duplicate input key");
        lookup.set(match, row);
      }
      const bindings =
        step.columns ||
        input.columns
          .filter((column) => !right.includes(column.id))
          .map((column) => ({
            inputId: column.id,
            outputId: `${step.prefix || "input"}.${column.id}`,
          }));
      const outputBindings = new Map(
        bindings.map((binding) => [binding.inputId, binding.outputId]),
      );
      for (const binding of bindings) {
        const sourceColumn = field(input.columns, binding.inputId);
        const unit: FormulaUnit | undefined = sourceColumn.unit
          ? { ...sourceColumn.unit }
          : undefined;
        for (const scope of ["currencyColumn", "instrumentColumn"] as const) {
          if (!unit?.[scope]) continue;
          const mapped = outputBindings.get(unit[scope]);
          if (!mapped)
            fail(`Lookup unit binding requires importing ${unit[scope]}`);
          unit[scope] = mapped;
        }
        newField(schema, binding.outputId);
        schema.push({
          ...field(input.columns, binding.inputId),
          id: binding.outputId,
          ...(unit ? { unit } : {}),
          nullable: true,
        });
      }
      data = data.map((row) => {
        const match = left.some((id) => row[id] == null)
          ? undefined
          : lookup.get(key(row, left, schema));
        if (!match) unmatchedRows++;
        return {
          ...row,
          ...Object.fromEntries(
            bindings.map((binding) => [
              binding.outputId,
              match?.[binding.inputId] ?? null,
            ]),
          ),
        };
      });
      if (step.requireMatch && unmatchedRows)
        fail(`Lookup has ${unmatchedRows} unmatched rows`);
    } else if (step.type === "append") {
      population(complete);
      bounded(step.input?.rows, step.input?.columns);
      if (
        schema.length !== step.input.columns.length ||
        schema.some(
          (column) =>
            field(step.input.columns, column.id).type !== column.type ||
            JSON.stringify(field(step.input.columns, column.id).unit) !==
              JSON.stringify(column.unit),
        )
      )
        fail("Append requires matching column identifiers and types");
      data = [
        ...data,
        ...step.input.rows.map((row) =>
          Object.fromEntries(
            schema.map((column) => [
              column.id,
              scalar(row[column.id], column.type),
            ]),
          ),
        ),
      ];
    } else if (step.type === "calculate") {
      newField(schema, step.formula?.id);
      if (step.formula?.scope !== "row")
        fail("Preparation calculations must have row scope");
      const calculated = evaluateAnalysisFormulas({
        rows: data,
        columns: schema,
        formulas: [step.formula],
        assumptions: step.assumptions || {},
        inputComplete: complete,
      });
      data = calculated.rows;
      errors.push(
        ...calculated.errors.map((error) => ({ stepIndex: index, ...error })),
      );
      schema.push({
        id: step.formula.id,
        label: step.formula.label || step.formula.id,
        type: step.formula.resultType || "decimal",
        nullable: true,
        ...(calculated.formulaUnits?.[step.formula.id]
          ? { unit: calculated.formulaUnits[step.formula.id] }
          : {}),
      });
    } else if (step.type === "unpivot") {
      population(complete);
      const ids = step.columnIds || [];
      if (!ids.length || new Set(ids).size !== ids.length)
        fail("Unpivot requires distinct value columns");
      if ((step.nameColumn || "variable") === (step.valueColumn || "value"))
        fail("Unpivot name and value columns must differ");
      const valueSchema = field(schema, ids[0]);
      if (
        ids.some(
          (id) =>
            field(schema, id).type !== valueSchema.type ||
            JSON.stringify(field(schema, id).unit) !==
              JSON.stringify(valueSchema.unit),
        )
      )
        fail("Unpivot value columns must have matching types and units");
      newField(schema, step.nameColumn || "variable");
      newField(schema, step.valueColumn || "value");
      data = data.flatMap((row) =>
        ids.map((id) => ({
          ...Object.fromEntries(
            Object.entries(row).filter(([name]) => !ids.includes(name)),
          ),
          [step.nameColumn || "variable"]: id,
          [step.valueColumn || "value"]: row[id] ?? null,
        })),
      );
      schema = [
        ...schema.filter((column) => !ids.includes(column.id)),
        {
          id: step.nameColumn || "variable",
          label: "Variable",
          type: "string",
        },
        { ...valueSchema, id: step.valueColumn || "value", label: "Value" },
      ];
    } else if (step.type === "pivot") {
      population(complete);
      const groups: string[] = step.groupColumns || [];
      groups.forEach((id) => field(schema, id));
      field(schema, step.nameColumn);
      const measure = field(schema, step.valueColumn);
      const isCount = step.aggregate === "count";
      if (!isCount) requireUnits(data, schema, groups, [step.valueColumn]);
      const scopedMeasure: AnalysisColumn = isCount
        ? { ...measure, type: "integer", unit: { kind: "count" } }
        : scopedColumn(measure, data, groups);
      if (
        !numericTypes.has(measure.type) ||
        !["sum", "count", "average", "min", "max"].includes(
          step.aggregate || "sum",
        )
      )
        fail("Pivot requires a numeric value and supported aggregation");
      const categories = [
        ...new Map(
          data.map((row) => {
            const value = row[step.nameColumn] ?? null;
            const categoryKey = JSON.stringify(value);
            return [
              categoryKey,
              {
                key: categoryKey,
                label: value === null ? "(missing)" : String(value),
              },
            ];
          }),
        ).values(),
      ];
      if (categories.length > 64)
        fail("Pivot supports at most 64 output categories");
      if (categories.some((_, i) => groups.includes(`pivot_${i}`)))
        fail("Pivot output column conflicts with a retained group column");
      const slots = new Map<
        string,
        { row: FormulaRow; values: Map<string, Array<Decimal | null>> }
      >();
      for (const row of data) {
        const groupKey = key(row, groups, schema);
        let slot = slots.get(groupKey);
        if (!slot) {
          slot = {
            row: Object.fromEntries(groups.map((id) => [id, row[id]])),
            values: new Map(),
          };
          slots.set(groupKey, slot);
        }
        const category = JSON.stringify(row[step.nameColumn] ?? null);
        let categoryValues = slot.values.get(category);
        if (!categoryValues) {
          categoryValues = [];
          slot.values.set(category, categoryValues);
        }
        categoryValues.push(
          row[step.valueColumn] == null
            ? null
            : cellDecimal(row[step.valueColumn]),
        );
      }
      data = [...slots.values()].map((slot) => ({
        ...slot.row,
        ...Object.fromEntries(
          categories.map((category, i) => {
            const values = slot.values.get(category.key) || [];
            if (values.some((value) => value === null))
              errors.push({
                stepIndex: index,
                columnId: step.valueColumn,
                code: "MISSING_CONTRIBUTOR",
                message:
                  "Pivot total withheld because a contributing value is missing",
              });
            const aggregate = step.aggregate || "sum";
            const value =
              !values.length || values.some((value) => value === null)
                ? null
                : aggregate === "count"
                  ? String(values.length)
                  : aggregate === "min"
                    ? Decimal.min(...presentDecimals(values)).toFixed()
                    : aggregate === "max"
                      ? Decimal.max(...presentDecimals(values)).toFixed()
                      : (aggregate === "average"
                          ? Decimal.sum(...presentDecimals(values)).div(
                              values.length,
                            )
                          : Decimal.sum(...presentDecimals(values))
                        ).toFixed();
            return [`pivot_${i}`, value];
          }),
        ),
      }));
      schema = [
        ...schema.filter((column) => groups.includes(column.id)),
        ...categories.map((category, i) => ({
          ...scopedMeasure,
          id: `pivot_${i}`,
          label: category.label,
          nullable: true,
        })),
      ];
    } else fail(`Unsupported preparation step: ${stepType}`);
    bounded(data, schema);
    lineage.push({
      sourceHash: step.input
        ? createHash("sha256").update(JSON.stringify(step.input)).digest("hex")
        : undefined,
      stepIndex: index,
      type: step.type,
      inputRows: before,
      outputRows: data.length,
      unmatchedRows,
      cardinality:
        step.type === "merge" || step.type === "lookup"
          ? "many-to-one"
          : undefined,
    });
  }
  return result(
    data,
    schema,
    lineage,
    { complete: complete && errors.length === 0 },
    errors,
  );
}

const buckets = new Set(["day", "week", "month", "quarter", "year"]);
function bucketDate(raw: unknown, bucket: string) {
  const d = new Date(`${scalar(raw, "date")}T00:00:00Z`);
  if (bucket === "week")
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (["month", "quarter", "year"].includes(bucket)) d.setUTCDate(1);
  if (bucket === "quarter") d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3);
  if (bucket === "year") d.setUTCMonth(0);
  return d.toISOString().slice(0, 10);
}
function shift(raw: unknown, bucket: string, count: number) {
  const d = new Date(`${raw}T00:00:00Z`);
  if (bucket === "day" || bucket === "week")
    d.setUTCDate(d.getUTCDate() + count * (bucket === "week" ? 7 : 1));
  else if (bucket === "year") d.setUTCFullYear(d.getUTCFullYear() + count);
  else d.setUTCMonth(d.getUTCMonth() + count * (bucket === "quarter" ? 3 : 1));
  return d.toISOString().slice(0, 10);
}
function previousYear(raw: unknown) {
  const d = new Date(`${raw}T00:00:00Z`);
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
/** Aggregate calendar buckets, fill missing periods, and compute lag, YoY, rolling and cumulative values. */
export function compareAnalysisTime({
  rows,
  columns = [],
  complete = true,
  dateColumn,
  valueColumns,
  groupColumns = [],
  bucket = "month",
  missing = "null",
  rollingWindow = 3,
  aggregation = "sum",
  from,
  to,
}: CompareAnalysisTimeInput): AnalysisExtensionResult {
  bounded(rows, columns);
  population(complete);
  field(columns, dateColumn);
  groupColumns.forEach((id) => field(columns, id));
  if (
    !buckets.has(bucket) ||
    !["sum", "last", "average"].includes(aggregation) ||
    !["null", "zero"].includes(missing) ||
    !Number.isInteger(rollingWindow) ||
    rollingWindow < 1 ||
    rollingWindow > 366
  )
    fail("Invalid calendar comparison configuration");
  if (
    !Array.isArray(valueColumns) ||
    !valueColumns.length ||
    valueColumns.length > 16
  )
    fail("Select one to sixteen time measures");
  const generatedIds = [
    "period_missing",
    ...valueColumns.flatMap((id) =>
      [
        "previous",
        "yoy",
        "change",
        "change_percent",
        "yoy_change",
        "yoy_percent",
        "rolling_average",
        "cumulative",
      ].map((suffix) => `${id}_${suffix}`),
    ),
  ];
  const selectedIds = new Set([dateColumn, ...groupColumns, ...valueColumns]);
  if (selectedIds.size !== 1 + groupColumns.length + valueColumns.length)
    fail("Calendar date, group and measure columns must be distinct");
  if (
    new Set(generatedIds).size !== generatedIds.length ||
    generatedIds.some((id) => selectedIds.has(id))
  )
    fail("Calendar comparison output columns collide with selected columns");
  for (const id of valueColumns)
    if (!numericTypes.has(field(columns, id).type))
      fail("Time comparisons require numeric measures");
  for (const id of valueColumns)
    if (
      (field(columns, id).aggregation === "last" ||
        field(columns, id).temporalKind === "stock") &&
      aggregation !== "last"
    )
      fail("Stock/balance measures require last aggregation");
  for (const id of valueColumns)
    for (const required of field(columns, id).requiredTimeGroups || [])
      if (!groupColumns.includes(required))
        fail(`Time comparisons require grouping by ${required}`);
  requireUnits(rows, columns, groupColumns, valueColumns);
  const partitions = new Map<
    string,
    {
      group: FormulaRow;
      periods: Map<string, Record<string, Array<Decimal | null>>>;
    }
  >();
  for (const row of [...rows].sort((a, b) =>
    String(a[dateColumn]).localeCompare(String(b[dateColumn])),
  )) {
    const k = key(row, groupColumns, columns);
    let partition = partitions.get(k);
    if (!partition) {
      partition = {
        group: Object.fromEntries(groupColumns.map((id) => [id, row[id]])),
        periods: new Map(),
      };
      partitions.set(k, partition);
    }
    const periods = partition.periods;
    const period = bucketDate(row[dateColumn], bucket);
    let periodValues = periods.get(period);
    if (!periodValues) {
      periodValues = Object.fromEntries(
        valueColumns.map((id): [string, Array<Decimal | null>] => [id, []]),
      );
      periods.set(period, periodValues);
    }
    for (const id of valueColumns)
      periodValues[id].push(row[id] == null ? null : cellDecimal(row[id]));
  }
  if (!partitions.size && !groupColumns.length && from && to)
    partitions.set("[]", { group: {}, periods: new Map() });
  const output: FormulaRow[] = [];
  const errors: AnalysisExtensionError[] = [];
  let missingPeriods = 0;
  for (const partition of partitions.values()) {
    const dates = [...partition.periods.keys()].sort();
    const first = from ? bucketDate(from, bucket) : dates[0];
    const last = to ? bucketDate(to, bucket) : dates[dates.length - 1];
    if (first > last) fail("Comparison start date must not exceed end date");
    const series: FormulaRow[] = [];
    for (
      let current = first;
      current <= last;
      current = shift(current, bucket, 1)
    ) {
      if (series.length >= MAX_ROWS)
        fail("Time comparison exceeds 1000 periods");
      const source = partition.periods.get(current);
      if (!source) missingPeriods++;
      for (const id of valueColumns)
        if (source?.[id]?.some((value) => value === null))
          errors.push({
            columnId: id,
            period: current,
            code: "MISSING_CONTRIBUTOR",
            message:
              "Calendar total withheld because a contributing value is missing",
          });
      series.push({
        ...partition.group,
        [dateColumn]: current,
        period_missing: !source,
        ...Object.fromEntries(
          valueColumns.map((id) => [
            id,
            source?.[id]?.length
              ? source[id].some((value) => value === null)
                ? null
                : (aggregation === "last"
                    ? presentDecimals(source[id])[source[id].length - 1]
                    : aggregation === "average"
                      ? Decimal.sum(...presentDecimals(source[id])).div(
                          source[id].length,
                        )
                      : Decimal.sum(...presentDecimals(source[id]))
                  ).toFixed()
              : !source && missing === "zero"
                ? "0"
                : null,
          ]),
        ),
      });
    }
    const byDate = new Map(
      series.map((row): [unknown, FormulaRow] => [row[dateColumn], row]),
    );
    const totals = Object.fromEntries(
      valueColumns.map((id) => [id, new Decimal(0)]),
    );
    const incomplete = new Set<string>();
    for (const [i, row] of series.entries())
      for (const id of valueColumns) {
        const current = row[id] == null ? null : cellDecimal(row[id]);
        const prior = byDate.get(shift(row[dateColumn], bucket, -1))?.[id];
        const yoy = byDate.get(
          bucketDate(previousYear(row[dateColumn]), bucket),
        )?.[id];
        row[`${id}_previous`] = prior ?? null;
        row[`${id}_yoy`] = yoy ?? null;
        row[`${id}_change`] =
          current && prior != null
            ? current.minus(cellDecimal(prior)).toFixed()
            : null;
        row[`${id}_change_percent`] =
          current && prior != null && !cellDecimal(prior).isZero()
            ? current
                .minus(cellDecimal(prior))
                .div(cellDecimal(prior).abs())
                .times(100)
                .toFixed()
            : null;
        row[`${id}_yoy_change`] =
          current && yoy != null
            ? current.minus(cellDecimal(yoy)).toFixed()
            : null;
        row[`${id}_yoy_percent`] =
          current && yoy != null && !cellDecimal(yoy).isZero()
            ? current
                .minus(cellDecimal(yoy))
                .div(cellDecimal(yoy).abs())
                .times(100)
                .toFixed()
            : null;
        const window = series
          .slice(Math.max(0, i - rollingWindow + 1), i + 1)
          .map((entry) => entry[id]);
        row[`${id}_rolling_average`] = window.some((value) => value == null)
          ? null
          : Decimal.sum(...window.map(cellDecimal))
              .div(window.length)
              .toFixed();
        if (current === null) incomplete.add(id);
        else totals[id] = totals[id].plus(current);
        row[`${id}_cumulative`] = incomplete.has(id)
          ? null
          : totals[id].toFixed();
      }
    output.push(...series);
    bounded(output);
  }
  const resolvedColumns = columns.map((column) =>
    valueColumns.includes(column.id)
      ? scopedColumn(column, rows, groupColumns)
      : column,
  );
  const schema: AnalysisColumn[] = [
    ...resolvedColumns.filter(
      (column) =>
        groupColumns.includes(column.id) ||
        column.id === dateColumn ||
        valueColumns.includes(column.id),
    ),
    { id: "period_missing", label: "Missing period", type: "boolean" },
  ];
  for (const id of valueColumns)
    for (const suffix of [
      "previous",
      "yoy",
      "change",
      "change_percent",
      "yoy_change",
      "yoy_percent",
      "rolling_average",
      "cumulative",
    ])
      schema.push({
        ...field(resolvedColumns, id),
        id: `${id}_${suffix}`,
        label: `${field(columns, id).label || id} ${suffix.replaceAll("_", " ")}`,
        type: "decimal",
        nullable: true,
        ...(suffix.endsWith("percent")
          ? { unit: { kind: "percentage", percentageBasis: "percent" } }
          : {}),
      });
  return result(
    output,
    schema,
    [
      {
        type: "calendar-comparison",
        bucket,
        missing,
        rollingWindow,
        aggregation,
      },
    ],
    { missingPeriods, complete: errors.length === 0 },
    errors,
  );
}

function evaluation({
  rows,
  columns,
  complete,
  formulas,
  assumptions,
  assumptionUnits,
}: FormulaModelInput) {
  return evaluateAnalysisFormulas({
    rows,
    columns,
    formulas,
    assumptions,
    assumptionUnits,
    inputComplete: complete,
  });
}
/** Every scenario evaluates the same complete source and never mutates it. */
export function runAnalysisScenarios({
  rows,
  columns = [],
  complete = true,
  formulas = [],
  assumptions = {},
  assumptionUnits = {},
  scenarios = [],
}: RunAnalysisScenariosInput) {
  bounded(rows, columns);
  population(complete);
  if (!Array.isArray(scenarios) || scenarios.length > 64)
    fail("At most 64 named scenarios are allowed");
  const ids = new Set<string>();
  const outputs = scenarios.map((scenario) => {
    if (!identifier.test(scenario.id || "") || ids.has(scenario.id))
      fail("Scenario identifiers must be valid and unique");
    ids.add(scenario.id);
    const values = { ...assumptions, ...(scenario.assumptions || {}) };
    const computed = evaluation({
      rows,
      columns,
      complete,
      formulas,
      assumptions: values,
      assumptionUnits,
    });
    return {
      id: scenario.id,
      name: scenario.name || scenario.id,
      assumptions: values,
      assumptionUnits,
      ...computed,
    };
  });
  if (Buffer.byteLength(JSON.stringify(outputs)) > MAX_BYTES)
    fail("Scenario output exceeds 2 MiB");
  return {
    scenarios: outputs,
    coverage: {
      complete: outputs.every((output) => output.complete),
      scenarios: outputs.length,
    },
  };
}
/** One/two-variable sensitivity grid, max 400 combinations. Outcomes must name summary formulas. */
export function buildAnalysisSensitivity({
  rows,
  columns = [],
  complete = true,
  formulas = [],
  assumptions = {},
  assumptionUnits = {},
  outcomeId,
  variables = [],
}: BuildAnalysisSensitivityInput): AnalysisExtensionResult {
  bounded(rows, columns);
  population(complete);
  if (
    variables.length < 1 ||
    variables.length > 2 ||
    new Set(variables.map((variable) => variable.id)).size !==
      variables.length ||
    variables.some(
      (variable) =>
        !identifier.test(variable.id || "") ||
        !Array.isArray(variable.values) ||
        !variable.values.length ||
        variable.values.length > 100,
    )
  )
    fail(
      "Sensitivity requires one or two unique variables with one to 100 values",
    );
  if (
    !formulas.some(
      (formula) => formula.id === outcomeId && formula.scope === "summary",
    )
  )
    fail("Sensitivity outcome must be a summary formula");
  const combinations =
    variables.length === 1
      ? variables[0].values.map((value) => [value])
      : variables[0].values.flatMap((a) =>
          variables[1].values.map((b) => [a, b]),
        );
  if (combinations.length > 400)
    fail("Sensitivity supports at most 400 combinations");
  const errors: AnalysisExtensionError[] = [];
  const output = combinations.map((values, index) => {
    const inputs = Object.fromEntries(
      variables.map((variable, i) => [variable.id, values[i]]),
    );
    const computed = evaluation({
      rows,
      columns,
      complete,
      formulas,
      assumptions: { ...assumptions, ...inputs },
      assumptionUnits,
    });
    errors.push(
      ...computed.errors.map((error) => ({
        combinationIndex: index,
        ...error,
      })),
    );
    return { ...inputs, outcome: computed.summaries[outcomeId] ?? null };
  });
  return result(
    output,
    [
      ...variables.map((variable) => ({
        id: variable.id,
        label: variable.id,
        type: "decimal",
      })),
      { id: "outcome", label: outcomeId, type: "decimal", nullable: true },
    ],
    [{ type: "sensitivity", outcomeId }],
    { complete: errors.length === 0, combinations: output.length },
    errors,
  );
}
/** Bracketed bisection. Reports unreachable target, evaluation failure, and iteration exhaustion explicitly. */
export function seekAnalysisGoal({
  rows,
  columns = [],
  complete = true,
  formulas = [],
  assumptions = {},
  assumptionUnits = {},
  outcomeId,
  variableId,
  target,
  lower,
  upper,
  tolerance = "0.000001",
  maxIterations = 64,
}: SeekAnalysisGoalInput) {
  bounded(rows, columns);
  population(complete);
  if (
    !identifier.test(variableId || "") ||
    !formulas.some(
      (formula) => formula.id === outcomeId && formula.scope === "summary",
    ) ||
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > 128
  )
    fail("Invalid Goal Seek configuration");
  let lo = new Decimal(lower);
  let hi = new Decimal(upper);
  const desired = new Decimal(target);
  const epsilon = new Decimal(tolerance);
  if (
    ![lo, hi, desired, epsilon].every((value) => value.isFinite()) ||
    !lo.lt(hi) ||
    !epsilon.gt(0)
  )
    fail("Goal Seek requires finite ordered bounds and positive tolerance");
  const attempt = (value: Decimal) => {
    const computed = evaluation({
      rows,
      columns,
      complete,
      formulas,
      assumptions: { ...assumptions, [variableId]: value.toFixed() },
      assumptionUnits,
    });
    if (computed.errors.length || computed.summaries[outcomeId] == null)
      fail(computed.errors[0]?.message || "Goal Seek outcome is unavailable");
    return cellDecimal(computed.summaries[outcomeId]);
  };
  let iterations = 0;
  try {
    const lowOutcome = attempt(lo);
    const highOutcome = attempt(hi);
    let lowError = lowOutcome.minus(desired);
    const highError = highOutcome.minus(desired);
    if (lowError.abs().lte(epsilon))
      return {
        converged: true,
        reason: "converged",
        iterations,
        value: lo.toFixed(),
        outcome: lowOutcome.toFixed(),
      };
    if (highError.abs().lte(epsilon))
      return {
        converged: true,
        reason: "converged",
        iterations,
        value: hi.toFixed(),
        outcome: highOutcome.toFixed(),
      };
    if (lowError.times(highError).gt(0))
      return {
        converged: false,
        reason: "target-not-bracketed",
        iterations,
        value: null,
        outcome: null,
      };
    // maxIterations >= 1, so the loop always overwrites these seeds.
    let value = lo;
    let outcome = lowOutcome;
    for (iterations = 1; iterations <= maxIterations; iterations++) {
      value = lo.plus(hi).div(2);
      outcome = attempt(value);
      const delta = outcome.minus(desired);
      if (delta.abs().lte(epsilon))
        return {
          converged: true,
          reason: "converged",
          iterations,
          value: value.toFixed(),
          outcome: outcome.toFixed(),
        };
      if (delta.times(lowError).gt(0)) {
        lo = value;
        lowError = delta;
      } else hi = value;
    }
    return {
      converged: false,
      reason: "iteration-limit",
      iterations: maxIterations,
      value: value.toFixed(),
      outcome: outcome.toFixed(),
    };
  } catch (error) {
    return {
      converged: false,
      reason: "evaluation-error",
      iterations,
      value: null,
      outcome: null,
      // fail(), Decimal and the formula engine only throw Errors.
      error: (error as Error).message,
    };
  }
}
