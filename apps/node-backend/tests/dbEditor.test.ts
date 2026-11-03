import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { mockLogger } from "./helpers/mockLogger.ts";
import { mockConnection } from "./helpers/repoMocks.ts";

vi.mock("../src/config/logger.ts", () => ({
  logger: mockLogger(),
}));

vi.mock("../src/services/materializedViewService.ts", () => ({
  scheduleRefresh: vi.fn(),
  refreshMaterializedViews: vi.fn(),
}));

vi.mock("../src/database/connection.ts", () =>
  mockConnection({ withReadSnapshot: vi.fn() }),
);

import * as connection from "../src/database/connection.ts";
import { scheduleRefresh } from "../src/services/materializedViewService.ts";
import {
  getTableMeta,
  readRows,
  applyMutations,
} from "../src/services/dbEditor.ts";
import { must } from "./helpers/must.ts";

/** A partial client as the fakes build it. */
interface FakeClient {
  query: Mock<(sql: string, params: unknown[]) => Promise<unknown>>;
  release: Mock;
}
type ClientRunner = (fn: (client: FakeClient) => Promise<unknown>) => Promise<unknown>;

// The fakes return plain (non-promise) result objects and partial clients.
const query = connection.query as unknown as Mock<(sql: string) => unknown>;
const withReadSnapshot = connection.withReadSnapshot as unknown as Mock<ClientRunner>;
const withTransaction = connection.withTransaction as unknown as Mock<ClientRunner>;

/** A driver error as dbEditor's mapDbError reads it. */
type DbError = Error & { code?: string; constraint?: string; column?: string };
/** `[sql substring, canned result or result factory]` for `makeClient`. */
type ClientHandler = [
  needle: string,
  value: object | ((sql: string, params: unknown[]) => unknown),
];

/** The `__xmin` token readRows hands out for a row-version text. */
const token = (versionText: string) =>
  crypto.createHash("sha256").update(versionText).digest("hex").slice(0, 32);

// ── Catalog fixtures ────────────────────────────────────────────────────────

const ALLOWED_TABLES = [
  "transactions",
  "recipients",
  "tags",
  "kv_settings",
  "accounts",
  "mv_monthly_summary",
  "typed",
];

/** A `pragma_table_xinfo` row. */
function col(
  cid: number,
  name: string,
  type: string,
  { notnull = 0, pk = 0, dflt = null as string | null, hidden = 0 } = {},
) {
  return { cid, name, type, notnull, dflt_value: dflt, pk, hidden };
}

const COLUMNS = {
  transactions: [
    col(0, "id", "INTEGER", { pk: 1 }),
    col(1, "amount", "DECIMAL_TEXT(18,4)", { notnull: 1 }),
    col(2, "currency", "TEXT", { notnull: 1 }),
    col(3, "is_active", "BOOLEAN", { notnull: 1, dflt: "1" }),
  ],
  tags: [col(0, "id", "INTEGER", { pk: 1 }), col(1, "slug", "TEXT", { notnull: 1 })],
  accounts: [
    col(0, "id", "INTEGER", { pk: 1 }),
    col(1, "funding_account_id", "INTEGER"),
  ],
  // A table with no primary key (read-only for writes).
  kv_settings: [col(0, "k", "TEXT", { notnull: 1 }), col(1, "v", "TEXT")],
  mv_monthly_summary: [
    col(0, "month", "DATE_TEXT", { pk: 1 }),
    col(1, "total", "DECIMAL_TEXT"),
  ],
  // One column of every storage type.
  typed: [
    col(0, "id", "BIGINT", { pk: 1, dflt: "(nextval('typed_id_seq'))" }),
    col(1, "small", "INTEGER"),
    col(2, "ratio", "REAL"),
    col(3, "flag", "BOOLEAN"),
    col(4, "at", "TIMESTAMPTZ_TEXT"),
    col(5, "day", "DATE_TEXT"),
    col(6, "doc", "JSONB_TEXT"),
    col(7, "raw", "JSON_TEXT"),
    col(8, "tags", "TEXT_ARRAY"),
    col(9, "uid", "UUID_TEXT"),
    col(10, "price", "DECIMAL_TEXT(20,10)"),
  ],
};

