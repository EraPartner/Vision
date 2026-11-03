/**
 * Static check of the SQL Vision sends to SQLite (ADR-263,
 * docs/reference/sqlite-sql-dialect.md). Tests catch a wrong statement only on
 * the paths they run; this reads every SQL string in the backend and every
 * migration and reports:
 *
 * - PostgreSQL-only syntax (casts, ILIKE, INTERVAL, row locks, LATERAL, ...);
 * - functions that are neither SQLite 3.39 core functions (the floor, macOS
 *   13) nor registered by Vision;
 * - native arithmetic, comparison, aggregation or ordering on exact-decimal
 *   values (a DECIMAL_TEXT column, an alias of one, or a dec_* result), and
 *   comparing one with a number literal;
 * - in migrations after the baseline: transaction control and connection
 *   statements the runner owns, and destructive statements without a
 *   `-- destructive-ok: <reason>` line directly above.
 *
 * A deliberate exception carries `sql-dialect-ok: <reason>` in the SQL text,
 * or (TypeScript) in a comment on the two lines above the string, or
 * (migrations) on the line of the finding or the line above it.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

export interface Finding {
  file: string;
  line: number;
  rule: string;
  message: string;
  snippet: string;
}

export interface DialectContext {
  /** DECIMAL_TEXT column names that are decimal in every table that has them. */
  decimalColumns: ReadonlySet<string>;
  /** Functions Vision registers on every connection (lower case). */
  visionFunctions: ReadonlySet<string>;
}

/** SQLite 3.39 core, aggregate, window and JSON functions (lower case). */
export const SQLITE_339_FUNCTIONS: ReadonlySet<string> = new Set([
  // core scalar
  "abs", "changes", "char", "coalesce", "format", "glob", "hex", "ifnull", "iif", "instr",
  "last_insert_rowid", "length", "like", "likelihood", "likely", "lower", "ltrim", "max",
  "min", "nullif", "printf", "quote", "random", "randomblob", "replace", "round", "rtrim",
  "sign", "sqlite_compileoption_get", "sqlite_compileoption_used", "sqlite_source_id",
  "sqlite_version", "substr", "substring", "total_changes", "trim", "typeof", "unicode",
  "unlikely", "upper", "zeroblob",
  // aggregate
  "avg", "count", "group_concat", "sum", "total",
  // window
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead",
  "first_value", "last_value", "nth_value",
  // JSON (built in since 3.38)
  "json", "json_array", "json_array_length", "json_extract", "json_insert", "json_object",
  "json_patch", "json_remove", "json_replace", "json_set", "json_type", "json_valid",
  "json_quote", "json_group_array", "json_group_object", "json_each", "json_tree",
  // trigger bodies
  "raise",
]);

/** Why a familiar function is refused, and what to use instead. */
const FUNCTION_HINTS: Readonly<Record<string, string>> = {
  date: "SQLite date modifiers are not PostgreSQL-compatible; use today(), ts_date(), add_days() or add_months()",
  time: "use Vision's date and timestamp functions",
  datetime: "use now(), vision_ts() or add_interval()",
  julianday: "use date_diff_days()",
  unixepoch: "use date_part('epoch', ...)",
  strftime: "use to_char() or date_part()",
  extract: "use date_part(field, value)",
  string_agg: "use group_concat() (string_agg needs SQLite 3.44)",
  array_agg: "use json_group_array()",
  json_agg: "use json_group_array()",
  jsonb_agg: "use json_group_array()",
  json_build_object: "use json_object()",
  jsonb_build_object: "use json_object() and vision_jsonb() to store it",
  to_json: "use json() or json_quote()",
  to_jsonb: "use vision_jsonb()",
  row_to_json: "use json_object()",
  unnest: "use json_each() over a JSON array parameter",
  generate_series: "use a recursive CTE",
  concat: "use || (concat needs SQLite 3.44)",
  concat_ws: "use || (concat_ws needs SQLite 3.44)",
  unhex: "needs SQLite 3.41",
  octet_length: "needs SQLite 3.43",
  timediff: "needs SQLite 3.43",
  jsonb: "SQLite's binary JSON needs 3.45; use vision_jsonb() for jsonb columns",
  load_extension: "extensions are not loaded",
};

const DEC_RESULT_FUNCTIONS = new Set([
  "dec", "dec_add", "dec_sub", "dec_mul", "dec_div", "dec_mod", "dec_neg", "dec_abs",
  "dec_round", "dec_trunc", "dec_floor", "dec_ceil", "dec_greatest", "dec_least", "dec_sum",
  "dec_avg", "vision_numeric",
]);

