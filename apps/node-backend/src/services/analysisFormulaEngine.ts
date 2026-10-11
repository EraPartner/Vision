/** Safe spreadsheet-style formulas over an already bounded analysis result. */

import Decimal from "decimal.js";

/** One analysis result row; cells are untyped query or caller data. */
export type FormulaRow = Record<string, unknown>;

export interface FormulaUnit {
  kind: string;
  currency?: unknown;
  currencyParameterId?: string;
  currencyColumn?: string;
  instrumentColumn?: string;
  instrumentId?: string;
  percentageBasis?: string;
  scale?: number;
}

/** A declared unit: a shorthand string (ISO currency, "percent", ...) or an object. */
export type FormulaUnitInput = string | FormulaUnit | null | undefined;

export interface FormulaColumn {
  id: string;
  unit?: FormulaUnit | null;
}

export interface AnalysisFormulaInput {
  id: string;
  scope: string;
  expression: string;
  unit?: FormulaUnit;
  label?: string;
  resultType?: string;
}

export interface FormulaEvaluationError {
  formulaId: string;
  rowIndex?: number;
  code: string;
  message: string;
}

export interface EvaluateAnalysisFormulasInput {
  rows: FormulaRow[];
  formulas?: AnalysisFormulaInput[];
  assumptions?: Record<string, unknown>;
  inputComplete?: boolean;
  columns?: FormulaColumn[];
  assumptionUnits?: Record<string, FormulaUnitInput>;
}

export interface AnalysisFormulaEvaluation {
  rows: FormulaRow[];
  summaries: Record<string, unknown>;
  errors: FormulaEvaluationError[];
  complete: boolean;
  formulaUnits: Record<string, FormulaUnit>;
  languageVersion: string;
}

interface FormulaToken {
  type: string;
  value: string;
}

type FormulaAst =
  | { kind: "literal"; valueType: "decimal" | "string"; value: string }
  | { kind: "literal"; valueType: "boolean"; value: boolean }
  | { kind: "literal"; valueType: "null"; value: null }
  | { kind: "reference"; name: string }
  | { kind: "call"; name: string; args: FormulaAst[] }
  | { kind: "unary"; op: string; value: FormulaAst }
  | { kind: "binary"; op: string; left: FormulaAst; right: FormulaAst };

interface UnitContext {
  columns: FormulaColumn[];
  assumptions: Record<string, unknown>;
  assumptionUnits: Record<string, FormulaUnitInput>;
  formulaUnits: Record<string, FormulaUnit>;
  rows: FormulaRow[];
}

interface FormulaContext extends UnitContext {
  row: FormulaRow | null;
  formulas: Record<string, unknown>;
  rowErrors: Map<FormulaRow | null, Set<string>>;
  summaryErrors: Set<string>;
  inputComplete: boolean;
}

interface FormulaEntry {
  row: FormulaRow;
  value: unknown;
}

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
  code: string;
  formulaId: string | null;

  constructor(code: string, message: string, formulaId: string | null = null) {
    super(message);
    this.name = "AnalysisFormulaError";
    this.code = code;
    this.formulaId = formulaId;
  }
}

