/**
 * Lexical helpers for SQL text handed to the SQLite driver (ADR-263).
 *
 * - `$1`-style placeholders (hand-written node-postgres SQL) become `?1`,
 *   which SQLite binds by position; text inside quotes and comments is left
 *   alone.
 * - A statement is routed to the read connection only when it starts with
 *   SELECT, WITH or VALUES and contains no data-changing keyword outside
 *   quotes; everything else goes to the writer.
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

const WRITE_WORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
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
  "END",
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
      if (WRITE_WORDS.has(word)) sawWrite = true;
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
