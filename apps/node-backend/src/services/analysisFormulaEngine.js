/** Safe spreadsheet-style formulas over an already bounded analysis result. */

import Decimal from "decimal.js";

const MAX_FORMULAS = 64;
const MAX_EXPRESSION = 2048;
const MAX_ROWS = 1000;
const FUNCTIONS = new Set([
  "IF",
  "COALESCE",
  "ABS",
  "ROUND",
  "YEAR",
  "MONTH",
  "DATEADD",
  "DATEDIFF",
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTIF",
  "SUMIF",
  "MEDIAN",
  "STDEV",
  "VARIANCE",
  "NPV",
  "PV",
  "FV",
  "PMT",
]);
const AGGREGATES = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTIF",
  "SUMIF",
  "MEDIAN",
  "STDEV",
  "VARIANCE",
]);

export class AnalysisFormulaError extends Error {
  constructor(code, message, formulaId = null) {
    super(message);
    this.name = "AnalysisFormulaError";
    this.code = code;
    this.formulaId = formulaId;
  }
}

function tokenize(source) {
  if (typeof source !== "string" || !source.trim())
    throw new AnalysisFormulaError(
      "EMPTY_EXPRESSION",
      "Formula expression is required",
    );
  if (source.length > MAX_EXPRESSION)
    throw new AnalysisFormulaError(
      "EXPRESSION_TOO_LONG",
      `Formula expressions are limited to ${MAX_EXPRESSION} characters`,
    );
  const tokens = [];
  const pattern =
    /\s*(?:(\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|!=|==|[()+\-*/<>,]))/gy;
  let offset = 0;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match || match.index !== offset)
      throw new AnalysisFormulaError(
        "INVALID_TOKEN",
        `Unsupported formula syntax at character ${offset + 1}`,
      );
    offset = pattern.lastIndex;
    if (match[1]) tokens.push({ type: "number", value: match[1] });
    else if (match[2])
      tokens.push({ type: "string", value: JSON.parse(match[2]) });
    else if (match[3]) tokens.push({ type: "identifier", value: match[3] });
    else tokens.push({ type: match[4], value: match[4] });
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

function parseExpression(source) {
  const tokens = tokenize(source);
  let index = 0;
  const peek = () => tokens[index];
  const take = (type) => {
    const token = tokens[index];
    if (token.type !== type)
      throw new AnalysisFormulaError(
        "INVALID_SYNTAX",
        `Expected ${type}, received ${token.value || "end of formula"}`,
      );
    index += 1;
    return token;
  };
  function primary() {
    const token = peek();
    if (token.type === "number") {
      index += 1;
      return { kind: "literal", value: token.value, valueType: "decimal" };
    }
    if (token.type === "string") {
      index += 1;
      return { kind: "literal", value: token.value, valueType: "string" };
    }
    if (token.type === "identifier") {
      index += 1;
      const upper = token.value.toUpperCase();
      if (peek().type === "(") {
        if (!FUNCTIONS.has(upper))
          throw new AnalysisFormulaError(
            "UNKNOWN_FUNCTION",
            `Unsupported function: ${token.value}`,
          );
        take("(");
        const args = [];
        if (peek().type !== ")") {
          for (;;) {
            args.push(comparison());
            if (peek().type !== ",") break;
            take(",");
          }
        }
        take(")");
        return { kind: "call", name: upper, args };
      }
      if (upper === "TRUE" || upper === "FALSE")
        return {
          kind: "literal",
          value: upper === "TRUE",
          valueType: "boolean",
        };
      if (upper === "NULL")
        return { kind: "literal", value: null, valueType: "null" };
      return { kind: "reference", name: token.value };
    }
    if (token.type === "(") {
      take("(");
      const value = comparison();
      take(")");
      return value;
    }
    if (token.type === "-" || token.type === "+") {
      index += 1;
      return { kind: "unary", op: token.type, value: primary() };
    }
    throw new AnalysisFormulaError(
      "INVALID_SYNTAX",
      `Unexpected token: ${token.value || "end of formula"}`,
    );
  }
  function product() {
    let left = primary();
    while (["*", "/"].includes(peek().type)) {
      const op = tokens[index++].type;
      left = { kind: "binary", op, left, right: primary() };
    }
    return left;
  }
  function sum() {
    let left = product();
    while (["+", "-"].includes(peek().type)) {
      const op = tokens[index++].type;
      left = { kind: "binary", op, left, right: product() };
    }
    return left;
  }
  function comparison() {
    let left = sum();
    while (["<", "<=", ">", ">=", "==", "!="].includes(peek().type)) {
      const op = tokens[index++].type;
      left = { kind: "binary", op, left, right: sum() };
    }
    return left;
  }
  const ast = comparison();
  take("eof");
  return ast;
}

