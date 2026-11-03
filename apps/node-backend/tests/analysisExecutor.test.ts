import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileVisualAnalysis } from "../src/services/analysisCatalog.ts";
import {
  __setAnalysisStatementTimeout,
  __validateAnalysisSql,
  cancelAnalysisQuery,
  closeAnalysisPool,
  executeAnalysisSql,
} from "../src/services/analysisExecutor.ts";
import type {
  SandboxMessage,
  SandboxRequest,
  SandboxTable,
} from "../src/services/analysisSandboxWorker.ts";
import { getTestPool } from "./setup/db.ts";
import { firstRow } from "./helpers/must.ts";

const MARKER = "analysis-executor-fixture";
let accountId = 0;
let recipientId = 0;

/** The error a promise rejects with (fails the test when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("Expected the promise to reject");
}

/** Runs the sandbox worker directly, without the executor's SQL checks. */
function runSandboxWorker(
  request: Partial<SandboxRequest> & { sql: string },
): Promise<SandboxMessage[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../src/services/analysisSandboxWorker.ts", import.meta.url),
      {
        workerData: {
          params: [],
          limit: 100,
          offset: 0,
          statementTimeoutMs: 5_000,
          startedAt: new Date().toISOString(),
          tables: [],
          ...request,
        } satisfies SandboxRequest,
        env: {},
      },
    );
    const messages: SandboxMessage[] = [];
    worker.on("message", (message: SandboxMessage) => messages.push(message));
    worker.on("error", reject);
    worker.on("exit", () => resolve(messages));
  });
}

const accountsCopy: SandboxTable = {
  view: "accounts_v1",
  columns: [
    { name: "account_id", declaredType: "INTEGER", kind: "integer" },
    { name: "account_name", declaredType: "TEXT", kind: "string" },
  ],
  rows: [
    [1, "Main"],
    [2, "Savings"],
  ],
};

beforeAll(async () => {
  const pool = getTestPool();
  recipientId = firstRow(
    await pool.query<{ id: number }>(
      "INSERT INTO recipients (name, normalized_name) VALUES ($1, $2) RETURNING id",
      ["Executor Fixture", "executor fixture"],
    ),
  ).id;
  accountId = firstRow(
    await pool.query<{ id: number }>(
      "INSERT INTO accounts (name, display_name, currency) VALUES ($1, $1, 'EUR') RETURNING id",
      ["Executor Account"],
    ),
  ).id;
  const fixtures: Array<[string, string]> = [
    ["2026-01-31", "0.1000"],
    ["2026-02-28", "0.2000"],
    ["2026-03-31", "-12.3400"],
    ["2026-04-30", "100.0000"],
  ];
  for (const [date, amount] of fixtures) {
    await pool.query(
      `INSERT INTO transactions (date, amount, currency, recipient_id, account_id, memo, created_at, import_batch_id)
       VALUES ($1, $2, 'EUR', $3, $4, $5, '2026-04-01T00:00:00.123456Z', NULL)`,
      [date, amount, recipientId, accountId, MARKER],
    );
  }
  // Enough accounts that a five-way cross join cannot finish within a short limit.
  for (let index = 0; index < 60; index++) {
    await pool.query(
      "INSERT INTO accounts (name, currency) VALUES ($1, 'EUR')",
      [`Executor filler ${index}`],
    );
  }
});

afterEach(() => __setAnalysisStatementTimeout(null));

afterAll(async () => {
  await closeAnalysisPool();
});

