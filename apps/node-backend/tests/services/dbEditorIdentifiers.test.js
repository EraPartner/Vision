/**
 * Identifier safety on the admin DB editor.
 *
 * Table, column and sort identifiers cannot be parameterized, so they are
 * interpolated into the SQL text. The rule this suite pins is that the caller's
 * string is only ever a *lookup key*: what gets interpolated is the matching
 * name taken from pg's catalog (resolveIdent). A caller value that is not in
 * the catalog must be rejected, never quoted-and-used.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockConnection } from "../helpers/repoMocks.js";

vi.mock("../../src/database/connection.js", () => mockConnection());
vi.mock("../../src/services/aggregationRefresh.js", () => ({
  scheduleAggregationRefresh: vi.fn(),
}));

import { query, getClient } from "../../src/database/connection.js";
import {
  __clearDbEditorMetadataCacheForTests,
  getTableMeta,
  readRows,
  applyMutations,
} from "../../src/services/dbEditor.js";

const CATALOG_TABLE = "transactions";
const CATALOG_COLUMNS = ["id", "amount", "memo"];

/** @param {string} name */
function catalogColumnRow(name, ordinal) {
  return {
    column_name: name,
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    column_default: null,
    is_generated: "NEVER",
    is_identity: "NO",
    ordinal_position: ordinal,
  };
}

/** SQL statements seen by the pooled client during the last call. */
let clientSql = [];