/** Calls whose result is not a decimal; a decimal inside them is used correctly. */
const SHIELD_FUNCTIONS = new Set([
  "dec_cmp", "dec_sign", "dec_key", "dec_int", "dec_real", "dec_eq", "dec_ne", "dec_lt",
  "dec_le", "dec_gt", "dec_ge", "vision_numeric_ok", "typeof", "length", "count", "cast",
  "quote", "hex", "json_quote", "json_object", "json_array", "json_group_array",
  "json_group_object", "group_concat", "dec_key",
]);

/** Native functions that treat a decimal as a number or as ordered text. */
const NATIVE_NUMERIC_FUNCTIONS = new Set(["sum", "total", "avg", "min", "max", "abs", "round", "greatest", "least", "sign", "printf", "format"]);

/** Keywords that can stand directly before "(" without being a function. */
const KEYWORDS_BEFORE_PAREN = new Set([
  "select", "from", "where", "and", "or", "not", "in", "values", "as", "over", "exists",
  "check", "key", "unique", "on", "using", "set", "returning", "distinct", "all", "like",
  "glob", "regexp", "match", "is", "between", "escape", "case", "when", "then", "else", "end",
  "join", "by", "having", "limit", "offset", "union", "intersect", "except", "cast", "filter",
  "partition", "conflict", "do", "default", "table", "view", "index", "trigger", "into",
  "primary", "foreign", "with", "recursive", "materialized", "rows", "range", "groups",
  "window", "insert", "update", "delete", "upsert", "abort", "fail", "ignore", "rollback",
  "generated", "always", "stored", "virtual", "if", "constraint", "begin", "add", "column",
  "references", "preceding", "following", "current", "exclude", "null", "notnull", "isnull",
  "language", "returns", "any", "some", "array", "row", "lateral",
]);

/** Words after which an identifier followed by "(" names a table, index or view. */
const NAME_POSITION_WORDS = new Set(["into", "table", "references", "exists", "view", "index", "trigger", "on", "pragma"]);

/** Column type names that take a "(p, s)" argument list in DDL. */
const TYPE_NAMES = new Set(["decimal_text", "decimal", "numeric", "varchar", "character", "nvarchar", "nchar", "varying"]);

const CAST_TYPES = new Set(["text", "real", "integer", "int", "numeric", "blob"]);
const JSON_TABLE_COLUMNS = ["key", "value", "type", "atom", "id", "parent", "fullkey", "path"];

const ALIAS_HINTS = new Set(["bool", "json", "timestamptz", "date", "bigint", "text"]);

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokKind = "id" | "num" | "str" | "param" | "op" | "(" | ")" | "," | ";";

interface Tok {
  kind: TokKind;
  /** Original text (identifiers: the last name segment, unquoted). */
  value: string;
  /** Lower-case identifier name or operator. */
  lower: string;
  /** Offset in the SQL text. */
  pos: number;
  /** For identifiers: quoted in the source. */
  quoted?: boolean;
  /** For identifiers: qualified (`t.amount`). */
  qualified?: boolean;
  /** For quoted identifiers: an alias hint that is not one Vision reads. */
  badHint?: string;
}

interface Lexed {
  tokens: Tok[];
  /** Syntax refused at the lexical level. */
  lexFindings: Array<{ pos: number; rule: string; message: string }>;
}

const OPERATORS = ["->>", "->", "||", "<=", ">=", "<>", "!=", "==", "::", "<<", ">>", "@>", "<@", "!~", "~*", "~~", "#>"];