/** Route a top-level query() call to the right catalog fixture. */
function catalogRouter(table: string) {
  // The table name is a runtime string: tables outside the fixtures are empty.
  const columnsByTable: Record<string, unknown[] | undefined> = COLUMNS;
  return (sql: string) => {
    if (sql.includes("pragma_table_list")) {
      return { rows: ALLOWED_TABLES.map((name) => ({ name })) };
    }
    if (sql.includes("pragma_table_xinfo")) {
      return { rows: columnsByTable[table] ?? [] };
    }
    return { rows: [] };
  };
}

/**
 * A fake connection client. readRows' snapshot and applyMutations'
 * transaction run on it; the transaction records BEGIN / COMMIT / ROLLBACK.
 */
function makeClient(handlers: ClientHandler[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client: FakeClient = {
    query: vi.fn((sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      for (const [needle, value] of handlers) {
        if (sql.includes(needle))
          return Promise.resolve(
            typeof value === "function" ? value(sql, params) : value,
          );
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
  withReadSnapshot.mockImplementation((fn) => fn(client));
  withTransaction.mockImplementation(async (fn) => {
    calls.push({ sql: "BEGIN IMMEDIATE", params: [] });
    try {
      const result = await fn(client);
      calls.push({ sql: "COMMIT", params: [] });
      return result;
    } catch (err) {
      calls.push({ sql: "ROLLBACK", params: [] });
      throw err;
    }
  });
  return { client, calls };
}

/** The version read applyOne runs before an UPDATE / DELETE. */
const VERSION_READ = "AS __xmin FROM";

beforeEach(() => vi.clearAllMocks());

// ── Introspection ───────────────────────────────────────────────────────────

describe("getTableMeta", () => {
  it("returns columns and primary key for a known table", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const meta = await getTableMeta("transactions");
    expect(meta.primaryKey).toEqual(["id"]);
    expect(meta.columns.map((c) => c.name)).toEqual([
      "id",
      "amount",
      "currency",
      "is_active",
    ]);
    expect(meta.columns.every((c) => c.writable)).toBe(true);
  });

  it("rejects an unknown table with 404", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    await expect(
      getTableMeta('robert"; DROP TABLE x;--'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("reports PostgreSQL's type names for the declared storage types", async () => {
    query.mockImplementation(catalogRouter("typed"));
    const meta = await getTableMeta("typed");
    const types = Object.fromEntries(
      meta.columns.map((c) => [c.name, [c.dataType, c.udtName]]),
    );
    expect(types).toEqual({
      id: ["bigint", "int8"],
      small: ["integer", "int4"],
      ratio: ["double precision", "float8"],
      // The UI edits a boolean with a checkbox when udtName is "bool".
      flag: ["boolean", "bool"],
      at: ["timestamp with time zone", "timestamptz"],
      day: ["date", "date"],
      doc: ["jsonb", "jsonb"],
      raw: ["json", "json"],
      tags: ["ARRAY", "_text"],
      uid: ["uuid", "uuid"],
      price: ["numeric", "numeric"],
    });
    const id = must(meta.columns.find((c) => c.name === "id"), "id column");
    // A key column is never nullable; a column default counts as a default.
    expect(id).toMatchObject({ nullable: false, hasDefault: true });
  });

  it("counts an INTEGER PRIMARY KEY (the rowid) as defaulted", async () => {
    query.mockImplementation(catalogRouter("tags"));
    const meta = await getTableMeta("tags");
    expect(meta.columns.find((c) => c.name === "id")).toMatchObject({
      hasDefault: true,
      nullable: false,
    });
    expect(meta.columns.find((c) => c.name === "slug")).toMatchObject({
      hasDefault: false,
      nullable: false,
    });
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────

describe("readRows", () => {
  it("reads on a read-only snapshot and returns a bounded row page", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const { client } = makeClient([
      [
        "SELECT *",
        {
          rows: [
            {
              id: 1,
              amount: "10.0000",
              currency: "EUR",
              is_active: true,
              __xmin: "1,'10.0000','EUR',1",
            },
          ],
        },
      ],
    ]);

    const result = await readRows("transactions", { limit: 25 });

    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    // The version token is a digest of the stored values.
    expect(must(result.rows[0], "result.rows[0]").__xmin).toBe(
      token("1,'10.0000','EUR',1"),
    );
    expect(withReadSnapshot).toHaveBeenCalledOnce();
    expect(withTransaction).not.toHaveBeenCalled();
    const issued = client.query.mock.calls.map((c) => c[0]);
    expect(
      issued.some((s) =>
        s.includes(
          `quote("id") || ',' || quote("amount") || ',' || quote("currency") || ',' || quote("is_active") AS __xmin`,
        ),
      ),
    ).toBe(true);
    expect(issued.some((s) => s.includes("LIMIT 26"))).toBe(true);
    expect(issued.some((s) => s.includes("count(*)"))).toBe(false);
  });

  it("uses a short first page as the exact total without running COUNT(*)", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const rows = [
      { id: 1, amount: "10.0000", currency: "EUR", is_active: true, __xmin: "a" },
      { id: 2, amount: "20.0000", currency: "EUR", is_active: true, __xmin: "b" },
    ];
    const { client } = makeClient([["SELECT *", { rows }]]);

    const result = await readRows("transactions", { limit: 25 });

    expect(result.total).toBe(2);
    expect(
      client.query.mock.calls.some(([sql]) => sql.includes("count(*)")),
    ).toBe(false);
    expect(
      client.query.mock.calls.some(([sql]) =>
        sql.includes("::bigint AS total"),
      ),
    ).toBe(false);
    expect(withReadSnapshot).toHaveBeenCalledOnce();
  });

  it("fetches one extra row instead of counting when a page is full", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: index + 1,
      __vision_cursor_value_1: String(index + 1),
    }));
    const { client } = makeClient([["SELECT *", { rows }]]);

    const result = await readRows("transactions", { limit: 2 });

    expect(result.total).toBeUndefined();
    expect(result.rows).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(
      client.query.mock.calls.filter(([sql]) => sql.includes("count(*)")),
    ).toHaveLength(0);
  });

  it("uses a filtered short first page as the exact filtered total", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const { client } = makeClient([
      ["SELECT *", { rows: [{ id: 1, currency: "EUR" }] }],
    ]);

    const result = await readRows("transactions", {
      limit: 25,
      filters: [{ column: "currency", op: "eq", value: "EUR" }],
    });

    expect(result.total).toBe(1);
    expect(
      client.query.mock.calls.some(([sql]) => sql.includes("count(*)")),
    ).toBe(false);
    expect(
      client.query.mock.calls.some(([sql]) =>
        sql.includes("::bigint AS total"),
      ),
    ).toBe(false);
    const dataCall = must(
      client.query.mock.calls.find(([sql]) => sql.includes("SELECT *")),
      "SELECT * call",
    );
    expect(dataCall[1]).toEqual(["EUR"]);
  });

  it("rejects any raw WHERE parameter (escape hatch removed — SQLi oracle)", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    makeClient([]);
    // Even a benign-looking clause is refused: the structured filters[] path
    // is the only way to filter now.
    await expect(
      readRows("transactions", { where: "amount > 0" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readRows("transactions", { where: "1=1; DROP TABLE transactions" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not run any SQL when a raw WHERE is supplied (rejected before query)", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const { calls } = makeClient([]);
    await expect(
      readRows("transactions", { where: "pg_sleep(5)" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls.some((c) => c.sql.includes("SELECT *"))).toBe(false);
  });

  it("rejects sorting by an unknown column", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    makeClient([]);
    await expect(
      readRows("transactions", { orderBy: "evil" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("parameterizes structured filters", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const { client } = makeClient([["SELECT *", { rows: [] }]]);

    await readRows("transactions", {
      filters: [{ column: "currency", op: "eq", value: "EUR" }],
    });
    const dataCall = must(
      client.query.mock.calls.find((c) => c[0].includes("SELECT *")),
      'client.query.mock.calls.find((c) => c[0].includes("SELECT *"',
    );
    expect(dataCall[0]).toContain('"currency" = $1');
    expect(dataCall[1]).toEqual(["EUR"]);
  });

  it("compares a decimal filter exactly through dec_*", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const { client } = makeClient([["SELECT *", { rows: [] }]]);

    await readRows("transactions", {
      filters: [
        { column: "amount", op: "gte", value: 0.1 },
        { column: "amount", op: "lt", value: "99999999999999.9999" },
        { column: "amount", op: "ne", value: "-0.0001" },
      ],
    });
    const [sql, params] = must(
      client.query.mock.calls.find((c) => c[0].includes("SELECT *")),
      "SELECT * call",
    );
    expect(sql).toContain(
      'WHERE dec_ge("amount", $1) AND dec_lt("amount", $2) AND dec_ne("amount", $3)',
    );
    // Bound as decimal text, never as a float.
    expect(params).toEqual(["0.1", "99999999999999.9999", "-0.0001"]);
  });

  it("reads a boolean filter as PostgreSQL's boolean input did", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const { client } = makeClient([["SELECT *", { rows: [] }]]);

    await readRows("transactions", {
      filters: [
        { column: "is_active", op: "eq", value: "yes" },
        { column: "is_active", op: "ne", value: false },
        { column: "is_active", op: "contains", value: "tru" },
      ],
    });
    const [sql, params] = must(
      client.query.mock.calls.find((c) => c[0].includes("SELECT *")),
      "SELECT * call",
    );
    expect(sql).toContain('"is_active" = $1 AND "is_active" <> $2');
    // contains matches the PostgreSQL text form ('true'/'false'), not 1/0.
    expect(sql).toContain(
      `ilike((CASE "is_active" WHEN 1 THEN 'true' WHEN 0 THEN 'false' END), $3)`,
    );
    expect(params).toEqual([1, 0, "%tru%"]);
  });

  it("wraps typed filters in their storage functions", async () => {
    query.mockImplementation(catalogRouter("typed"));
    const { client } = makeClient([["SELECT *", { rows: [] }]]);

    await readRows("typed", {
      filters: [
        { column: "at", op: "gte", value: "2026-03-29 01:59:59+00" },
        { column: "day", op: "lte", value: "2024-02-29T23:30:00Z" },
        { column: "doc", op: "eq", value: { b: 1, a: [true] } },
        { column: "uid", op: "eq", value: "{A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11}" },
        { column: "id", op: "eq", value: "9223372036854775807" },
      ],
    });
    const [sql, params] = must(
      client.query.mock.calls.find((c) => c[0].includes("SELECT *")),
      "SELECT * call",
    );
    expect(sql).toContain(
      '"at" >= vision_ts($1) AND "day" <= ts_date($2) AND "doc" = vision_jsonb($3) AND "uid" = $4 AND "id" = $5',
    );
    expect(params).toEqual([
      "2026-03-29 01:59:59+00",
      // A date compares by its calendar day; the time is ignored, as
      // PostgreSQL's date input ignored it.
      "2024-02-29",
      '{"b":1,"a":[true]}',
      "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      9223372036854775807n,
    ]);
  });

  it("rejects a filter value its column type cannot read before running SQL", async () => {
    query.mockImplementation(catalogRouter("typed"));
    const { calls } = makeClient([]);
    await expect(
      readRows("typed", { filters: [{ column: "small", op: "eq", value: "12abc" }] }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Invalid value for column type: invalid input syntax for type integer: "12abc"',
    });
    await expect(
      readRows("typed", { filters: [{ column: "small", op: "eq", value: "2147483648" }] }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Invalid value for column type: value "2147483648" is out of range for type integer',
    });
    expect(calls).toEqual([]);
  });

  it("sorts a decimal column through dec_key", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const { client } = makeClient([["SELECT *", { rows: [] }]]);
    await readRows("transactions", { orderBy: "amount", dir: "desc" });
    const [sql] = must(
      client.query.mock.calls.find((c) => c[0].includes("SELECT *")),
      "SELECT * call",
    );
    expect(sql).toContain('ORDER BY dec_key("amount") DESC NULLS LAST, "id" DESC NULLS LAST');
  });

  it("sends DATE cells as calendar days", async () => {
    query.mockImplementation(catalogRouter("typed"));
    makeClient([
      ["SELECT *", { rows: [{ id: "1", day: new Date(2024, 1, 29), __xmin: "x" }] }],
    ]);
    const result = await readRows("typed", {});
    expect(must(result.rows[0], "row").day).toBe("2024-02-29");
  });
});

// ── Mutations — dry run ─────────────────────────────────────────────────────

describe("applyMutations (dryRun)", () => {
  it("previews an UPDATE with inlined literals without touching the DB", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const result = await applyMutations(
      "transactions",
      [{ op: "update", pk: { id: 5 }, xmin: "500", set: { amount: "20" } }],
      { dryRun: true },
    );
    expect(withTransaction).not.toHaveBeenCalled();
    expect(withReadSnapshot).not.toHaveBeenCalled();
    expect(
      must(
        must(result.statements, "result.statements")[0],
        "result.statements[0]",
      ).preview,
    ).toBe(
      'UPDATE "transactions" SET "amount" = vision_numeric(\'20\', 18, 4) WHERE "id" = 5 RETURNING *',
    );
  });

  it("previews each typed write through its storage function", async () => {
    query.mockImplementation(catalogRouter("typed"));
    const result = await applyMutations(
      "typed",
      [
        {
          op: "insert",
          values: {
            small: 1,
            at: "2026-10-25T02:30:00+02:00",
            day: "2026-10-31",
            doc: { a: 1 },
            price: "0.1234567891",
            raw: '{"k": 1}',
          },
        },
      ],
      { dryRun: true },
    );
    expect(must(must(result.statements, "statements")[0], "statement").preview).toBe(
      'INSERT INTO "typed" ("small", "at", "day", "doc", "price", "raw") VALUES (1, vision_ts(\'2026-10-25T02:30:00+02:00\'), ts_date(\'2026-10-31\'), vision_jsonb(\'{"a":1}\'), vision_numeric(\'0.1234567891\', 20, 10), \'{"k": 1}\') RETURNING *',
    );
  });

  it("refuses to edit a primary-key column", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    await expect(
      applyMutations(
        "transactions",
        [{ op: "update", pk: { id: 5 }, set: { id: 9 } }],
        { dryRun: true },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to edit a table with no primary key", async () => {
    query.mockImplementation(catalogRouter("kv_settings"));
    await expect(
      applyMutations(
        "kv_settings",
        [{ op: "update", pk: {}, set: { v: "x" } }],
        { dryRun: true },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

// ── Mutations — execution ───────────────────────────────────────────────────

describe("applyMutations (execute)", () => {
  it("checks an account's version and updates it inside one write transaction", async () => {
    // BEGIN IMMEDIATE holds the database write lock for the whole batch, which
    // is what the PostgreSQL funding-graph advisory lock serialized.
    query.mockImplementation(catalogRouter("accounts"));
    const { calls } = makeClient([
      [VERSION_READ, { rowCount: 1, rows: [{ __xmin: "5,NULL" }] }],
      ["UPDATE", { rows: [{ id: 5, funding_account_id: 8 }], rowCount: 1 }],
    ]);

    await applyMutations("accounts", [
      {
        op: "update",
        pk: { id: 5 },
        xmin: token("5,NULL"),
        set: { funding_account_id: 8 },
      },
    ]);

    expect(withTransaction).toHaveBeenCalledOnce();
    expect(calls.map((c) => c.sql.split(" ")[0])).toEqual([
      "BEGIN",
      "SELECT", // version check
      "UPDATE",
      "SELECT", // the row as stored after its triggers
      "COMMIT",
    ]);
    expect(must(calls[1], "version read").sql).toBe(
      `SELECT quote("id") || ',' || quote("funding_account_id") AS __xmin FROM "accounts" WHERE "id" = $1`,
    );
  });

  it("checks version, updates, re-reads the row, and schedules a view refresh", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const { calls } = makeClient([
      [VERSION_READ, { rowCount: 1, rows: [{ __xmin: "5,'10.0000','EUR',1" }] }],
      [
        "UPDATE",
        { rows: [{ id: 5, amount: "20.0000", currency: "EUR", is_active: true }] },
      ],
      [
        'SELECT * FROM "transactions" WHERE',
        {
          rows: [
            {
              id: 5,
              amount: "20.0000",
              currency: "EUR",
              is_active: true,
              updated_at: new Date("2026-11-03T10:00:00.000Z"),
            },
          ],
        },
      ],
    ]);

    const result = await applyMutations("transactions", [
      {
        op: "update",
        pk: { id: 5 },
        xmin: token("5,'10.0000','EUR',1"),
        set: { amount: "20", is_active: "f" },
      },
    ]);

    expect(result.applied).toBe(1);
    expect(result.refreshScheduled).toBe(true);
    expect(scheduleRefresh).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.sql === "COMMIT")).toBe(true);
    const update = must(calls.find((c) => c.sql.startsWith("UPDATE")), "UPDATE");
    expect(update.sql).toBe(
      'UPDATE "transactions" SET "amount" = vision_numeric($1, 18, 4), "is_active" = $2 WHERE "id" = $3 RETURNING *',
    );
    // Money stays decimal text; the boolean is stored as 0/1.
    expect(update.params).toEqual(["20", 0, 5]);
    // `after` is the row after its AFTER triggers ran (updated_at).
    expect(must(result.results, "results")[0]?.after).toMatchObject({
      amount: "20.0000",
      updated_at: new Date("2026-11-03T10:00:00.000Z"),
    });
  });

  it("returns a 409 conflict when the row version changed", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    const { calls } = makeClient([
      [VERSION_READ, { rowCount: 1, rows: [{ __xmin: "5,'10.0001','EUR',1" }] }],
    ]);

    await expect(
      applyMutations("transactions", [
        {
          op: "update",
          pk: { id: 5 },
          xmin: token("5,'10.0000','EUR',1"),
          set: { amount: "20" },
        },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls.some((c) => c.sql === "ROLLBACK")).toBe(true);
    expect(calls.some((c) => c.sql.startsWith("UPDATE"))).toBe(false);
  });

  it("returns a 409 conflict when the row was deleted", async () => {
    query.mockImplementation(catalogRouter("transactions"));
    makeClient([[VERSION_READ, { rowCount: 0, rows: [] }]]);

    await expect(
      applyMutations("transactions", [
        { op: "delete", pk: { id: 5 }, xmin: "500" },
      ]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("does not schedule a refresh for non-matview tables", async () => {
    query.mockImplementation(catalogRouter("tags"));
    makeClient([
      ['INSERT INTO "tags"', { rows: [{ id: 7, slug: "new" }] }],
    ]);

    const result = await applyMutations("tags", [
      { op: "insert", values: { slug: "new" } },
    ]);
    expect(result.applied).toBe(1);
    expect(result.refreshScheduled).toBe(false);
    expect(scheduleRefresh).not.toHaveBeenCalled();
    // With no row read back, `after` is the RETURNING row.
    expect(must(result.results, "results")[0]?.after).toEqual({ id: 7, slug: "new" });
  });

  it("binds each value as its column's storage holds it", async () => {
    query.mockImplementation(catalogRouter("typed"));
    const { calls } = makeClient([
      ['INSERT INTO "typed"', { rows: [{ id: "9223372036854775807" }] }],
    ]);

    await applyMutations("typed", [
      {
        op: "insert",
        values: {
          id: "9223372036854775807",
          small: " -2147483648 ",
          ratio: "0.30000000000000004",
          flag: "on",
          at: "2026-10-25 02:30:00+02",
          day: new Date(2026, 9, 31),
          doc: [1, "x"],
          raw: { k: 1 },
          tags: '["a","b"]',
          uid: "A0EEBC999C0B4EF8BB6D6BB9BD380A11",
          price: 0.1,
        },
      },
    ]);
    const insert = must(calls.find((c) => c.sql.startsWith("INSERT")), "INSERT");
    expect(insert.params).toEqual([
      9223372036854775807n,
      -2147483648,
      0.30000000000000004,
      1,
      "2026-10-25 02:30:00+02",
      "2026-10-31",
      '[1,"x"]',
      '{"k":1}',
      '["a","b"]',
      "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      "0.1",
    ]);
    // The row is read back by its exact bigint key.
    const readBack = must(
      calls.find((c) => c.sql.startsWith('SELECT * FROM "typed"')),
      "read back",
    );
    expect(readBack.params).toEqual([9223372036854775807n]);
  });

  it("rejects a value its column type cannot read and rolls the batch back", async () => {
    query.mockImplementation(catalogRouter("typed"));
    const { calls } = makeClient([
      ['INSERT INTO "typed"', { rows: [{ id: "1" }] }],
    ]);

    await expect(
      applyMutations("typed", [
        { op: "insert", values: { small: 1 } },
        { op: "insert", values: { flag: "maybe" } },
      ]),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Invalid value for column type: invalid input syntax for type boolean: "maybe"',
    });
    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
    await expect(
      applyMutations("typed", [{ op: "insert", values: { tags: "{a,b}" } }]),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Invalid value for column type: malformed array literal: "{a,b}"',
    });
    await expect(
      applyMutations("typed", [{ op: "insert", values: { id: "9223372036854775808" } }]),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Invalid value for column type: value "9223372036854775808" is out of range for type bigint',
    });
  });

  it("keeps the former materialized views read-only", async () => {
    query.mockImplementation(catalogRouter("mv_monthly_summary"));
    const { calls } = makeClient([]);
    await expect(
      applyMutations("mv_monthly_summary", [
        { op: "update", pk: { month: "2026-01-01" }, set: { total: "1" } },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
});

// ── Constraint-error mapping ────────────────────────────────────────────────

describe("mapDbError (via applyMutations)", () => {
  function failingInsert(code: string, fields: Partial<DbError> = {}) {
    query.mockImplementation(catalogRouter("tags"));
    makeClient([
      [
        'INSERT INTO "tags"',
        () => {
          const e: DbError = Object.assign(new Error(fields.message ?? "driver error"), fields);
          e.code = code;
          throw e;
        },
      ],
    ]);
  }

  it("maps a unique violation to a 409 conflict", async () => {
    failingInsert("23505", { constraint: "tags_slug_key" });
    await expect(
      applyMutations("tags", [{ op: "insert", values: { slug: "dup" } }]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("maps a not-null violation to a 400 validation error", async () => {
    failingInsert("23502", { column: "slug" });
    await expect(
      applyMutations("tags", [{ op: "insert", values: { slug: "" } }]),
    ).rejects.toMatchObject({ status: 400, message: 'Column "slug" cannot be empty' });
  });

  it("maps a RESTRICT foreign-key failure like a foreign-key violation", async () => {
    failingInsert("23001");
    await expect(
      applyMutations("tags", [{ op: "insert", values: { slug: "x" } }]),
    ).rejects.toMatchObject({
      status: 400,
      message: "References a row that does not exist (foreign key)",
    });
  });

  it("maps a storage function's input error to a 400 with its message", async () => {
    failingInsert("22P02", { message: 'invalid input syntax for type numeric: "abc"' });
    await expect(
      applyMutations("tags", [{ op: "insert", values: { slug: "x" } }]),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Invalid value for column type: invalid input syntax for type numeric: "abc"',
    });
  });

  it("does not leak raw driver text for syntax/undefined-object errors", async () => {
    failingInsert("42703", { message: "no such column: secret_internal_col" });
    await expect(
      applyMutations("tags", [{ op: "insert", values: { slug: "x" } }]),
    ).rejects.toMatchObject({ status: 400, message: "Invalid query" });
  });

  /** withTransaction rejects before its callback: the write-lock wait timed out. */
  function writeLockTimeout(table: string) {
    query.mockImplementation(catalogRouter(table));
    const { calls } = makeClient([]);
    withTransaction.mockImplementation(() => {
      const e: DbError = Object.assign(
        new Error("Timed out after 5000 ms waiting for the database write lock"),
        { code: "55P03" },
      );
      return Promise.reject(e);
    });
    return calls;
  }

  it("answers a funding-graph write-lock timeout with the retryable 503", async () => {
    const calls = writeLockTimeout("accounts");
    await expect(
      applyMutations("accounts", [
        { op: "update", pk: { id: 1 }, set: { funding_account_id: 2 } },
      ]),
    ).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Account funding graph is busy; retry the request",
    });
    expect(calls).toEqual([]);
  });

  it("answers a write-lock timeout on any other table with a retryable 503", async () => {
    writeLockTimeout("tags");
    await expect(
      applyMutations("tags", [{ op: "insert", values: { slug: "x" } }]),
    ).rejects.toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Database is busy; retry the request",
    });
  });
});
