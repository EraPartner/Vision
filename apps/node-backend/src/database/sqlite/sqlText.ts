/**
 * Lexical helpers for SQL text handed to the SQLite driver (ADR-263).
 *
 * - `$1`-style placeholders (hand-written node-postgres SQL) become `?1`,
 *   which SQLite binds by position; text inside quotes and comments is left
 *   alone.
 * - A statement is routed to the read connection when it starts with
 *   SELECT, VALUES or EXPLAIN and holds no data-changing keyword, or starts
 *   with WITH and its main statement is a SELECT; everything else goes to
 *   the writer. Words that also occur in plain reads do not count: `END`
 *   closes every CASE expression and `replace(` is a string function. A
 *   misrouted write fails on the reader (PRAGMA query_only), never silently.
 * - Text that holds more than one statement is reported so the caller can
 *   run it with `exec()` (prepare() would silently compile only the first).
 */

export interface ScannedSql {
  /** The text with `$N` placeholders rewritten. */
  text: string;
  readOnly: boolean;
  multipleStatements: boolean;
  firstKeyword: string;
}

/**
 * Words that can only begin a statement that changes data or state. Inside a
 * statement that starts with SELECT, WITH, VALUES or EXPLAIN they can mean
 * only that the statement writes (a CTE's main statement, a multi-statement
 * text): SQLite has no `SELECT ... FOR UPDATE`. Not listed: `END`, which
 * closes every CASE expression, and `REPLACE`, which is checked separately
 * because `replace(...)` is a string function.
 */
const WRITE_WORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "UPSERT",
  "CREATE",
  "DROP",
  "ALTER",
  "PRAGMA",
  "VACUUM",
  "ANALYZE",
  "REINDEX",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "ATTACH",
  "DETACH",
]);

const READ_STARTS = new Set(["SELECT", "WITH", "VALUES", "EXPLAIN"]);

const cache = new Map<string, ScannedSql>();

function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/** True when the next token after position `i` (skipping blanks) is `(`. */
function callFollows(sql: string, i: number): boolean {
  let j = i;
  while (j < sql.length && /\s/.test(sql[j] ?? "")) j++;
  return sql[j] === "(";
}

export function scanSql(sql: string): ScannedSql {
  const cached = cache.get(sql);
  if (cached) return cached;
  let out = "";
  let i = 0;
  const n = sql.length;
  let firstKeyword = "";
  let sawWrite = false;
  let statementEnded = false;
  let multiple = false;
  while (i < n) {
    const c = sql[i] ?? "";
    const next = sql[i + 1] ?? "";
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (statementEnded) multiple = true;
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const j = sql.indexOf("]", i + 1);
      const end = j === -1 ? n : j + 1;
      if (statementEnded) multiple = true;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === "-" && next === "-") {
      const j = sql.indexOf("\n", i);
      const end = j === -1 ? n : j;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const j = sql.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    if (c === "$" && /[0-9]/.test(next)) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j] ?? "")) j++;
      if (statementEnded) multiple = true;
      out += `?${sql.slice(i + 1, j)}`;
      i = j;
      continue;
    }
    if (c === ";") {
      statementEnded = true;
      out += c;
      i++;
      continue;
    }
    if (isWordChar(c) && !isWordChar(sql[i - 1] ?? " ")) {
      let j = i;
      while (j < n && isWordChar(sql[j] ?? "")) j++;
      const word = sql.slice(i, j).toUpperCase();
      if (statementEnded) multiple = true;
      if (!firstKeyword && /^[A-Z]/.test(word)) firstKeyword = word;
      // A statement word (END, REPLACE) at the start still routes to the writer:
      // READ_STARTS does not hold it.
      if (WRITE_WORDS.has(word) || (word === "REPLACE" && !callFollows(sql, j))) sawWrite = true;
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    if (statementEnded && !/\s/.test(c)) multiple = true;
    out += c;
    i++;
  }
  const scanned: ScannedSql = {
    text: out,
    readOnly: READ_STARTS.has(firstKeyword) && !sawWrite,
    multipleStatements: multiple,
    firstKeyword,
  };
  if (cache.size > 5000) cache.clear();
  cache.set(sql, scanned);
  return scanned;
}