function lexSql(text: string): Lexed {
  const tokens: Tok[] = [];
  const lexFindings: Lexed["lexFindings"] = [];
  let i = 0;
  const n = text.length;
  let qualifyNext = false;
  const push = (kind: TokKind, value: string, pos: number, extra: Partial<Tok> = {}) => {
    qualifyNext = false;
    tokens.push({ kind, value, lower: value.toLowerCase(), pos, ...extra });
  };
  const pushIdentifier = (name: string, pos: number, quoted: boolean, badHint?: string) => {
    const prev = tokens.at(-1);
    if (qualifyNext && prev?.kind === "id") {
      prev.value = name;
      prev.lower = name.toLowerCase();
      prev.qualified = true;
      prev.quoted = quoted;
      if (badHint) prev.badHint = badHint;
    } else {
      tokens.push({ kind: "id", value: name, lower: name.toLowerCase(), pos, quoted, ...(badHint ? { badHint } : {}) });
    }
    qualifyNext = false;
  };
  while (i < n) {
    const c = text.charAt(i);
    if (/\s/u.test(c)) {
      i += 1;
    } else if (c === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") i += 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'") {
      const start = i;
      i += 1;
      while (i < n) {
        if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") break;
        else i += 1;
      }
      i += 1;
      const prev = tokens.at(-1);
      if (prev?.kind === "id" && !prev.quoted && /^[eu]&?$/iu.test(prev.value) && prev.pos + prev.value.length === start) {
        lexFindings.push({ pos: prev.pos, rule: "pg-syntax", message: "PostgreSQL escape string literal" });
      }
      push("str", "''", start);
    } else if (c === '"') {
      const start = i;
      let name = "";
      i += 1;
      while (i < n) {
        if (text[i] === '"' && text[i + 1] === '"') {
          name += '"';
          i += 2;
        } else if (text[i] === '"') break;
        else {
          name += text[i];
          i += 1;
        }
      }
      i += 1;
      let badHint: string | undefined;
      const hint = /::([a-z_][a-z0-9_]*)$/iu.exec(name);
      if (hint) {
        const hintName = hint[1] ?? "";
        if (!ALIAS_HINTS.has(hintName)) badHint = hintName;
        name = name.slice(0, name.length - hint[0].length);
      }
      pushIdentifier(name, start, true, badHint);
    } else if (c === "`" || c === "[") {
      lexFindings.push({ pos: i, rule: "pg-syntax", message: c === "[" ? "PostgreSQL array syntax" : "backquoted identifier" });
      i += 1;
    } else if (c === "$" && text[i + 1] === "$") {
      lexFindings.push({ pos: i, rule: "pg-syntax", message: "PostgreSQL dollar quoting" });
      i += 2;
    } else if ((c === "$" || c === "?" || c === ":" || c === "@") && /[A-Za-z0-9_]/u.test(text[i + 1] ?? "") && !(c === ":" && text[i + 1] === ":")) {
      const start = i;
      i += 1;
      while (i < n && /[A-Za-z0-9_]/u.test(text.charAt(i))) i += 1;
      push("param", text.slice(start, i), start);
    } else if (c === "?") {
      push("param", "?", i);
      i += 1;
    } else if (/[0-9]/u.test(c) || (c === "." && /[0-9]/u.test(text[i + 1] ?? ""))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(text.slice(i))?.[0] ?? c;
      push("num", m, i);
      i += m.length;
    } else if (/[A-Za-z_]/u.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(text.slice(i))?.[0] ?? c;
      pushIdentifier(m, i, false);
      i += m.length;
    } else if (c === "(" || c === ")" || c === "," || c === ";") {
      push(c, c, i);
      i += 1;
    } else {
      const op = OPERATORS.find((o) => text.startsWith(o, i)) ?? c;
      if (op === ".") {
        // A qualified name (`t.amount`) becomes one identifier token; `t.*` is not a name.
        const prev = tokens.at(-1);
        let j = i + 1;
        while (j < n && /\s/u.test(text.charAt(j))) j += 1;
        if (prev?.kind === "id" && text[j] === "*") {
          prev.value = `${prev.value}.*`;
          prev.lower = prev.value.toLowerCase();
          i = j + 1;
        } else {
          qualifyNext = prev?.kind === "id";
          i += 1;
        }
        continue;
      }
      push("op", op, i);
      i += op.length;
    }
  }
  return { tokens, lexFindings };
}

// ---------------------------------------------------------------------------
// SQL rules
// ---------------------------------------------------------------------------

interface RawFinding {
  pos: number;
  rule: string;
  message: string;
}

