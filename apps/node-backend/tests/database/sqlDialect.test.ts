/**
 * Every SQL string the backend sends and every migration follows the SQLite
 * dialect contract (ADR-263, docs/reference/sqlite-sql-dialect.md). The first
 * block proves each rule of the checker on a known-bad and a known-good
 * statement; the second scans the sources, one test per file, so
 * `vitest run tests/database/sqlDialect.test.ts -t <path>` checks one file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/database/connection.ts";
import { MIGRATIONS_DIR } from "../../src/database/migrate.ts";
import {
  type DialectContext,
  type Finding,
  checkMigrationFile,
  checkSqlText,
  checkTypeScriptFile,
} from "./sqlDialectCheck.ts";

const backendRoot = path.resolve(import.meta.dirname, "../..");
const repoRoot = path.resolve(backendRoot, "../..");

const fixedContext: DialectContext = {
  decimalColumns: new Set(["amount", "balance", "value"]),
  visionFunctions: new Set([
    "dec_sum", "dec_add", "dec_neg", "dec_gt", "dec_key", "dec_sign", "dec_real", "vision_numeric",
    "vision_numeric_ok", "today", "now", "ilike", "add_days",
  ]),
};

const rules = (sql: string, ctx: DialectContext = fixedContext) => checkSqlText(sql, ctx).map((f) => f.rule);

describe("SQL dialect checker", () => {
  it.each([
    ["PostgreSQL cast", "SELECT amount::numeric FROM t", "pg-syntax"],
    ["parameter cast", "SELECT * FROM t WHERE id = $1::bigint", "pg-syntax"],
    ["ILIKE operator", "SELECT * FROM t WHERE name ILIKE $1", "pg-syntax"],
    ["CURRENT_DATE", "SELECT * FROM t WHERE day = CURRENT_DATE", "pg-syntax"],
    ["INTERVAL literal", "SELECT * FROM t WHERE created_at > now() - INTERVAL '1 day'", "pg-syntax"],
    ["row lock", "SELECT * FROM t WHERE id = ? FOR UPDATE", "pg-syntax"],
    ["ANY(array)", "SELECT * FROM t WHERE id = ANY($1)", "pg-syntax"],
    ["DISTINCT ON", "SELECT DISTINCT ON (a) a, b FROM t", "pg-syntax"],
    ["LATERAL", "SELECT * FROM t CROSS JOIN LATERAL (SELECT 1) x", "pg-syntax"],
    ["array literal", "SELECT * FROM t WHERE tags && ARRAY['a']", "pg-syntax"],
    ["alias column list", "SELECT * FROM (VALUES (1, 2)) AS v(a, b)", "pg-syntax"],
    ["unknown alias hint", 'SELECT count(*) AS "n::numeric" FROM t', "alias-hint"],
    ["string_agg", "SELECT string_agg(name, ',') FROM t", "function"],
    ["SQLite date modifier", "SELECT * FROM t WHERE day = date('now')", "function"],
    ["strftime", "SELECT strftime('%Y', day) FROM t", "function"],
    ["concat (3.44)", "SELECT concat(a, b) FROM t", "function"],
    ["unknown function", "SELECT made_up(a) FROM t", "function"],
    ["native sum", "SELECT SUM(amount) FROM t", "decimal"],
    ["native sum over CASE", "SELECT sum(CASE WHEN kind = 'x' THEN t.amount ELSE 0 END) FROM t", "decimal"],
    ["native max", "SELECT max(balance) FROM t", "decimal"],
    ["native addition", "SELECT t.amount + 1 FROM t", "decimal"],
    ["unary minus", "SELECT -amount FROM t", "decimal"],
    ["native comparison", "SELECT * FROM t WHERE amount > ?", "decimal"],
    ["comparison of a dec_ result", "SELECT a FROM t GROUP BY a HAVING dec_sum(amount) > 0", "decimal"],
    ["BETWEEN", "SELECT * FROM t WHERE amount BETWEEN ? AND ?", "decimal"],
    ["equality with a number", "SELECT * FROM t WHERE amount = 0", "decimal"],
    ["ORDER BY a decimal", "SELECT * FROM t ORDER BY amount DESC", "decimal"],
    ["ORDER BY a dec_ result", "SELECT a FROM t GROUP BY a ORDER BY dec_sum(amount) DESC", "decimal"],
    ["ORDER BY an alias of a decimal", "SELECT a, dec_sum(amount) AS total FROM t GROUP BY a ORDER BY total", "decimal"],
    ["window ORDER BY", "SELECT row_number() OVER (ORDER BY t.balance) FROM t", "decimal"],
  ])("refuses %s", (_label, sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it.each([
    ["alias hints", 'SELECT count(*) AS "n::bigint", flag AS "flag::bool" FROM t'],
    ["ilike()", "SELECT * FROM t WHERE ilike(name, ?)"],
    ["today()", "SELECT * FROM t WHERE day = today() AND created_at < add_days(today(), 1)"],
    ["json_each instead of ANY", "SELECT value FROM json_each(?) ORDER BY value"],
    ["IN (json_each)", "SELECT * FROM t WHERE id IN (SELECT value FROM json_each(?))"],
    ["dec_ aggregate", "SELECT dec_sum(amount) AS total FROM t"],
    ["shielded decimal", "SELECT sum(CASE WHEN dec_sign(amount) > 0 THEN 1 ELSE 0 END) FROM t"],
    ["explicit REAL", "SELECT sum(dec_real(amount)), CAST(balance AS REAL) * 2 FROM t"],
    ["dec_ comparison", "SELECT * FROM t WHERE dec_gt(amount, ?) AND amount = ?"],
    ["dec_key ordering", "SELECT * FROM t ORDER BY dec_key(amount) DESC, id"],
    ["text concatenation", "SELECT amount || ' EUR', count(*) * 2, t.* FROM t"],
    ["group_concat", "SELECT group_concat(name, ',') FROM t"],
    ["insert column list", "INSERT INTO accounts (id, amount) VALUES (?, vision_numeric(?, 19, 4))"],
    ["CTE column list", "WITH x(a, b) AS (SELECT 1, 2) SELECT * FROM x"],
    ["DDL", "CREATE TABLE IF NOT EXISTS t (amount DECIMAL_TEXT(19, 4) NOT NULL CONSTRAINT t_amount__vtype CHECK (vision_numeric_ok(amount, 19, 4)));\nCREATE INDEX t_amount ON t (id)"],
    ["trigger", "CREATE TRIGGER x AFTER UPDATE ON t FOR EACH ROW BEGIN SELECT RAISE(ABORT, 'no'); END"],
    ["text in quotes", "SELECT 'a::b ILIKE CURRENT_DATE' AS note FROM t"],
    ["comments", "SELECT 1 -- amount::numeric\n/* sum(amount) */"],
    ["pragma call", 'PRAGMA index_list("t")'],
  ])("accepts %s", (_label, sql) => {
    expect(checkSqlText(sql, fixedContext)).toEqual([]);
  });

  it("enforces the migration rules after the baseline", () => {
    const bad = [
      "BEGIN;",
      "PRAGMA foreign_keys = OFF;",
      "CREATE TABLE t2 (id INTEGER);",
      "CREATE TRIGGER t2_ai AFTER INSERT ON t2 BEGIN SELECT 1; SELECT 2; END;",
      "DROP TABLE t;",
      "ALTER TABLE t2 DROP COLUMN id;",
      "DELETE FROM t2;",
      "COMMIT;",
    ].join("\n");
    const found = checkMigrationFile("db/migrations/0007_x.sql", bad, fixedContext).map((f) => `${f.line}:${f.rule}`);
    expect(found).toEqual(["1:migration", "2:migration", "5:destructive", "6:destructive", "7:destructive", "8:migration"]);

    const good = [
      "DELETE FROM t2 WHERE id = 1;",
      "-- destructive-ok: rebuilt as t_new below, data copied first",
      "DROP TABLE t;",
    ].join("\n");
    expect(checkMigrationFile("db/migrations/0007_x.sql", good, fixedContext)).toEqual([]);
    expect(checkMigrationFile("db/migrations/0007_x.down.sql", "DROP TABLE t;", fixedContext)).toEqual([]);
    expect(checkMigrationFile("db/migrations/0001_baseline.sql", "DROP TABLE IF EXISTS t;", fixedContext)).toEqual([]);
    expect(checkMigrationFile("db/migrations/0007_x.sql", "SELECT SUM(amount) FROM t;", fixedContext).map((f) => f.rule)).toEqual(["decimal"]);
  });

  it("reads SQL strings, sql templates and Kysely calls in TypeScript", () => {
    const source = [
      'await query("SELECT amount::numeric FROM t WHERE id = $1", [id]);',
      "const q = sql`SELECT ${col} FROM t ORDER BY amount`;",
      'db.selectFrom("t").select((eb) => eb.fn.sum("t.amount").as("s"));',
      'db.selectFrom("t").orderBy("amount", "desc");',
      'db.selectFrom("t").where("amount", ">", 0);',
      'db.selectFrom("t").where("amount", "=", 0);',
      'db.selectFrom("t").select((eb) => eb.fn("string_agg", ["name"]).as("s"));',
      'throw new Error("amount must be > 0 and ILIKE-free");',
      "// sql-dialect-ok: detects PostgreSQL casts in saved analyses",
      'const PG_CAST = "x::numeric";',
      'db.selectFrom("t").where("amount", "=", "0.00").orderBy(sql`dec_key(amount)`);',
    ].join("\n");
    const found = checkTypeScriptFile("x.ts", fixedContext, source).map((f) => `${f.line}:${f.rule}`);
    expect(found).toEqual(["1:pg-syntax", "2:decimal", "3:decimal", "4:decimal", "5:decimal", "6:decimal", "7:function"]);
  });
});

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