function decimal(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    const result = new Decimal(value);
    if (!result.isFinite()) throw new Error("non-finite decimal");
    return result;
  } catch {
    throw new AnalysisFormulaError(
      "TYPE_ERROR",
      `Expected a decimal, received ${String(value)}`,
    );
  }
}
function comparable(value) {
  return value instanceof Decimal ? value.toNumber() : value;
}
function condition(value) {
  if (
    value instanceof Decimal ||
    typeof value === "number" ||
    (typeof value === "string" &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
  )
    return !new Decimal(value).isZero();
  return Boolean(value);
}
function assertSingleCurrency(entries) {
  // Formula outputs do not carry units yet; retain the source row's currency
  // even when aggregating a derived column rather than a raw money field.
  const currencies = new Set(
    entries
      .map(({ row }) => row.currency)
      .filter((currency) => currency !== null && currency !== undefined),
  );
  if (currencies.size > 1)
    throw new AnalysisFormulaError(
      "MIXED_CURRENCIES",
      "Numeric aggregates cannot combine rows with different currencies",
    );
}
function compare(left, op, right) {
  if (left instanceof Decimal || right instanceof Decimal) {
    const ordering = decimal(left).comparedTo(decimal(right));
    if (op === "==") return ordering === 0;
    if (op === "!=") return ordering !== 0;
    if (op === "<") return ordering < 0;
    if (op === "<=") return ordering <= 0;
    if (op === ">") return ordering > 0;
    return ordering >= 0;
  }
  const a = comparable(left);
  const b = comparable(right);
  if (op === "==") return a === b;
  if (op === "!=") return a !== b;
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  if (op === ">") return a > b;
  return a >= b;
}
function date(value) {
  const raw = String(value);
  const result = new Date(`${raw}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
    Number.isNaN(result.getTime()) ||
    result.toISOString().slice(0, 10) !== raw
  )
    throw new AnalysisFormulaError(
      "TYPE_ERROR",
      `Expected an ISO date, received ${String(value)}`,
    );
  return result;
}
function resolveReference(name, context) {
  if (name.startsWith("assumption.")) {
    const key = name.slice(11);
    if (!Object.hasOwn(context.assumptions, key))
      throw new AnalysisFormulaError(
        "BROKEN_REFERENCE",
        `Unknown assumption: ${key}`,
      );
    return context.assumptions[key];
  }
  if (name.startsWith("formula.")) {
    const key = name.slice(8);
    if (
      context.rowErrors.get(context.row)?.has(key) ||
      ((!context.row || !Object.hasOwn(context.row, key)) &&
        context.summaryErrors.has(key))
    )
      throw new AnalysisFormulaError(
        "DEPENDENCY_ERROR",
        `Referenced formula failed: ${key}`,
      );
    if (context.row && Object.hasOwn(context.row, key)) return context.row[key];
    if (!Object.hasOwn(context.formulas, key))
      throw new AnalysisFormulaError(
        "BROKEN_REFERENCE",
        `Unknown formula: ${key}`,
      );
    return context.formulas[key];
  }
  const key = name.startsWith("row.") ? name.slice(4) : name;
  if (context.rowErrors.get(context.row)?.has(key))
    throw new AnalysisFormulaError(
      "DEPENDENCY_ERROR",
      `Referenced formula failed: ${key}`,
    );
  if (!context.row || !Object.hasOwn(context.row, key))
    throw new AnalysisFormulaError(
      "BROKEN_REFERENCE",
      `Unknown column: ${key}`,
    );
  const declared = context.columns?.find((column) => column.id === key)?.unit;
  if (
    declared?.currencyColumn &&
    !/^[A-Z]{3}$/.test(context.row[declared.currencyColumn] || "")
  )
    throw new AnalysisFormulaError(
      "CURRENCY_PROVENANCE_REQUIRED",
      `Column ${key} needs its source currency column ${declared.currencyColumn}`,
    );
  if (
    declared?.instrumentColumn &&
    context.row[declared.instrumentColumn] == null
  )
    throw new AnalysisFormulaError(
      "INSTRUMENT_PROVENANCE_REQUIRED",
      `Column ${key} needs its source instrument column ${declared.instrumentColumn}`,
    );
  return context.row[key];
}
function evaluate(ast, context) {
  if (ast.kind === "literal")
    return ast.valueType === "decimal" ? new Decimal(ast.value) : ast.value;
  if (ast.kind === "reference") return resolveReference(ast.name, context);
  if (ast.kind === "unary") {
    const value = decimal(evaluate(ast.value, context));
    if (value === null) return null;
    return ast.op === "-" ? value.negated() : value;
  }
  if (ast.kind === "binary") {
    const left = evaluate(ast.left, context);
    const right = evaluate(ast.right, context);
    if (["<", "<=", ">", ">=", "==", "!="].includes(ast.op))
      return compare(left, ast.op, right);
    if (left === null || right === null) return null;
    const a = decimal(left);
    const b = decimal(right);
    if (ast.op === "+") return a.plus(b);
    if (ast.op === "-") return a.minus(b);
    if (ast.op === "*") return a.times(b);
    if (b.isZero())
      throw new AnalysisFormulaError("DIVIDE_BY_ZERO", "Division by zero");
    return a.dividedBy(b);
  }
  if (AGGREGATES.has(ast.name) && !context.inputComplete)
    throw new AnalysisFormulaError(
      "INCOMPLETE_INPUT",
      "Aggregate formulas require the complete analysis result",
    );
  const values = () => ast.args.map((arg) => evaluate(arg, context));
  if (ast.name === "IF") {
    if (ast.args.length !== 3)
      throw new AnalysisFormulaError("ARITY", "IF requires three arguments");
    return condition(evaluate(ast.args[0], context))
      ? evaluate(ast.args[1], context)
      : evaluate(ast.args[2], context);
  }
  if (ast.name === "COALESCE")
    return (
      values().find((value) => value !== null && value !== undefined) ?? null
    );
  if (ast.name === "ABS") return decimal(values()[0])?.abs() ?? null;
  if (ast.name === "ROUND") {
    const [value, scale = new Decimal(2)] = values();
    return (
      decimal(value)?.toDecimalPlaces(
        Number(comparable(scale)),
        Decimal.ROUND_HALF_EVEN,
      ) ?? null
    );
  }
  if (ast.name === "YEAR") return date(values()[0]).getUTCFullYear();
  if (ast.name === "MONTH") return date(values()[0]).getUTCMonth() + 1;
  if (ast.name === "DATEADD") {
    const [rawDate, days] = values();
    const result = date(rawDate);
    result.setUTCDate(result.getUTCDate() + Number(comparable(days)));
    return result.toISOString().slice(0, 10);
  }
  if (ast.name === "DATEDIFF") {
    const [start, end] = values();
    return Math.round((date(end).getTime() - date(start).getTime()) / 86400000);
  }
  const aggregateEntries = (arg, rows = context.rows) =>
    rows.map((row) => ({ row, value: evaluate(arg, { ...context, row }) }));
  if (ast.name === "COUNT")
    return aggregateEntries(ast.args[0]).filter(({ value }) => value != null)
      .length;
  if (["SUM", "AVERAGE", "MIN", "MAX"].includes(ast.name)) {
    const entries = aggregateEntries(ast.args[0]);
    assertAggregateUnits(ast.args[0], entries, context);
    const list = entries
      .filter(({ value }) => value != null)
      .map(({ value }) => decimal(value));
    if (!list.length) return null;
    if (ast.name === "SUM") return Decimal.sum(...list);
    if (ast.name === "AVERAGE")
      return Decimal.sum(...list).dividedBy(list.length);
    return list.reduce((best, value) =>
      ast.name === "MIN" ? Decimal.min(best, value) : Decimal.max(best, value),
    );
  }
  if (ast.name === "COUNTIF" || ast.name === "SUMIF") {
    const expectedArity = ast.name === "COUNTIF" ? 3 : 4;
    if (ast.args.length !== expectedArity)
      throw new AnalysisFormulaError(
        "ARITY",
        `${ast.name} requires ${expectedArity} arguments`,
      );
    const expected = evaluate(ast.args[2], context);
    const operator = String(evaluate(ast.args[1], context));
    if (!["<", "<=", ">", ">=", "==", "!="].includes(operator))
      throw new AnalysisFormulaError(
        "TYPE_ERROR",
        "Conditional aggregate operator is invalid",
      );
    const selected = context.rows.filter((row) =>
      compare(evaluate(ast.args[0], { ...context, row }), operator, expected),
    );
    if (ast.name === "COUNTIF") return selected.length;
    const entries = aggregateEntries(ast.args[3], selected);
    assertAggregateUnits(ast.args[3], entries, context);
    return Decimal.sum(
      ...entries.map(({ value }) => decimal(value) ?? new Decimal(0)),
      new Decimal(0),
    );
  }
  if (["MEDIAN", "STDEV", "VARIANCE"].includes(ast.name)) {
    if (ast.args.length !== 1)
      throw new AnalysisFormulaError(
        "ARITY",
        `${ast.name} requires one argument`,
      );
    const entries = aggregateEntries(ast.args[0]);
    assertAggregateUnits(ast.args[0], entries, context);
    const list = entries
      .filter(({ value }) => value != null)
      .map(({ value }) => decimal(value));
    if (!list.length) return null;
    if (ast.name === "MEDIAN") {
      list.sort((a, b) => a.comparedTo(b));
      const mid = Math.floor(list.length / 2);
      return list.length % 2 ? list[mid] : list[mid - 1].plus(list[mid]).div(2);
    }
    if (list.length < 2)
      throw new AnalysisFormulaError(
        "INSUFFICIENT_DATA",
        `${ast.name} requires at least two values`,
      );
    const mean = Decimal.sum(...list).div(list.length);
    const variance = Decimal.sum(
      ...list.map((value) => value.minus(mean).pow(2)),
    ).div(list.length - 1);
    return ast.name === "STDEV" ? variance.sqrt() : variance;
  }
  if (["NPV", "PV", "FV", "PMT"].includes(ast.name)) {
    const args = values().map((value) => decimal(value));
    if (args.some((value) => value === null)) return null;
    if (ast.name === "NPV") {
      if (args.length < 2)
        throw new AnalysisFormulaError(
          "ARITY",
          "NPV requires rate and one or more end-of-period cash flows",
        );
      const [rate, ...flows] = args;
      if (rate.lte(-1))
        throw new AnalysisFormulaError("TYPE_ERROR", "NPV rate must exceed -1");
      return Decimal.sum(
        ...flows.map((flow, index) => flow.div(rate.plus(1).pow(index + 1))),
      );
    }
    if (args.length < 3 || args.length > 5)
      throw new AnalysisFormulaError(
        "ARITY",
        `${ast.name} requires rate, periods, amount, optional future/present value, and timing`,
      );
    const [
      rate,
      periods,
      amount,
      other = new Decimal(0),
      timing = new Decimal(0),
    ] = args;
    if (rate.lte(-1) || !periods.gt(0) || ![0, 1].includes(timing.toNumber()))
      throw new AnalysisFormulaError(
        "TYPE_ERROR",
        "Financial formulas require rate above -1, positive periods, and timing 0 or 1",
      );
    if (periods.gt(10000) || rate.abs().gt(100))
      throw new AnalysisFormulaError(
        "NUMERIC_RANGE",
        "Financial formulas allow at most 10000 periods and rates with absolute value at most 100",
      );
    const factor = rate.plus(1).pow(periods);
    const annuity = rate.isZero()
      ? periods
      : factor.minus(1).div(rate).times(rate.times(timing).plus(1));
    if (ast.name === "FV")
      return other.times(factor).plus(amount.times(annuity)).negated();
    if (ast.name === "PV")
      return other.plus(amount.times(annuity)).negated().div(factor);
    return amount.times(factor).plus(other).negated().div(annuity);
  }
  throw new AnalysisFormulaError(
    "UNKNOWN_FUNCTION",
    `Unsupported function: ${ast.name}`,
  );
}

function dependencies(ast, found = new Set()) {
  if (ast.kind === "reference" && ast.name.startsWith("formula."))
    found.add(ast.name.slice(8));
  if (ast.kind === "binary") {
    dependencies(ast.left, found);
    dependencies(ast.right, found);
  }
  if (ast.kind === "unary") dependencies(ast.value, found);
  if (ast.kind === "call") ast.args.forEach((arg) => dependencies(arg, found));
  return found;
}
function assertBoundedAggregateTree(ast, insideAggregate = false, depth = 0) {
  if (depth > 64)
    throw new AnalysisFormulaError(
      "EXPRESSION_TOO_DEEP",
      "Formula expressions are limited to 64 nested operations",
    );
  if (ast.kind === "call") {
    const aggregate = AGGREGATES.has(ast.name);
    if (insideAggregate && aggregate)
      throw new AnalysisFormulaError(
        "NESTED_AGGREGATE",
        "Aggregate functions cannot be nested",
      );
    ast.args.forEach((arg) =>
      assertBoundedAggregateTree(arg, insideAggregate || aggregate, depth + 1),
    );
  } else if (ast.kind === "binary") {
    assertBoundedAggregateTree(ast.left, insideAggregate, depth + 1);
    assertBoundedAggregateTree(ast.right, insideAggregate, depth + 1);
  } else if (ast.kind === "unary") {
    assertBoundedAggregateTree(ast.value, insideAggregate, depth + 1);
  }
}
function ordered(formulas) {
  const byId = new Map(
    formulas.map((formula) => {
      const ast = parseExpression(formula.expression);
      assertBoundedAggregateTree(ast);
      return [formula.id, { ...formula, ast }];
    }),
  );
  const result = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id))
      throw new AnalysisFormulaError(
        "CYCLE",
        `Formula dependency cycle includes ${id}`,
        id,
      );
    if (visited.has(id)) return;
    const formula = byId.get(id);
    if (!formula)
      throw new AnalysisFormulaError(
        "BROKEN_REFERENCE",
        `Unknown formula: ${id}`,
        id,
      );
    visiting.add(id);
    for (const dep of dependencies(formula.ast)) visit(dep);
    visiting.delete(id);
    visited.add(id);
    result.push(formula);
  }
  for (const id of byId.keys()) visit(id);
  return result;
}
function output(value) {
  if (!(value instanceof Decimal)) return value;
  if (!value.isFinite() || Math.abs(value.e) > 1000)
    throw new AnalysisFormulaError(
      "NUMERIC_RANGE",
      "Formula result exceeds the finite decimal range",
    );
  const fixed = value.toDecimalPlaces(12, Decimal.ROUND_HALF_EVEN).toFixed();
  return fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
}

export function evaluateAnalysisFormulas({
  rows,
  formulas = [],
  assumptions = {},
  inputComplete = true,
  columns = [],
  assumptionUnits = {},
}) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS)
    throw new AnalysisFormulaError(
      "ROW_LIMIT",
      `Formula evaluation is limited to ${MAX_ROWS} rows`,
    );
  if (!Array.isArray(formulas) || formulas.length > MAX_FORMULAS)
    throw new AnalysisFormulaError(
      "FORMULA_LIMIT",
      `At most ${MAX_FORMULAS} formulas are allowed`,
    );
  const ids = new Set();
  for (const formula of formulas) {
    if (!formula || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(formula.id || ""))
      throw new AnalysisFormulaError(
        "INVALID_FORMULA",
        "Every formula needs a stable identifier",
      );
    if (ids.has(formula.id))
      throw new AnalysisFormulaError(
        "DUPLICATE_FORMULA",
        `Duplicate formula: ${formula.id}`,
        formula.id,
      );
    ids.add(formula.id);
    if (!["row", "summary"].includes(formula.scope))
      throw new AnalysisFormulaError(
        "INVALID_SCOPE",
        `Formula ${formula.id} needs row or summary scope`,
        formula.id,
      );
  }
  const sequence = ordered(formulas);
  const calculatedRows = rows.map((row) => ({ ...row }));
  const summaries = {};
  const errors = [];
  const rowErrors = new Map(calculatedRows.map((row) => [row, new Set()]));
  const summaryErrors = new Set();
  const formulaUnits = {};
  const recordError = (formula, error, rowIndex) => {
    errors.push({
      formulaId: formula.id,
      ...(rowIndex === undefined ? {} : { rowIndex }),
      code: error.code || "EVALUATION_ERROR",
      message: error.message,
    });
  };
  for (const formula of sequence) {
    try {
      const inferred = inferFormulaUnit(formula.ast, {
        columns,
        assumptions,
        assumptionUnits,
        formulaUnits,
        rows,
      });
      if (
        formula.unit &&
        inferred &&
        !sameDimension(normalizeUnit(formula.unit, assumptions), inferred)
      )
        throw new AnalysisFormulaError(
          "UNIT_MISMATCH",
          "Declared formula unit does not match its expression",
        );
      if (inferred) formulaUnits[formula.id] = inferred;
      else if (formula.unit)
        formulaUnits[formula.id] = normalizeUnit(formula.unit, assumptions);
    } catch (error) {
      recordError(formula, error);
      if (formula.scope === "row")
        for (const row of calculatedRows) {
          row[formula.id] = null;
          rowErrors.get(row).add(formula.id);
        }
      else {
        summaries[formula.id] = null;
        summaryErrors.add(formula.id);
      }
      continue;
    }
    if (formula.scope === "row") {
      for (const [rowIndex, row] of calculatedRows.entries()) {
        try {
          row[formula.id] = output(
            evaluate(formula.ast, {
              row,
              rows: calculatedRows,
              assumptions,
              formulas: row,
              rowErrors,
              summaryErrors,
              inputComplete,
              columns,
              assumptionUnits,
              formulaUnits,
            }),
          );
        } catch (error) {
          recordError(formula, error, rowIndex);
          row[formula.id] = null;
          rowErrors.get(row).add(formula.id);
        }
      }
    } else {
      try {
        summaries[formula.id] = output(
          evaluate(formula.ast, {
            row: null,
            rows: calculatedRows,
            assumptions,
            formulas: summaries,
            rowErrors,
            summaryErrors,
            inputComplete,
            columns,
            assumptionUnits,
            formulaUnits,
          }),
        );
      } catch (error) {
        recordError(formula, error);
        summaries[formula.id] = null;
        summaryErrors.add(formula.id);
      }
    }
  }
  if (
    Buffer.byteLength(
      JSON.stringify({ rows: calculatedRows, summaries, errors }),
    ) >
    2 * 1024 * 1024
  )
    throw new AnalysisFormulaError(
      "RESULT_BYTE_LIMIT",
      "Formula result exceeds 2 MiB",
    );
  return {
    rows: calculatedRows,
    summaries,
    errors,
    complete: errors.length === 0,
    formulaUnits,
    languageVersion: "vision-formula-v1",
  };
}

/** Unit inference is conservative: incompatible dimensions are never silently combined. */
function normalizeUnit(unit, assumptions = {}) {
  if (!unit) return undefined;
  if (typeof unit === "string") {
    if (/^[A-Z]{3}$/.test(unit)) return { kind: "money", currency: unit };
    if (unit === "percent")
      return { kind: "percentage", percentageBasis: "percent" };
    if (unit === "ratio")
      return { kind: "percentage", percentageBasis: "ratio" };
    if (unit === "currency") return { kind: "money" };
    return { kind: unit };
  }
  if (unit.currencyParameterId && assumptions[unit.currencyParameterId]) {
    const { currencyParameterId, ...resolved } = unit;
    return { ...resolved, currency: assumptions[currencyParameterId] };
  }
  return { ...unit };
}
function sameDimension(a, b) {
  return (
    a?.kind === b?.kind &&
    a?.currency === b?.currency &&
    a?.percentageBasis === b?.percentageBasis &&
    a?.currencyColumn === b?.currencyColumn &&
    a?.instrumentColumn === b?.instrumentColumn &&
    a?.instrumentId === b?.instrumentId
  );
}
function inferFormulaUnit(ast, context) {
  const infer = (node) => inferFormulaUnit(node, context);
  const dimensionless = (unit) =>
    !unit || ["percentage", "count"].includes(unit.kind);
  const compatible = (a, b) => {
    if (a && b && !sameDimension(a, b))
      throw new AnalysisFormulaError(
        "UNIT_MISMATCH",
        "Formula combines incompatible units or currencies",
      );
    return a || b;
  };
  if (ast.kind === "literal") return undefined;
  if (ast.kind === "reference") {
    if (ast.name.startsWith("formula."))
      return context.formulaUnits[ast.name.slice(8)];
    if (ast.name.startsWith("assumption."))
      return normalizeUnit(
        context.assumptionUnits[ast.name.slice(11)],
        context.assumptions,
      );
    const id = ast.name.startsWith("row.") ? ast.name.slice(4) : ast.name;
    if (context.formulaUnits[id]) return context.formulaUnits[id];
    const column = context.columns.find((value) => value.id === id);
    const unit = normalizeUnit(column?.unit, context.assumptions);
    if (unit?.kind === "money" && !unit.currency) {
      const currencies = new Set(
        context.rows
          .map((row) => row[unit.currencyColumn || "currency"])
          .filter(Boolean),
      );
      if (currencies.size === 1) {
        const {
          currencyColumn: _currencyColumn,
          currencyParameterId: _currencyParameterId,
          ...resolved
        } = unit;
        return { ...resolved, currency: [...currencies][0] };
      }
    }
    if (
      unit?.kind === "quantity" &&
      !unit.instrumentColumn &&
      !unit.instrumentId &&
      context.rows.some((row) => row.investment_id != null)
    )
      return { ...unit, instrumentColumn: "investment_id" };
    return unit;
  }
  if (ast.kind === "unary") return infer(ast.value);
  if (ast.kind === "binary") {
    const a = infer(ast.left);
    const b = infer(ast.right);
    if (["+", "-", "==", "!=", "<", "<=", ">", ">="].includes(ast.op)) {
      const unit = compatible(a, b);
      return ["+", "-"].includes(ast.op) ? unit : undefined;
    }
    if (ast.op === "/") {
      if (a && b && sameDimension(a, b))
        return { kind: "percentage", percentageBasis: "ratio" };
      if (b && !dimensionless(b))
        throw new AnalysisFormulaError(
          "UNIT_MISMATCH",
          "Division by a dimensional value requires matching units",
        );
      return a;
    }
    if (a && b && !dimensionless(a) && !dimensionless(b))
      throw new AnalysisFormulaError(
        "UNIT_MISMATCH",
        "Multiplication of two dimensional values is unsupported",
      );
    return dimensionless(a) ? b || a : a;
  }
  const units = ast.args.map(infer);
  if (["COUNT", "COUNTIF", "YEAR", "MONTH"].includes(ast.name))
    return { kind: "count" };
  if (ast.name === "DATEDIFF") return { kind: "duration" };
  if (ast.name === "IF") return compatible(units[1], units[2]);
  if (ast.name === "COALESCE") return units.reduce(compatible, undefined);
  if (["NPV", "PV", "FV", "PMT"].includes(ast.name)) {
    if (
      !dimensionless(units[0]) ||
      (ast.name !== "NPV" && !dimensionless(units[1]))
    )
      throw new AnalysisFormulaError(
        "UNIT_MISMATCH",
        "Financial rate and period inputs must be dimensionless",
      );
    return units
      .slice(ast.name === "NPV" ? 1 : 2, ast.name === "NPV" ? undefined : 4)
      .reduce(compatible, undefined);
  }
  const unit = ast.name === "SUMIF" ? units[3] : units[0];
  if (
    AGGREGATES.has(ast.name) &&
    !["COUNT", "COUNTIF"].includes(ast.name) &&
    unit?.kind === "money" &&
    !unit.currency &&
    !unit.currencyColumn
  )
    throw new AnalysisFormulaError(
      "CURRENCY_PROVENANCE_REQUIRED",
      "Money aggregates require a literal currency or resolved currency parameter, even when the result omits the currency column",
    );
  if (ast.name === "VARIANCE" && unit && !dimensionless(unit))
    throw new AnalysisFormulaError(
      "UNIT_MISMATCH",
      "Variance of dimensional data has squared units; use STDEV or a dimensionless ratio",
    );
  return unit;
}

export function previewAnalysisFormula({
  expression,
  scope = "row",
  id = "preview",
  rows = [],
  ...input
}) {
  return evaluateAnalysisFormulas({
    ...input,
    rows,
    formulas: [{ id, scope, expression }],
  });
}
export function getAnalysisFormulaFunctions() {
  return [...FUNCTIONS].map((name) => ({
    name,
    aggregate: AGGREGATES.has(name),
    semantics: ["STDEV", "VARIANCE"].includes(name)
      ? "sample (n-1)"
      : ["NPV", "PV", "FV", "PMT"].includes(name)
        ? "periodic rates; payments use cash-flow signs; timing 0=end, 1=start"
        : "Decimal arithmetic",
  }));
}
export function validateAnalysisFormula(expression) {
  const ast = parseExpression(expression);
  assertBoundedAggregateTree(ast);
  return { valid: true, dependencies: [...dependencies(ast)] };
}

function assertAggregateUnits(ast, entries, context) {
  const unit = inferFormulaUnit(ast, {
    columns: context.columns || [],
    assumptions: context.assumptions,
    assumptionUnits: context.assumptionUnits || {},
    formulaUnits: context.formulaUnits || {},
    rows: context.rows,
  });
  if (!unit) {
    assertSingleCurrency(entries.filter(({ value }) => value != null));
    return;
  }
  if (unit.kind === "money") {
    if (entries.some(({ value }) => value == null))
      throw new AnalysisFormulaError(
        "MISSING_CONTRIBUTOR",
        "Money aggregate withheld because a contributing value is missing",
      );
    const values = entries.map(
      ({ row }) => unit.currency || row[unit.currencyColumn || "currency"],
    );
    if (
      values.some(
        (value) => typeof value !== "string" || !/^[A-Z]{3}$/.test(value),
      )
    )
      throw new AnalysisFormulaError(
        "CURRENCY_PROVENANCE_REQUIRED",
        "Every money contributor needs a known currency",
      );
    if (new Set(values).size > 1)
      throw new AnalysisFormulaError(
        "MIXED_CURRENCIES",
        "Money aggregates cannot combine different currencies",
      );
    if (
      entries.some(
        ({ row, value }) =>
          value == null ||
          (unit.currencyColumn && row[unit.currencyColumn] == null),
      )
    )
      throw new AnalysisFormulaError(
        "CURRENCY_PROVENANCE_REQUIRED",
        "Money contributor provenance is missing",
      );
  }
  if (unit.kind === "quantity") {
    if (!unit.instrumentColumn && !unit.instrumentId)
      throw new AnalysisFormulaError(
        "INSTRUMENT_PROVENANCE_REQUIRED",
        "Quantity aggregate needs a known instrument or instrument column",
      );
    if (entries.some(({ value }) => value == null))
      throw new AnalysisFormulaError(
        "MISSING_CONTRIBUTOR",
        "Quantity aggregate withheld because a contributing value is missing",
      );
    const values = entries.map(
      ({ row }) => unit.instrumentId ?? row[unit.instrumentColumn],
    );
    if (values.some((value) => value == null) || new Set(values).size > 1)
      throw new AnalysisFormulaError(
        "MIXED_INSTRUMENTS",
        "Quantity aggregates require one known instrument",
      );
  }
}