export function checkSqlText(text: string, ctx: DialectContext): RawFinding[] {
  const { tokens, lexFindings } = lexSql(text);
  const out: RawFinding[] = [...lexFindings];
  const match = matchParens(tokens);
  const word = (i: number) => (tokens[i]?.kind === "id" && !tokens[i].quoted ? tokens[i].lower : "");
  const isCall = (i: number) => tokens[i]?.kind === "id" && !tokens[i].quoted && tokens[i + 1]?.kind === "(";

  // Aliases of decimal values in this statement are decimals too; the
  // columns of json_each()/json_tree() are not.
  const localDecimals = new Set(ctx.decimalColumns);
  if (tokens.some((t) => t.lower === "json_each" || t.lower === "json_tree")) {
    for (const c of JSON_TABLE_COLUMNS) localDecimals.delete(c);
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (word(i) !== "as" || tokens[i + 1]?.kind !== "id") continue;
    const before = i - 1;
    const t = tokens[before];
    if (!t) continue;
    const decimalBefore =
      (t.kind === "id" && localDecimals.has(t.lower) && !isCall(before)) ||
      (t.kind === ")" && DEC_RESULT_FUNCTIONS.has(word((match.get(before) ?? 0) - 1)));
    const alias = tokens[i + 1]?.lower ?? "";
    if (decimalBefore && !CAST_TYPES.has(alias)) localDecimals.add(alias);
  }

  const isDecimalLeft = (i: number): boolean => {
    const t = tokens[i];
    if (!t) return false;
    if (t.kind === "id") return localDecimals.has(t.lower) && !isCall(i) && !KEYWORDS_BEFORE_PAREN.has(t.lower);
    if (t.kind === ")") {
      const open = match.get(i);
      return open !== undefined && DEC_RESULT_FUNCTIONS.has(word(open - 1));
    }
    return false;
  };
  const isDecimalRight = (i: number): boolean => {
    const t = tokens[i];
    if (!t) return false;
    if (t.kind === "op" && (t.lower === "-" || t.lower === "+")) return isDecimalRight(i + 1);
    if (t.kind === "id") {
      if (isCall(i)) return DEC_RESULT_FUNCTIONS.has(t.lower);
      return localDecimals.has(t.lower) && !KEYWORDS_BEFORE_PAREN.has(t.lower);
    }
    return false;
  };
  const isNumber = (i: number): boolean =>
    tokens[i]?.kind === "num" || (tokens[i]?.lower === "-" && tokens[i + 1]?.kind === "num");
  const isOperand = (i: number): boolean => {
    const t = tokens[i];
    return !!t && (t.kind === "id" || t.kind === "num" || t.kind === "str" || t.kind === "param" || t.kind === ")");
  };

  let statementStart = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t) break;
    const w = word(i);
    const next = word(i + 1);
    const atStatementStart = i === statementStart;
    if (t.kind === ";") {
      statementStart = i + 1;
      continue;
    }
    if (t.badHint) out.push({ pos: t.pos, rule: "alias-hint", message: `unknown alias hint ::${t.badHint}` });

    // PostgreSQL-only syntax.
    if (t.kind === "op") {
      if (t.lower === "::") out.push({ pos: t.pos, rule: "pg-syntax", message: "PostgreSQL cast; use CAST(), vision_numeric(), a Vision function or an alias hint" });
      if (["@>", "<@", "!~", "~*", "~~", "#>"].includes(t.lower)) out.push({ pos: t.pos, rule: "pg-syntax", message: `PostgreSQL operator ${t.value}` });
      if (t.lower === "~" && isOperand(i - 1)) out.push({ pos: t.pos, rule: "pg-syntax", message: "PostgreSQL regular-expression operator; use regexp_i() or REGEXP" });
    }
    if (w === "ilike" && tokens[i + 1]?.kind !== "(") out.push({ pos: t.pos, rule: "pg-syntax", message: "ILIKE operator; use ilike(value, pattern)" });
    if (w === "similar" && next === "to") out.push({ pos: t.pos, rule: "pg-syntax", message: "SIMILAR TO" });
    if (["current_date", "current_timestamp", "current_time", "localtimestamp", "localtime"].includes(w) && tokens[i + 1]?.kind !== "(") {
      out.push({ pos: t.pos, rule: "pg-syntax", message: `${t.value}; use today() or now() (local calendar day, transaction time)` });
    }
    if (w === "interval" && tokens[i + 1]?.kind === "str") out.push({ pos: t.pos, rule: "pg-syntax", message: "INTERVAL literal; use add_days(), add_months() or add_interval()" });
    if (w === "for" && ["update", "share", "no", "key"].includes(next)) out.push({ pos: t.pos, rule: "pg-syntax", message: "row lock; the single writer and BEGIN IMMEDIATE serialise writes" });
    if ((w === "skip" && next === "locked") || w === "nowait") out.push({ pos: t.pos, rule: "pg-syntax", message: "row-lock option" });
    if (w === "lateral") out.push({ pos: t.pos, rule: "pg-syntax", message: "LATERAL join" });
    if (w === "distinct" && next === "on") out.push({ pos: t.pos, rule: "pg-syntax", message: "DISTINCT ON; use row_number() OVER (...)" });
    if ((w === "grouping" && next === "sets") || w === "rollup" || w === "cube") out.push({ pos: t.pos, rule: "pg-syntax", message: "grouping sets" });
    if (w === "tablesample" || (atStatementStart && ["truncate", "copy", "listen", "notify", "grant", "revoke", "comment", "refresh", "set", "show", "reset", "do", "lock"].includes(w))) {
      out.push({ pos: t.pos, rule: "pg-syntax", message: `PostgreSQL statement ${t.value.toUpperCase()}` });
    }
    if (["isolation", "repeatable", "serializable"].includes(w)) out.push({ pos: t.pos, rule: "pg-syntax", message: "transaction isolation level; use withReadSnapshot()" });
    if (["any", "some", "all"].includes(w) && tokens[i + 1]?.kind === "(" && tokens[i - 1]?.kind === "op") {
      out.push({ pos: t.pos, rule: "pg-syntax", message: `${t.value.toUpperCase()}(array); use IN (SELECT value FROM json_each(?))` });
    }
    if (w === "array" && (tokens[i + 1]?.kind === "(" || text[t.pos + 5] === "[")) out.push({ pos: t.pos, rule: "pg-syntax", message: "ARRAY constructor" });
    if (w === "fetch" && (next === "first" || next === "next")) out.push({ pos: t.pos, rule: "pg-syntax", message: "FETCH FIRST; use LIMIT" });
    if (w === "create" && ["extension", "schema", "function", "domain", "type", "materialized", "sequence", "policy", "role", "or", "unlogged"].includes(next)) {
      out.push({ pos: t.pos, rule: "pg-syntax", message: `CREATE ${next.toUpperCase()}` });
    }
    if ((w === "alter" && ["column", "constraint", "sequence", "type", "domain", "function", "schema", "role", "index", "view"].includes(next)) ||
        ((w === "add" || w === "drop" || w === "validate") && next === "constraint") ||
        (w === "not" && next === "valid") || (w === "drop" && next === "not")) {
      out.push({ pos: t.pos, rule: "pg-syntax", message: "ALTER form SQLite lacks; rebuild the table (see the migration guide)" });
    }
    if (w === "strict" && tokens[i - 1]?.kind === ")") out.push({ pos: t.pos, rule: "pg-syntax", message: "STRICT tables refuse Vision's declared types" });
    if (w === "now" && tokens[i + 1]?.kind === "(" && tokens[i + 2]?.kind === ")" && ["+", "-"].includes(tokens[i + 3]?.lower ?? "")) {
      out.push({ pos: t.pos, rule: "pg-syntax", message: "now() arithmetic; use add_interval()" });
    }

    // Functions.
    if (isCall(i) && !KEYWORDS_BEFORE_PAREN.has(w) && !TYPE_NAMES.has(w)) {
      const prevWord = word(i - 1);
      const close = match.get(i + 1);
      const cteColumns = close !== undefined && word(close + 1) === "as";
      const nameOnly = NAME_POSITION_WORDS.has(prevWord) || cteColumns;
      const aliasColumns = prevWord === "as" || (tokens[i - 1]?.kind === ")" && !cteColumns);
      if (aliasColumns && !nameOnly) {
        out.push({ pos: t.pos, rule: "pg-syntax", message: `alias column list ${t.value}(...) is PostgreSQL-only; name the columns in a CTE or a SELECT list` });
      } else if (!nameOnly && !SQLITE_339_FUNCTIONS.has(w) && !ctx.visionFunctions.has(w) && !w.startsWith("pragma_")) {
        out.push({
          pos: t.pos,
          rule: "function",
          message: `${t.value}() is not a SQLite 3.39 or Vision function${FUNCTION_HINTS[w] ? `: ${FUNCTION_HINTS[w]}` : ""}`,
        });
      } else if (!nameOnly && FUNCTION_HINTS[w] && !ctx.visionFunctions.has(w)) {
        out.push({ pos: t.pos, rule: "function", message: `${t.value}(): ${FUNCTION_HINTS[w]}` });
      }
    }

    // Exact decimals.
    if (t.kind === "op" && ["+", "-", "*", "/", "%"].includes(t.lower)) {
      const unary = !isOperand(i - 1);
      if ((!unary && isDecimalLeft(i - 1)) || isDecimalRight(i + 1)) {
        out.push({ pos: t.pos, rule: "decimal", message: `native ${t.value} on an exact decimal; use dec_add/dec_sub/dec_mul/dec_div/dec_neg` });
      }
    }
    if (t.kind === "op" && ["<", ">", "<=", ">="].includes(t.lower) && (isDecimalLeft(i - 1) || isDecimalRight(i + 1))) {
      out.push({ pos: t.pos, rule: "decimal", message: `native ${t.value} on an exact decimal compares text; use dec_lt/dec_le/dec_gt/dec_ge or dec_sign` });
    }
    if (w === "between" && isDecimalLeft(i - 1)) {
      out.push({ pos: t.pos, rule: "decimal", message: "BETWEEN on an exact decimal compares text; use dec_ge AND dec_le" });
    }
    if (t.kind === "op" && ["=", "==", "!=", "<>"].includes(t.lower) &&
        ((isDecimalLeft(i - 1) && isNumber(i + 1)) || (isNumber(i - 1) && isDecimalRight(i + 1)))) {
      out.push({ pos: t.pos, rule: "decimal", message: "an exact decimal never equals a number literal ('0.00' is not 0); use dec_eq or dec_sign" });
    }
    if (isCall(i) && NATIVE_NUMERIC_FUNCTIONS.has(w)) {
      const close = match.get(i + 1);
      if (close !== undefined && argumentHasBareDecimal(tokens, i + 2, close, localDecimals, match, isCall)) {
        out.push({ pos: t.pos, rule: "decimal", message: `native ${t.value}() on an exact decimal; use the dec_ function (dec_sum, dec_avg, dec_greatest, dec_abs, dec_round, ...)` });
      }
    }
    if (w === "order" && next === "by") {
      for (const term of orderByTerms(tokens, i + 2, match)) {
        const [first, last] = term;
        const single = first === last && isDecimalRight(first);
        const call = isCall(first) && DEC_RESULT_FUNCTIONS.has(word(first)) && match.get(first + 1) === last;
        if (single || call) {
          out.push({ pos: tokens[first]?.pos ?? 0, rule: "decimal", message: "ORDER BY an exact decimal sorts text; use dec_key(...)" });
        }
      }
    }
  }
  return out;
}

