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
]);
const AGGREGATES = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTIF",
  "SUMIF",
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
    return new Decimal(value);
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
    if (context.row && Object.hasOwn(context.row, key)) return context.row[key];
    if (!Object.hasOwn(context.formulas, key))
      throw new AnalysisFormulaError(
        "BROKEN_REFERENCE",
        `Unknown formula: ${key}`,
      );
    return context.formulas[key];
  }
  const key = name.startsWith("row.") ? name.slice(4) : name;
  if (!context.row || !Object.hasOwn(context.row, key))
    throw new AnalysisFormulaError(
      "BROKEN_REFERENCE",
      `Unknown column: ${key}`,
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
  const values = () => ast.args.map((arg) => evaluate(arg, context));
  if (ast.name === "IF") {
    if (ast.args.length !== 3)
      throw new AnalysisFormulaError("ARITY", "IF requires three arguments");
    return evaluate(ast.args[0], context)
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
  const aggregateValues = (arg) =>
    context.rows
      .map((row) => evaluate(arg, { ...context, row }))
      .filter((value) => value !== null && value !== undefined);
  if (ast.name === "COUNT") return aggregateValues(ast.args[0]).length;
  if (["SUM", "AVERAGE", "MIN", "MAX"].includes(ast.name)) {
    const list = aggregateValues(ast.args[0]).map(decimal);
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
    return Decimal.sum(
      ...selected.map(
        (row) =>
          decimal(evaluate(ast.args[3], { ...context, row })) ?? new Decimal(0),
      ),
    );
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
  const fixed = value.toDecimalPlaces(12, Decimal.ROUND_HALF_EVEN).toFixed();
  return fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
}

export function evaluateAnalysisFormulas({
  rows,
  formulas = [],
  assumptions = {},
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
  for (const formula of sequence) {
    try {
      if (formula.scope === "row") {
        for (const row of calculatedRows)
          row[formula.id] = output(
            evaluate(formula.ast, {
              row,
              rows: calculatedRows,
              assumptions,
              formulas: row,
            }),
          );
      } else {
        summaries[formula.id] = output(
          evaluate(formula.ast, {
            row: null,
            rows: calculatedRows,
            assumptions,
            formulas: summaries,
          }),
        );
      }
    } catch (error) {
      errors.push({
        formulaId: formula.id,
        code: error.code || "EVALUATION_ERROR",
        message: error.message,
      });
      if (formula.scope === "row")
        calculatedRows.forEach((row) => {
          row[formula.id] = null;
        });
      else summaries[formula.id] = null;
    }
  }
  return {
    rows: calculatedRows,
    summaries,
    errors,
    complete: errors.length === 0,
    languageVersion: "vision-formula-v1",
  };
}