describe("analysis sandbox results", () => {
  it("returns calendar dates, exact decimal text, ISO instants and typed columns", async () => {
    const result = await executeAnalysisSql({
      requestId: "result-shapes",
      sql: `SELECT transaction_date, amount, created_at, is_transfer, account_id,
                   import_batch_id, category_path_ids
              FROM vision_analysis.transactions_v2
             WHERE memo = $1
             ORDER BY transaction_date`,
      values: [MARKER],
      datasetIds: ["transactions"],
    });
    expect(result.executor).toBe("sqlite-sandbox-v1");
    expect(result.rows[0]).toEqual({
      transaction_date: "2026-01-31",
      amount: "0.1000",
      created_at: "2026-04-01T00:00:00.123Z",
      is_transfer: false,
      account_id: accountId,
      import_batch_id: null,
      category_path_ids: null,
    });
    expect(result.columns).toEqual([
      { id: "transaction_date", type: "date" },
      { id: "amount", type: "decimal" },
      { id: "created_at", type: "datetime" },
      { id: "is_transfer", type: "boolean" },
      { id: "account_id", type: "integer" },
      { id: "import_batch_id", type: "integer" },
      { id: "category_path_ids", type: "integer[]" },
    ]);
    expect(result.rows.map((row) => row.transaction_date)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("sums money exactly with dec_sum and types expression columns from their values", async () => {
    const result = await executeAnalysisSql({
      requestId: "exact-totals",
      sql: `SELECT date_trunc('month', transaction_date) AS month,
                   dec_sum(amount) AS total,
                   count(*) AS n,
                   max(created_at) AS latest
              FROM vision_analysis.transactions_v1
             WHERE memo = $1 AND transaction_date < '2026-03-01'
             GROUP BY 1
             ORDER BY 1`,
      values: [MARKER],
      datasetIds: ["transactions"],
    });
    expect(result.rows).toEqual([
      { month: "2026-01-01", total: "0.1000", n: 1, latest: "2026-04-01T00:00:00.123Z" },
      { month: "2026-02-01", total: "0.2000", n: 1, latest: "2026-04-01T00:00:00.123Z" },
    ]);
    expect(result.columns).toEqual([
      { id: "month", type: "date" },
      { id: "total", type: "decimal" },
      { id: "n", type: "integer" },
      { id: "latest", type: "datetime" },
    ]);
    const total = await executeAnalysisSql({
      requestId: "exact-grand-total",
      sql: "SELECT dec_sum(amount) AS total FROM vision_analysis.transactions_v2 WHERE memo = $1",
      values: [MARKER],
      datasetIds: ["transactions"],
    });
    // 0.1 + 0.2 - 12.34 + 100: exact, not the binary float 87.96000000000001.
    expect(total.rows).toEqual([{ total: "87.9600" }]);
  });

  it("accepts VALUES and leading comments, and an int8-style count through a ::bigint alias", async () => {
    const values = await executeAnalysisSql({
      requestId: "values-statement",
      sql: "-- a note\n/* and another */ VALUES (1, 'a'), (2, 'b')",
      datasetIds: ["accounts"],
    });
    expect(values.rows).toEqual([
      { column1: 1, column2: "a" },
      { column1: 2, column2: "b" },
    ]);
    const counted = await executeAnalysisSql({
      requestId: "bigint-alias",
      sql: `SELECT count(*) AS "n::bigint" FROM vision_analysis.transactions_v2 WHERE memo = $1`,
      values: [MARKER],
      datasetIds: ["transactions"],
    });
    expect(counted.rows).toEqual([{ n: "4" }]);
    expect(counted.columns).toEqual([{ id: "n", type: "integer" }]);
  });

  it("pages a compiled visual analysis with hasMore and no inner limit", async () => {
    const compiled = compileVisualAnalysis({
      datasetId: "transactions",
      fields: ["month"],
      groups: ["month"],
      measures: ["sum_amount"],
      filters: [
        { fieldId: "currency", operator: "eq", value: "EUR" },
        { fieldId: "memo", operator: "eq", value: MARKER },
      ],
      orderBy: [{ id: "month", direction: "asc" }],
      limit: 2,
    });
    expect(compiled.sql).not.toMatch(/\bLIMIT\b/i);
    const request = {
      sql: compiled.sql,
      values: compiled.values,
      datasetIds: compiled.datasetIds,
      limit: compiled.visualPlan.limit,
    };
    const first = await executeAnalysisSql({ ...request, requestId: "first-page", offset: 0 });
    expect(first.rows).toEqual([
      { month: "2026-01-01", sum_amount: "0.1000" },
      { month: "2026-02-01", sum_amount: "0.2000" },
    ]);
    expect(first.window).toMatchObject({ kind: "page", offset: 0, limit: 2, hasMore: true });
    const second = await executeAnalysisSql({ ...request, requestId: "second-page", offset: 2 });
    expect(second.rows).toEqual([
      { month: "2026-03-01", sum_amount: "-12.3400" },
      { month: "2026-04-01", sum_amount: "100.0000" },
    ]);
    expect(second.window).toMatchObject({ kind: "page", offset: 2, limit: 2, hasMore: false });
    const exact = await executeAnalysisSql({ ...request, requestId: "exact-page", limit: 4, offset: 0 });
    expect(exact.rows).toHaveLength(4);
    expect(exact.window).toMatchObject({ kind: "page", limit: 4, hasMore: false });
  });

  it("filters and orders decimals by value, not by their text", async () => {
    const compiled = compileVisualAnalysis({
      datasetId: "transactions",
      fields: ["transaction_date", "amount"],
      groups: [],
      measures: [],
      filters: [
        { fieldId: "memo", operator: "eq", value: MARKER },
        { fieldId: "amount", operator: "gt", value: "-13" },
      ],
      orderBy: [{ id: "amount", direction: "desc" }],
      limit: 10,
    });
    const result = await executeAnalysisSql({
      requestId: "decimal-order",
      sql: compiled.sql,
      values: compiled.values,
      datasetIds: compiled.datasetIds,
      limit: 10,
    });
    // As text, '-12.3400' > '-13' is false and '100.0000' sorts below '0.2000'.
    expect(result.rows.map((row) => row.amount)).toEqual([
      "100.0000",
      "0.2000",
      "0.1000",
      "-12.3400",
    ]);
  });
});

describe("analysis sandbox boundary", () => {
  it("copies only the declared views the statement names", async () => {
    // A comma join escapes the FROM/JOIN relation check, but the sandbox has
    // no copy of a view whose dataset was not declared.
    const undeclared = await rejection(
      executeAnalysisSql({
        requestId: "undeclared-view",
        sql: "SELECT count(*) FROM vision_analysis.accounts_v1 a, vision_analysis.transactions_v2 t",
        datasetIds: ["accounts"],
      }),
    );
    expect(undeclared.message).toMatch(/no such table: vision_analysis\.transactions_v2/);
    expect(undeclared.code).toBe("42P01");
    // The base tables are not there under any name.
    const base = await rejection(
      executeAnalysisSql({
        requestId: "base-table",
        sql: "SELECT count(*) FROM vision_analysis.accounts_v1 a, transactions t",
        datasetIds: ["accounts"],
      }),
    );
    expect(base.message).toMatch(/no such table: transactions/);
  });

  it("holds only the copies and knows no database file", async () => {
    const [ready, result] = await runSandboxWorker({
      sql: `SELECT (SELECT group_concat(name, ',') FROM (SELECT name FROM vision_analysis.sqlite_schema ORDER BY name)) AS copies,
                   (SELECT count(*) FROM main.sqlite_schema) AS main_objects,
                   (SELECT count(*) FROM pragma_database_list WHERE file <> '') AS files_on_disk`,
      tables: [accountsCopy],
    });
    expect(ready).toEqual({ kind: "ready" });
    expect(result).toEqual({
      kind: "result",
      columns: [
        { id: "copies", type: "string" },
        { id: "main_objects", type: "integer" },
        { id: "files_on_disk", type: "integer" },
      ],
      rows: [{ copies: "accounts_v1,vision_rows_accounts_v1", main_objects: 0, files_on_disk: 0 }],
      hasMore: false,
    });
  });

  it.each([
    [`ATTACH DATABASE '${process.env.VISION_DATABASE_PATH ?? "vision.sqlite3"}' AS real_db`, "42501"],
    ["DETACH DATABASE vision_analysis", "42501"],
    ["PRAGMA query_only = OFF", "42501"],
    ["VACUUM INTO 'copy.sqlite3'", "42501"],
    ["INSERT INTO vision_analysis.vision_rows_accounts_v1 VALUES (3, 'x')", "42501"],
    ["WITH x AS (SELECT 1) DELETE FROM vision_analysis.vision_rows_accounts_v1", "25006"],
    ["SELECT 1; ATTACH DATABASE 'other.sqlite3' AS other", "42601"],
    ["SELECT 1 /* end */; PRAGMA query_only = OFF", "42601"],
  ])("the sandbox itself refuses %s", async (sql, code) => {
    const messages = await runSandboxWorker({ sql, tables: [accountsCopy] });
    expect(messages[0]).toEqual({ kind: "ready" });
    expect(messages[1]).toMatchObject({ kind: "error", code });
    // The copy is unchanged and still the only data.
    const [, check] = await runSandboxWorker({
      sql: "SELECT count(*) AS n FROM vision_analysis.accounts_v1",
      tables: [accountsCopy],
    });
    expect(check).toMatchObject({ kind: "result", rows: [{ n: 2 }] });
  });

  it.each([
    "ATTACH DATABASE 'x.sqlite3' AS x",
    "PRAGMA query_only = OFF",
    "SELECT * FROM pragma_table_info('accounts')",
    "SELECT 1 FROM vision_analysis.accounts_v1; DETACH DATABASE vision_analysis",
    "DELETE FROM vision_analysis.accounts_v1",
    "SELECT load_extension('x') FROM vision_analysis.accounts_v1",
  ])("the executor refuses %s before starting a sandbox", async (sql) => {
    await expect(
      executeAnalysisSql({ requestId: "refused-sql", sql, datasetIds: ["accounts"] }),
    ).rejects.toThrow(/Only SELECT|forbidden|Exactly one/);
  });

  it("fails a statement that runs past the limit with SQLSTATE 57014 and frees the sandbox", async () => {
    __setAnalysisStatementTimeout(300);
    const started = Date.now();
    const error = await rejection(
      executeAnalysisSql({
        requestId: "statement-timeout",
        sql: `SELECT count(*) FROM vision_analysis.accounts_v1 a
                JOIN vision_analysis.accounts_v1 b JOIN vision_analysis.accounts_v1 c
                JOIN vision_analysis.accounts_v1 d JOIN vision_analysis.accounts_v1 e`,
        datasetIds: ["accounts"],
      }),
    );
    expect(error.code).toBe("57014");
    expect(error.message).toBe("canceling statement due to statement timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
    // The next statement gets the sandbox.
    const next = await executeAnalysisSql({
      requestId: "after-timeout",
      sql: "SELECT count(*) AS n FROM vision_analysis.accounts_v1 WHERE account_id = $1",
      values: [accountId],
      datasetIds: ["accounts"],
    });
    expect(next.rows).toEqual([{ n: 1 }]);
  });

  it("runs one sandbox at a time and cancels a running or queued statement", async () => {
    __setAnalysisStatementTimeout(400);
    const longSql = `SELECT count(*) FROM vision_analysis.accounts_v1 a
                       JOIN vision_analysis.accounts_v1 b JOIN vision_analysis.accounts_v1 c
                       JOIN vision_analysis.accounts_v1 d JOIN vision_analysis.accounts_v1 e`;
    const started = Date.now();
    const first = rejection(
      executeAnalysisSql({ requestId: "serial-first", sql: longSql, datasetIds: ["accounts"] }),
    );
    const second = rejection(
      executeAnalysisSql({ requestId: "serial-second", sql: longSql, datasetIds: ["accounts"] }),
    );
    const [firstError, secondError] = await Promise.all([first, second]);
    expect([firstError.code, secondError.code]).toEqual(["57014", "57014"]);
    // The second waited for the first sandbox to end before its own 400 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);

    __setAnalysisStatementTimeout(null);
    const running = rejection(
      executeAnalysisSql({ requestId: "cancel-running", sql: longSql, datasetIds: ["accounts"] }),
    );
    const queued = rejection(
      executeAnalysisSql({ requestId: "cancel-queued", sql: longSql, datasetIds: ["accounts"] }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await cancelAnalysisQuery("cancel-queued")).toEqual({ cancelled: true });
    expect(await cancelAnalysisQuery("cancel-running")).toEqual({ cancelled: true });
    const [runningError, queuedError] = await Promise.all([running, queued]);
    expect(runningError).toMatchObject({
      code: "57014",
      message: "canceling statement due to user request",
    });
    expect(queuedError).toMatchObject({ code: "57014" });
    expect(await cancelAnalysisQuery("cancel-running")).toEqual({
      cancelled: false,
      reason: "not-running",
    });
  });
});

describe("analysis SQL validation", () => {
  it("accepts declared approved datasets, CTEs, joins, aggregates, and windows", () => {
    const sql = `WITH monthly AS (
      SELECT account_id, dec_sum(spending_amount) AS spend
      FROM vision_analysis.cash_flows_v1 GROUP BY account_id
    )
    SELECT a.account_name, m.spend, rank() OVER (ORDER BY dec_key(m.spend) DESC)
    FROM monthly m JOIN vision_analysis.accounts_v1 a ON a.account_id = m.account_id`;
    expect(__validateAnalysisSql(sql, ["cash-flows", "accounts"])).toContain(
      "rank()",
    );
  });

  it.each([
    "UPDATE vision_analysis.cash_flows_v1 SET signed_amount=0",
    "SELECT * FROM public.transactions",
    "SELECT pg_read_file('/etc/passwd') FROM vision_analysis.accounts_v1",
    "SELECT pg_sleep(1) FROM vision_analysis.accounts_v1",
    "SELECT * FROM vision_analysis.accounts_v1; SELECT 1",
    "COPY vision_analysis.accounts_v1 TO PROGRAM 'false'",
    'SELECT * FROM "public"."transactions"',
    "ATTACH DATABASE 'vision.sqlite3' AS real_db",
    "SELECT 1 FROM vision_analysis.accounts_v1; DETACH vision_analysis",
    "PRAGMA writable_schema = ON",
    "VACUUM",
    "SELECT * FROM vision_analysis.sqlite_master",
    "SELECT name FROM sqlite_schema.x",
    "SELECT * FROM pragma_database_list()",
    // SQLite has no dollar quoting: the text between $$ is SQL.
    "SELECT $$ ; ATTACH 'x' AS y; $$ FROM vision_analysis.accounts_v1",
    // A bracket-quoted identifier does not hide what follows it.
    "SELECT [it's] FROM vision_analysis.accounts_v1; DELETE FROM x",
  ])("rejects unsafe SQL: %s", (sql) => {
    expect(() => __validateAnalysisSql(sql, ["accounts"])).toThrow();
  });

  it("keeps a single statement with a trailing semicolon and comment", () => {
    expect(
      __validateAnalysisSql(
        "SELECT account_name FROM vision_analysis.accounts_v1; -- done",
        ["accounts"],
      ),
    ).toBe("SELECT account_name FROM vision_analysis.accounts_v1; -- done");
    expect(
      __validateAnalysisSql("VALUES (1);", ["accounts"]),
    ).toBe("VALUES (1)");
  });

  it("rejects an inherited object key as a dataset id", () => {
    expect(() =>
      __validateAnalysisSql("SELECT * FROM vision_analysis.accounts_v1", [
        "constructor",
      ]),
    ).toThrow("Dataset is not approved: constructor");
  });

  it("rejects approved but undeclared datasets", () => {
    expect(() =>
      __validateAnalysisSql("SELECT * FROM vision_analysis.transactions_v1", [
        "accounts",
      ]),
    ).toThrow("not declared");
    expect(() =>
      __validateAnalysisSql(
        'SELECT * FROM "vision_analysis"."transactions_v1"',
        ["accounts"],
      ),
    ).toThrow("not declared");
    expect(() =>
      __validateAnalysisSql(
        "SELECT * FROM [vision_analysis].`transactions_v1`",
        ["accounts"],
      ),
    ).toThrow("not declared");
  });

  it("requires a non-empty set of known dataset declarations", () => {
    expect(() => __validateAnalysisSql("SELECT 1", [])).toThrow(
      "must be declared",
    );
    expect(() => __validateAnalysisSql("SELECT 1", ["unknown"])).toThrow(
      "not approved",
    );
  });

  it("permits v2 hierarchy analysis while retaining saved v1 SQL", () => {
    expect(
      __validateAnalysisSql(
        "SELECT category_path FROM vision_analysis.transactions_v2",
        ["transactions"],
      ),
    ).toContain("category_path");
    expect(
      __validateAnalysisSql(
        "SELECT category_general FROM vision_analysis.transactions_v1",
        ["transactions"],
      ),
    ).toContain("category_general");
  });
});