function schemaContext(): DialectContext {
  const file = process.env.VISION_DATABASE_PATH;
  if (!file) throw new Error("VISION_DATABASE_PATH is not set (tests/setup/sqliteDatabase.ts)");
  const raw = new DatabaseSync(file, { readOnly: true });
  const decimal = new Set<string>();
  const other = new Set<string>();
  try {
    const rows = raw
      .prepare(
        `SELECT p.name AS name, p.type AS type FROM sqlite_schema m, pragma_table_xinfo(m.name) p
          WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
      )
      .all() as Array<{ name: string; type: string }>;
    for (const { name, type } of rows) (type.toUpperCase().startsWith("DECIMAL_TEXT") ? decimal : other).add(name.toLowerCase());
  } finally {
    raw.close();
  }
  const db = openDatabase(":memory:", "writer");
  try {
    const fns = db.prepare("SELECT DISTINCT name FROM pragma_function_list WHERE builtin = 0").all() as Array<{ name: string }>;
    return {
      decimalColumns: new Set([...decimal].filter((c) => !other.has(c))),
      visionFunctions: new Set(fns.map((f) => f.name.toLowerCase())),
    };
  } finally {
    db.close();
  }
}

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out.sort();
}

const isSource = (file: string) =>
  file.endsWith(".ts") && !file.endsWith(".d.ts") && !/\.test\.ts$/u.test(file) && !file.includes(`${path.sep}tests${path.sep}`);

const typeScriptFiles = [
  ...walk(path.join(backendRoot, "src"), (f) =>
    isSource(f) &&
    !f.includes(`${path.sep}database${path.sep}sqlite${path.sep}`) &&
    !/schema(Map)?\.generated\.ts$/u.test(f)),
  ...walk(path.join(backendRoot, "scripts"), (f) => isSource(f) && !f.includes(`${path.sep}transition${path.sep}`)),
  ...walk(path.join(repoRoot, "packaging", "electron"), isSource),
].map((f) => path.relative(repoRoot, f));

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => path.relative(repoRoot, path.join(MIGRATIONS_DIR, f)));

const format = (findings: Finding[]) => findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}\n    ${f.snippet}`);

describe("SQL in the sources follows the SQLite dialect", () => {
  let ctx: DialectContext;
  beforeAll(() => {
    ctx = schemaContext();
  });

  it("knows the decimal columns and Vision's functions", () => {
    expect(ctx.decimalColumns.size).toBeGreaterThan(10);
    for (const fn of ["dec_sum", "vision_numeric", "today", "add_months"]) expect(ctx.visionFunctions).toContain(fn);
  });

  it.each(migrationFiles)("%s", (file) => {
    expect(format(checkMigrationFile(file, readFileSync(path.join(repoRoot, file), "utf8"), ctx))).toEqual([]);
  });

  it.each(typeScriptFiles)("%s", (file) => {
    expect(format(checkTypeScriptFile(file, ctx, readFileSync(path.join(repoRoot, file), "utf8")))).toEqual([]);
  });
});