function matchParens(tokens: Tok[]): Map<number, number> {
  const map = new Map<number, number>();
  const stack: number[] = [];
  tokens.forEach((t, i) => {
    if (t.kind === "(") stack.push(i);
    else if (t.kind === ")") {
      const open = stack.pop();
      if (open !== undefined) {
        map.set(open, i);
        map.set(i, open);
      }
    }
  });
  return map;
}

function argumentHasBareDecimal(
  tokens: Tok[],
  from: number,
  to: number,
  decimals: ReadonlySet<string>,
  match: Map<number, number>,
  isCall: (i: number) => boolean,
): boolean {
  for (let i = from; i < to; i += 1) {
    const t = tokens[i];
    if (!t) break;
    if (t.kind !== "id") continue;
    if (isCall(i)) {
      if (SHIELD_FUNCTIONS.has(t.lower)) {
        i = match.get(i + 1) ?? i; // skip the shielded argument list
        continue;
      }
      if (DEC_RESULT_FUNCTIONS.has(t.lower)) return true;
      continue;
    }
    if (decimals.has(t.lower) && !KEYWORDS_BEFORE_PAREN.has(t.lower)) return true;
  }
  return false;
}

/** [first, last] token index of each ORDER BY term at the clause's depth. */
function orderByTerms(tokens: Tok[], from: number, match: Map<number, number>): Array<[number, number]> {
  const terms: Array<[number, number]> = [];
  const stop = new Set(["limit", "offset", "rows", "range", "groups", "union", "intersect", "except", "window"]);
  const modifiers = new Set(["asc", "desc", "nulls", "first", "last", "collate"]);
  let start = from;
  let i = from;
  const finish = (end: number) => {
    let last = end - 1;
    while (last >= start && tokens[last]?.kind === "id" && modifiers.has(tokens[last]?.lower ?? "")) last -= 1;
    if (tokens[last - 1]?.kind === "id" && tokens[last - 1]?.lower === "collate") last -= 2;
    if (last >= start) terms.push([start, last]);
  };
  for (; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t) break;
    if (t.kind === "(") {
      i = match.get(i) ?? i;
      continue;
    }
    if (t.kind === ")" || t.kind === ";" || (t.kind === "id" && stop.has(t.lower))) break;
    if (t.kind === ",") {
      finish(i);
      start = i + 1;
    }
  }
  finish(i);
  return terms;
}