function tokenize(source: unknown): FormulaToken[] {
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
  const tokens: FormulaToken[] = [];
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
      tokens.push({ type: "string", value: JSON.parse(match[2]) as string });
    else if (match[3]) tokens.push({ type: "identifier", value: match[3] });
    else if (match[4]) tokens.push({ type: match[4], value: match[4] });
    // The pattern has no other alternative, so one of the groups matched.
    else
      throw new AnalysisFormulaError(
        "INVALID_TOKEN",
        `Unsupported formula syntax at character ${offset + 1}`,
      );
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

function parseExpression(source: unknown): FormulaAst {
  const tokens = tokenize(source);
  let index = 0;
  // `tokenize` ends every stream with an `eof` token, which no rule but the
  // final `take("eof")` consumes, so `index` never passes it.
  const eof: FormulaToken = { type: "eof", value: "" };
  const peek = () => tokens[index] ?? eof;
  const next = () => {
    const token = peek();
    index += 1;
    return token;
  };
  const take = (type: string) => {
    const token = peek();
    if (token.type !== type)
      throw new AnalysisFormulaError(
        "INVALID_SYNTAX",
        `Expected ${type}, received ${token.value || "end of formula"}`,
      );
    index += 1;
    return token;
  };
  function primary(): FormulaAst {
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
        const args: FormulaAst[] = [];
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
  function product(): FormulaAst {
    let left = primary();
    while (["*", "/"].includes(peek().type)) {
      const op = next().type;
      left = { kind: "binary", op, left, right: primary() };
    }
    return left;
  }
  function sum(): FormulaAst {
    let left = product();
    while (["+", "-"].includes(peek().type)) {
      const op = next().type;
      left = { kind: "binary", op, left, right: product() };
    }
    return left;
  }
  function comparison(): FormulaAst {
    let left = sum();
    while (["<", "<=", ">", ">=", "==", "!="].includes(peek().type)) {
      const op = next().type;
      left = { kind: "binary", op, left, right: sum() };
    }
    return left;
  }
  const ast = comparison();
  take("eof");
  return ast;
}

function decimal(value: unknown): Decimal | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    // Untyped cells go straight to Decimal, which rejects non-numeric input.
    const result = new Decimal(value as Decimal.Value);
    if (!result.isFinite()) throw new Error("non-finite decimal");
    return result;
  } catch {
    throw new AnalysisFormulaError(
      "TYPE_ERROR",
      `Expected a decimal, received ${String(value)}`,
    );
  }
}
function comparable(value: unknown): unknown {
  return value instanceof Decimal ? value.toNumber() : value;
}
function condition(value: unknown): boolean {
  if (
    value instanceof Decimal ||
    typeof value === "number" ||
    (typeof value === "string" &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))
  )
    return !new Decimal(value).isZero();
  return Boolean(value);
}
function assertSingleCurrency(entries: FormulaEntry[]) {
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
function compare(left: unknown, op: string, right: unknown): boolean | null {
  if (left instanceof Decimal || right instanceof Decimal) {
    // A numeric comparison with an empty cell gives an empty result, like
    // arithmetic does; IF and COUNTIF read that as not matching.
    const a = decimal(left);
    const b = decimal(right);
    if (a === null || b === null) return null;
    const ordering = a.comparedTo(b);
    if (op === "==") return ordering === 0;
    if (op === "!=") return ordering !== 0;
    if (op === "<") return ordering < 0;
    if (op === "<=") return ordering <= 0;
    if (op === ">") return ordering > 0;
    return ordering >= 0;
  }
  // Mixed scalar cells deliberately keep JavaScript's relational semantics.
  const a = comparable(left) as string | number;
  const b = comparable(right) as string | number;
  if (op === "==") return a === b;
  if (op === "!=") return a !== b;
  if (op === "<") return a < b;
  if (op === "<=") return a <= b;
  if (op === ">") return a > b;
  return a >= b;
}
function date(value: unknown): Date {
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
function resolveReference(name: string, context: FormulaContext): unknown {
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
    !/^[A-Z]{3}$/.test(String(context.row[declared.currencyColumn] || ""))
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
/** `ast.args[index]`, or an ARITY error when the call has too few arguments. */
function argument(
  ast: Extract<FormulaAst, { kind: "call" }>,
  index: number,
): FormulaAst {
  const arg = ast.args[index];
  if (arg === undefined)
    throw new AnalysisFormulaError(
      "ARITY",
      `${ast.name} is missing argument ${index + 1}`,
    );
  return arg;
}

/** `list[index]` for an index the caller has already bounded. */
function decimalAt(list: Decimal[], index: number): Decimal {
  const value = list[index];
  if (value === undefined)
    throw new Error(`Formula invariant broken: no value at ${index}`);
  return value;
}

function evaluate(ast: FormulaAst, context: FormulaContext): unknown {
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
    // decimal() maps null and "" to null; a missing operand propagates.
    const a = decimal(left);
    const b = decimal(right);
    if (a === null || b === null) return null;
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
    return condition(evaluate(argument(ast, 0), context))
      ? evaluate(argument(ast, 1), context)
      : evaluate(argument(ast, 2), context);
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
  const aggregateEntries = (
    arg: FormulaAst,
    rows: FormulaRow[] = context.rows,
  ): FormulaEntry[] =>
    rows.map((row) => ({ row, value: evaluate(arg, { ...context, row }) }));
  if (ast.name === "COUNT")
    return aggregateEntries(argument(ast, 0)).filter(
      ({ value }) => value != null,
    ).length;
  if (["SUM", "AVERAGE", "MIN", "MAX"].includes(ast.name)) {
    const arg = argument(ast, 0);
    const entries = aggregateEntries(arg);
    assertAggregateUnits(arg, entries, context);
    // Skip missing cells, including "" which decimal() also reads as missing.
    const list = entries
      .map(({ value }) => decimal(value))
      .filter((value): value is Decimal => value !== null);
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
    const expected = evaluate(argument(ast, 2), context);
    const operator = String(evaluate(argument(ast, 1), context));
    if (!["<", "<=", ">", ">=", "==", "!="].includes(operator))
      throw new AnalysisFormulaError(
        "TYPE_ERROR",
        "Conditional aggregate operator is invalid",
      );
    const tested = argument(ast, 0);
    const selected = context.rows.filter((row) =>
      compare(evaluate(tested, { ...context, row }), operator, expected),
    );
    if (ast.name === "COUNTIF") return selected.length;
    const summed = argument(ast, 3);
    const entries = aggregateEntries(summed, selected);
    assertAggregateUnits(summed, entries, context);
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
    const arg = argument(ast, 0);
    const entries = aggregateEntries(arg);
    assertAggregateUnits(arg, entries, context);
    // Skip missing cells, including "" which decimal() also reads as missing.
    const list = entries
      .map(({ value }) => decimal(value))
      .filter((value): value is Decimal => value !== null);
    if (!list.length) return null;
    if (ast.name === "MEDIAN") {
      list.sort((a, b) => a.comparedTo(b));
      // A non-empty list: mid is in range, and mid >= 1 when the length is even.
      const mid = Math.floor(list.length / 2);
      return list.length % 2
        ? decimalAt(list, mid)
        : decimalAt(list, mid - 1)
            .plus(decimalAt(list, mid))
            .div(2);
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
    const parsed = values().map((value) => decimal(value));
    const args = parsed.filter((value): value is Decimal => value !== null);
    if (args.length !== parsed.length) return null;
    if (ast.name === "NPV") {
      if (args.length < 2)
        throw new AnalysisFormulaError(
          "ARITY",
          "NPV requires rate and one or more end-of-period cash flows",
        );
      const [rate, ...flows] = args;
      // args.length >= 2 (checked above).
      if (rate === undefined)
        throw new AnalysisFormulaError("ARITY", "NPV is missing argument 1");
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
    // args.length is 3 to 5 (checked above).
    if (rate === undefined || periods === undefined || amount === undefined)
      throw new AnalysisFormulaError(
        "ARITY",
        `${ast.name} requires rate, periods and amount`,
      );
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

function dependencies(
  ast: FormulaAst,
  found: Set<string> = new Set(),
): Set<string> {
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
function assertBoundedAggregateTree(
  ast: FormulaAst,
  insideAggregate = false,
  depth = 0,
): void {
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
function ordered(formulas: AnalysisFormulaInput[]) {
  const byId = new Map(
    formulas.map((formula): [string, ParsedFormula] => {
      const ast = parseExpression(formula.expression);
      assertBoundedAggregateTree(ast);
      return [formula.id, { ...formula, ast }];
    }),
  );
  const result: ParsedFormula[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
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
type ParsedFormula = AnalysisFormulaInput & { ast: FormulaAst };

function output(value: unknown): unknown {
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
}: EvaluateAnalysisFormulasInput): AnalysisFormulaEvaluation {
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
  const ids = new Set<string>();
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
  const summaries: Record<string, unknown> = {};
  const errors: FormulaEvaluationError[] = [];
  const rowErrors = new Map<FormulaRow | null, Set<string>>(
    calculatedRows.map((row) => [row, new Set<string>()]),
  );
  const summaryErrors = new Set<string>();
  const formulaUnits: Record<string, FormulaUnit> = {};
  const recordError = (
    formula: ParsedFormula,
    error: unknown,
    rowIndex?: number,
  ) => {
    // Caught values are thrown Errors (AnalysisFormulaError or Decimal errors).
    const failure = error as { code?: string; message: string };
    errors.push({
      formulaId: formula.id,
      ...(rowIndex === undefined ? {} : { rowIndex }),
      code: failure.code || "EVALUATION_ERROR",
      message: failure.message,
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
          rowErrors.get(row)?.add(formula.id);
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
          rowErrors.get(row)?.add(formula.id);
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
function normalizeUnit(
  unit: string | FormulaUnit,
  assumptions?: Record<string, unknown>,
): FormulaUnit;
function normalizeUnit(
  unit: FormulaUnitInput,
  assumptions?: Record<string, unknown>,
): FormulaUnit | undefined;
function normalizeUnit(
  unit: FormulaUnitInput,
  assumptions: Record<string, unknown> = {},
): FormulaUnit | undefined {
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
function sameDimension(
  a: FormulaUnit | undefined,
  b: FormulaUnit | undefined,
): boolean {
  return (
    a?.kind === b?.kind &&
    a?.currency === b?.currency &&
    a?.percentageBasis === b?.percentageBasis &&
    a?.currencyColumn === b?.currencyColumn &&
    a?.instrumentColumn === b?.instrumentColumn &&
    a?.instrumentId === b?.instrumentId
  );
}
function inferFormulaUnit(
  ast: FormulaAst,
  context: UnitContext,
): FormulaUnit | undefined {
  const infer = (node: FormulaAst) => inferFormulaUnit(node, context);
  const dimensionless = (unit: FormulaUnit | undefined) =>
    !unit || ["percentage", "count"].includes(unit.kind);
  const compatible = (
    a: FormulaUnit | undefined,
    b: FormulaUnit | undefined,
  ): FormulaUnit | undefined => {
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
  if (ast.name === "COALESCE")
    return units.reduce<FormulaUnit | undefined>(compatible, undefined);
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
      .reduce<FormulaUnit | undefined>(compatible, undefined);
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
}: Omit<EvaluateAnalysisFormulasInput, "rows" | "formulas"> & {
  expression: string;
  scope?: string;
  id?: string;
  rows?: FormulaRow[];
}): AnalysisFormulaEvaluation {
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
export function validateAnalysisFormula(expression: string) {
  const ast = parseExpression(expression);
  assertBoundedAggregateTree(ast);
  return { valid: true, dependencies: [...dependencies(ast)] };
}

function assertAggregateUnits(
  ast: FormulaAst,
  entries: FormulaEntry[],
  context: FormulaContext,
): void {
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
      // The guard above ensures instrumentColumn is set when instrumentId is absent.
      ({ row }) => unit.instrumentId ?? row[unit.instrumentColumn!],
    );
    if (values.some((value) => value == null) || new Set(values).size > 1)
      throw new AnalysisFormulaError(
        "MIXED_INSTRUMENTS",
        "Quantity aggregates require one known instrument",
      );
  }
}