beforeEach(() => {
  vi.clearAllMocks();
  __clearDbEditorMetadataCacheForTests();
  clientSql = [];

  query.mockImplementation(async (sql) => {
    if (sql.includes("pg_stat_user_tables")) {
      return { rows: [{ relname: CATALOG_TABLE }] };
    }
    if (sql.includes("information_schema.columns")) {
      return {
        rows: CATALOG_COLUMNS.map((c, i) => catalogColumnRow(c, i + 1)),
      };
    }
    if (sql.includes("indisprimary")) {
      return { rows: [{ column_name: "id" }] };
    }
    throw new Error(`unexpected catalog query: ${sql}`);
  });

  getClient.mockResolvedValue({
    query: vi.fn(async (sql, params = []) => {
      clientSql.push(sql);
      if (sql.startsWith("SELECT count(")) return { rows: [{ total: "0" }] };
      if (/^SELECT \$\d+::bigint AS total$/.test(sql)) {
        return { rows: [{ total: params.at(-1) }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  });
});

describe("table identifiers", () => {
  it("rejects a table that is not in the catalog", async () => {
    await expect(readRows("transactions; DROP TABLE users")).rejects.toThrow(
      /Unknown table/,
    );
    expect(clientSql).toEqual([]);
  });

  it("rejects a table name that only differs by case", async () => {
    // Postgres identifiers are case-sensitive once quoted, so "Transactions"
    // is genuinely a different table — the lookup must not fold case.
    await expect(readRows("Transactions")).rejects.toThrow(/Unknown table/);
  });

  it("reports the catalog name back on the metadata", async () => {
    const meta = await getTableMeta(CATALOG_TABLE);
    expect(meta.table).toBe(CATALOG_TABLE);
  });
});

describe("filter identifiers", () => {
  it("rejects a filter column that is not in the catalog", async () => {
    await expect(
      readRows(CATALOG_TABLE, {
        filters: [{ column: "amount) OR pg_sleep(5)--", op: "eq", value: 1 }],
      }),
    ).rejects.toThrow(/Unknown filter column/);
    expect(clientSql).toEqual([]);
  });

  it("rejects an operator outside the allowlist", async () => {
    await expect(
      readRows(CATALOG_TABLE, {
        filters: [{ column: "amount", op: "raw", value: 1 }],
      }),
    ).rejects.toThrow(/Unknown filter operator/);
  });

  it("parameterizes the value and interpolates only the catalog column", async () => {
    await readRows(CATALOG_TABLE, {
      filters: [{ column: "memo", op: "eq", value: "'; DROP TABLE x--" }],
    });
    const dataSql = clientSql.find((s) => s.startsWith("SELECT *"));
    expect(dataSql).toContain('WHERE "memo" = $1');
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("still rejects the removed raw WHERE escape hatch", async () => {
    await expect(readRows(CATALOG_TABLE, { where: "1=1" })).rejects.toThrow(
      /raw WHERE parameter has been removed/,
    );
    expect(clientSql).toEqual([]);
  });
});

describe("sort identifiers", () => {
  it("rejects a sort column that is not in the catalog", async () => {
    await expect(
      readRows(CATALOG_TABLE, { orderBy: "id; DROP TABLE users" }),
    ).rejects.toThrow(/Unknown sort column/);
    expect(clientSql).toEqual([]);
  });

  it("constrains the sort direction to ASC or DESC", async () => {
    await readRows(CATALOG_TABLE, {
      orderBy: "amount",
      dir: "DESC; DROP TABLE users",
    });
    const dataSql = clientSql.find((s) => s.startsWith("SELECT *"));
    // Anything that is not exactly "desc" falls back to ASC.
    expect(dataSql).toContain('ORDER BY "amount" ASC');
    expect(dataSql).not.toContain("DROP TABLE");
  });
});

describe("pagination", () => {
  it("coerces the limit and never emits count or offset queries", async () => {
    await readRows(CATALOG_TABLE, {
      limit: "10; DROP TABLE users",
    });
    const dataSql = clientSql.find((s) => s.startsWith("SELECT *"));
    expect(dataSql).toMatch(/LIMIT \d+$/);
    expect(dataSql).not.toContain("OFFSET");
    expect(clientSql.some((sql) => sql.includes("count(*)"))).toBe(false);
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("binds an opaque cursor to sort, filters, and a primary-key tie-breaker", async () => {
    getClient.mockResolvedValueOnce({
      query: vi.fn(async (sql) => {
        clientSql.push(sql);
        if (sql.startsWith("SELECT *")) {
          return {
            rows: [
              {
                id: 1,
                amount: 10,
                memo: "a",
                __vision_cursor_value_1: "10",
                __vision_cursor_value_2: "1",
              },
              {
                id: 2,
                amount: 10,
                memo: "b",
                __vision_cursor_value_1: "10",
                __vision_cursor_value_2: "2",
              },
              {
                id: 3,
                amount: null,
                memo: "c",
                __vision_cursor_value_1: null,
                __vision_cursor_value_2: "3",
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const page = await readRows(CATALOG_TABLE, {
      limit: 2,
      orderBy: "amount",
      dir: "desc",
      filters: [{ column: "memo", op: "contains", value: "shop" }],
    });
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));

    clientSql = [];
    await readRows(CATALOG_TABLE, {
      limit: 2,
      cursor: page.nextCursor,
      orderBy: "amount",
      dir: "desc",
      filters: [{ column: "memo", op: "contains", value: "shop" }],
    });
    const cursorSql = clientSql.find((sql) => sql.startsWith("SELECT *"));
    expect(cursorSql).toContain(
      'ORDER BY "amount" DESC NULLS LAST, "id" DESC NULLS LAST',
    );
    expect(cursorSql).toContain('"amount" IS NOT DISTINCT FROM');
    expect(cursorSql).toContain('"id" <');

    await expect(
      readRows(CATALOG_TABLE, {
        cursor: page.nextCursor,
        orderBy: "id",
        dir: "desc",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("uses exact PostgreSQL text projections for typed cursor values", async () => {
    const timestamp = new Date("2026-09-08T10:11:12.123Z");
    getClient.mockResolvedValueOnce({
      query: vi.fn(async (sql) => {
        if (sql.startsWith("SELECT *")) {
          return {
            rows: [
              {
                id: 9n,
                amount: timestamp,
                memo: "a",
                __vision_cursor_value_1: "2026-09-08 10:11:12.123456+00",
                __vision_cursor_value_2: "9",
              },
              {
                id: 10n,
                amount: timestamp,
                memo: "b",
                __vision_cursor_value_1: "2026-09-08 10:11:12.123457+00",
                __vision_cursor_value_2: "10",
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const timestampPage = await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
    });

    let selectParams = [];
    getClient.mockResolvedValueOnce({
      query: vi.fn(async (sql, params = []) => {
        if (sql.startsWith("SELECT *")) selectParams = params;
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
      cursor: timestampPage.nextCursor,
    });
    expect(selectParams).toContain("2026-09-08 10:11:12.123456+00");
    expect(selectParams).toContain("9");

    getClient.mockResolvedValueOnce({
      query: vi.fn(async (sql) => {
        if (sql.startsWith("SELECT *")) {
          return {
            rows: [
              {
                id: 1,
                amount: Buffer.from([0, 255, 16]),
                memo: "a",
                __vision_cursor_value_1: "\\x00ff10",
                __vision_cursor_value_2: "1",
              },
              {
                id: 2,
                amount: Number.POSITIVE_INFINITY,
                memo: "b",
                __vision_cursor_value_1: "Infinity",
                __vision_cursor_value_2: "2",
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const byteaPage = await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
    });
    selectParams = [];
    getClient.mockResolvedValueOnce({
      query: vi.fn(async (sql, params = []) => {
        if (sql.startsWith("SELECT *")) selectParams = params;
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
      cursor: byteaPage.nextCursor,
    });
    expect(selectParams).toContain("\\x00ff10");
  });

  it("uses a collision-free hidden ctid alias for a table without a primary key", async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes("pg_stat_user_tables")) {
        return { rows: [{ relname: CATALOG_TABLE }] };
      }
      if (sql.includes("information_schema.columns")) {
        return {
          rows: [
            ...CATALOG_COLUMNS.map((c, i) => catalogColumnRow(c, i + 1)),
            catalogColumnRow("__vision_cursor_value_1", 4),
          ],
        };
      }
      if (sql.includes("indisprimary")) return { rows: [] };
      throw new Error(`unexpected catalog query: ${sql}`);
    });
    getClient.mockResolvedValueOnce({
      query: vi.fn(async (sql) => {
        clientSql.push(sql);
        if (sql.startsWith("SELECT *")) {
          return {
            rows: [
              {
                id: 1,
                amount: 10,
                memo: "a",
                __vision_cursor_value_1: "user value",
                __vision_cursor_value_1_2: "(0,1)",
              },
              {
                id: 2,
                amount: 20,
                memo: "b",
                __vision_cursor_value_1: "other value",
                __vision_cursor_value_1_2: "(0,2)",
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const page = await readRows(CATALOG_TABLE, { limit: 1 });
    expect(page.rows[0].__vision_cursor_value_1).toBe("user value");
    expect(page.rows[0]).not.toHaveProperty("__vision_cursor_value_1_2");
    expect(clientSql.find((sql) => sql.startsWith("SELECT *"))).toContain(
      '(ctid)::text AS "__vision_cursor_value_1_2"',
    );

    clientSql = [];
    await readRows(CATALOG_TABLE, { limit: 1, cursor: page.nextCursor });
    expect(clientSql.find((sql) => sql.startsWith("SELECT *"))).toContain(
      "ctid > $1::tid",
    );
  });

  it("continues from a null sort boundary through composite primary keys", async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes("pg_stat_user_tables")) {
        return { rows: [{ relname: CATALOG_TABLE }] };
      }
      if (sql.includes("information_schema.columns")) {
        return {
          rows: CATALOG_COLUMNS.map((c, i) => catalogColumnRow(c, i + 1)),
        };
      }
      if (sql.includes("indisprimary")) {
        return { rows: [{ column_name: "id" }, { column_name: "memo" }] };
      }
      throw new Error(`unexpected catalog query: ${sql}`);
    });
    getClient.mockResolvedValueOnce({
      query: vi.fn(async (sql) => {
        if (sql.startsWith("SELECT *")) {
          return {
            rows: [
              {
                id: 1,
                amount: null,
                memo: "a",
                __vision_cursor_value_1: null,
                __vision_cursor_value_2: "1",
                __vision_cursor_value_3: "a",
              },
              {
                id: 2,
                amount: null,
                memo: "b",
                __vision_cursor_value_1: null,
                __vision_cursor_value_2: "2",
                __vision_cursor_value_3: "b",
              },
            ],
          };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const page = await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
    });
    clientSql = [];
    await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
      cursor: page.nextCursor,
    });
    const cursorSql = clientSql.find((sql) => sql.startsWith("SELECT *"));
    expect(cursorSql).toContain(
      'ORDER BY "amount" ASC NULLS LAST, "id" ASC NULLS LAST, "memo" ASC NULLS LAST',
    );
    expect(cursorSql).toContain('"amount" IS NOT DISTINCT FROM');
    expect(cursorSql).toContain('"memo" >');
  });
});

describe("mutation identifiers", () => {
  it("drops write columns that are not in the catalog instead of quoting them", async () => {
    const res = await applyMutations(
      CATALOG_TABLE,
      [{ op: "insert", values: { memo: "hi", 'memo") VALUES (1)--': "x" } }],
      { dryRun: true },
    );
    expect(res.dryRun).toBe(true);
    expect(res.statements[0].preview).toContain(
      'INSERT INTO "transactions" ("memo")',
    );
    expect(res.statements[0].preview).not.toContain("VALUES (1)--");
  });

  it("rejects a batch whose columns are all unknown", async () => {
    await expect(
      applyMutations(
        CATALOG_TABLE,
        [{ op: "insert", values: { "nope--": 1 } }],
        { dryRun: true },
      ),
    ).rejects.toThrow(/has no values/);
  });

  it("builds the UPDATE predicate from the catalog primary key", async () => {
    const res = await applyMutations(
      CATALOG_TABLE,
      [{ op: "update", pk: { id: 1 }, set: { memo: "x" } }],
      { dryRun: true },
    );
    expect(res.statements[0].preview).toContain(
      'UPDATE "transactions" SET "memo"',
    );
    expect(res.statements[0].preview).toContain('WHERE "id"');
  });
});