// ---------------------------------------------------------------------------
// Migration rules
// ---------------------------------------------------------------------------

const RUNNER_OWNED = new Set(["begin", "commit", "end", "rollback", "savepoint", "release", "pragma", "vacuum", "attach", "detach"]);

/** [first, last] token index of each statement; a trigger body's ";" stays inside it. */
function splitStatements(tokens: Tok[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  let trigger = false;
  const lowerAt = (i: number) => (tokens[i]?.kind === "id" && !tokens[i].quoted ? tokens[i].lower : "");
  for (let i = 0; i < tokens.length; i += 1) {
    if (i === start) {
      trigger = lowerAt(i) === "create" &&
        (lowerAt(i + 1) === "trigger" || (["temp", "temporary"].includes(lowerAt(i + 1)) && lowerAt(i + 2) === "trigger"));
    }
    if (tokens[i]?.kind === ";" && (!trigger || lowerAt(i - 1) === "end")) {
      if (i > start) out.push([start, i - 1]);
      start = i + 1;
    }
  }
  if (start < tokens.length) out.push([start, tokens.length - 1]);
  return out;
}

export function checkMigrationFile(file: string, text: string, ctx: DialectContext): Finding[] {
  const name = file.split("/").at(-1) ?? file;
  const isBaseline = /^0001_/u.test(name);
  const isDown = name.endsWith(".down.sql");
  const lines = text.split("\n");
  const lineOf = (pos: number) => text.slice(0, pos).split("\n").length;
  const marked = (line: number, marker: string, above: number) => {
    const re = new RegExp(`${marker}:\\s*\\S`, "u");
    for (let k = 0; k <= above; k += 1) if (re.test(lines[line - 1 - k] ?? "")) return true;
    return false;
  };
  const findings: Finding[] = [];
  const add = (pos: number, rule: string, message: string) => {
    const line = lineOf(pos);
    if (marked(line, "sql-dialect-ok", 1)) return;
    findings.push({ file, line, rule, message, snippet: (lines[line - 1] ?? "").trim().slice(0, 160) });
  };
  for (const f of checkSqlText(text, ctx)) add(f.pos, f.rule, f.message);
  if (isBaseline) return findings;

  const { tokens } = lexSql(text);
  const lowerAt = (i: number) => (tokens[i]?.kind === "id" && !tokens[i].quoted ? tokens[i].lower : "");
  for (const [first, last] of splitStatements(tokens)) {
    const w = lowerAt(first);
    const next = lowerAt(first + 1);
    const head = tokens[first];
    if (!head) continue;
    const words = new Set<string>();
    for (let i = first; i <= last; i += 1) if (lowerAt(i)) words.add(lowerAt(i));
    if (RUNNER_OWNED.has(w)) {
      add(head.pos, "migration", `${head.value.toUpperCase()} is the migration runner's job (one transaction, foreign keys off, then foreign_key_check)`);
    }
    const destructive =
      (w === "drop" && ["table", "view", "index", "trigger"].includes(next)) ||
      (w === "delete" && !words.has("where")) ||
      (w === "alter" && words.has("drop"));
    if (destructive && !isDown) {
      const line = lineOf(head.pos);
      if (!marked(line, "destructive-ok", 3)) {
        add(head.pos, "destructive", "destructive statement: the code that stops reading the object must ship first; put `-- destructive-ok: <reason>` directly above it");
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// TypeScript sources
// ---------------------------------------------------------------------------

const SQL_CALLS = new Set(["query", "queryPrepared", "prepare", "exec", "raw", "execute"]);
const SQL_HINT = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|FROM|WHERE|JOIN|VALUES|RETURNING|COALESCE|GROUP BY|ORDER BY|CASE WHEN|ON CONFLICT|CREATE|ALTER|DROP|CURRENT_DATE|CURRENT_TIMESTAMP|IS NULL|IS NOT NULL)\b|\$\d|\w::[a-z]|\w\s+I?LIKE\s+[$?'(:]|\bINTERVAL\s+'/u;
const KYSELY_AGGREGATES = new Set(["sum", "avg", "min", "max"]);
const KYSELY_WHERE = new Set(["where", "orWhere", "having", "orHaving", "eb", "cmpr"]);

export function checkTypeScriptFile(file: string, ctx: DialectContext, source = readFileSync(file, "utf8")): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  const findings: Finding[] = [];
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const exemptAt = (line: number) =>
    [lines[line - 1], lines[line - 2], lines[line - 3]].some((l) => l !== undefined && /sql-dialect-ok:\s*\S/u.test(l));
  const report = (node: ts.Node, rule: string, message: string, at?: number) => {
    const startLine = lineOf(node.getStart(sf));
    const line = at === undefined ? startLine : lineOf(at);
    if (exemptAt(startLine) || exemptAt(line)) return;
    findings.push({ file, line, rule, message, snippet: (lines[line - 1] ?? "").trim().slice(0, 160) });
  };

  interface SqlPiece {
    text: string;
    /** Where each part of `text` starts in the source. */
    segments: Array<{ textStart: number; sourceStart: number }>;
  }

  const checkSql = (node: ts.Node, piece: SqlPiece) => {
    if (/sql-dialect-ok:\s*\S/u.test(piece.text)) return;
    for (const f of checkSqlText(piece.text, ctx)) {
      const segment = [...piece.segments].reverse().find((sg) => sg.textStart <= f.pos) ?? { textStart: 0, sourceStart: node.getStart(sf) };
      report(node, f.rule, f.message, segment.sourceStart + (f.pos - segment.textStart));
    }
  };

  const pieceOf = (node: ts.StringLiteral | ts.TemplateLiteral): SqlPiece => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { text: node.text, segments: [{ textStart: 0, sourceStart: node.getStart(sf) + 1 }] };
    }
    let text = node.head.text;
    const segments = [{ textStart: 0, sourceStart: node.head.getStart(sf) + 1 }];
    for (const span of node.templateSpans) {
      text += " ? ";
      segments.push({ textStart: text.length, sourceStart: span.literal.getStart(sf) + 1 });
      text += span.literal.text;
    }
    return { text, segments };
  };

  const isSqlCallArgument = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (!ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
    const callee = parent.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    return SQL_CALLS.has(name);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag.getText(sf);
      if (tag === "sql" || tag.endsWith(".sql") || /^sql<[\s\S]*>$/u.test(tag)) {
        checkSql(node, pieceOf(node.template));
        node.template.forEachChild(visit);
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const piece = pieceOf(node);
      const parent = node.parent;
      const isModule = ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent);
      if (!isModule && (isSqlCallArgument(node) || SQL_HINT.test(piece.text))) checkSql(node, piece);
    }
    if (ts.isCallExpression(node)) checkKyselyCall(node);
    node.forEachChild(visit);
  };

  const columnOf = (arg: ts.Expression | undefined): string | undefined => {
    if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) return undefined;
    const ref = arg.text.trim().split(/\s+/u)[0] ?? "";
    return ref.split(".").at(-1)?.toLowerCase();
  };

  const checkKyselyCall = (node: ts.CallExpression) => {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    const owner = ts.isPropertyAccessExpression(callee) ? callee.expression.getText(sf) : "";
    const [a0, a1, a2] = node.arguments;
    if (KYSELY_AGGREGATES.has(name) && /(^|\.)fn$/u.test(owner)) {
      const column = columnOf(a0);
      if (column && ctx.decimalColumns.has(column)) report(node, "decimal", `Kysely fn.${name}() on the exact decimal ${column}; use fn("dec_${name === "sum" || name === "avg" ? name : name === "min" ? "least" : "greatest"}") or sql\`dec_...\``);
    }
    if ((name === "fn" || (ts.isPropertyAccessExpression(callee) && callee.name.text === "fn")) && a0 && ts.isStringLiteral(a0)) {
      const fnName = a0.text.toLowerCase();
      if (!SQLITE_339_FUNCTIONS.has(fnName) && !ctx.visionFunctions.has(fnName)) {
        report(node, "function", `fn("${a0.text}") is not a SQLite 3.39 or Vision function${FUNCTION_HINTS[fnName] ? `: ${FUNCTION_HINTS[fnName]}` : ""}`);
      }
    }
    if (name === "orderBy" && ts.isPropertyAccessExpression(callee)) {
      const column = columnOf(a0);
      if (column && ctx.decimalColumns.has(column)) report(node, "decimal", `Kysely orderBy("${column}") sorts an exact decimal as text; order by sql\`dec_key(...)\``);
    }
    if (KYSELY_WHERE.has(name) && a1 && ts.isStringLiteral(a1)) {
      const column = columnOf(a0);
      if (column && ctx.decimalColumns.has(column)) {
        const op = a1.text.toLowerCase();
        if (["<", ">", "<=", ">=", "between", "between symmetric"].includes(op)) {
          report(node, "decimal", `Kysely ${name}("${column}", "${a1.text}") compares an exact decimal as text; use sql\`dec_lt(...)\``);
        } else if (["=", "==", "!=", "<>", "is", "is not"].includes(op) && a2 && ts.isNumericLiteral(a2)) {
          report(node, "decimal", `Kysely ${name}("${column}", "${a1.text}", ${a2.text}): an exact decimal never equals a number; use dec_eq or dec_sign`);
        }
      }
    }
  };

  visit(sf);
  return findings;
}
