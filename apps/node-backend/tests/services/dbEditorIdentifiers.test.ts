/**
 * Identifier safety on the admin DB editor.
 *
 * Table, column and sort identifiers cannot be parameterized, so they are
 * interpolated into the SQL text. The rule this suite pins is that the caller's
 * string is only ever a *lookup key*: what gets interpolated is the matching
 * name taken from SQLite's catalog (resolveIdent). A caller value that is not in
 * the catalog must be rejected, never quoted-and-used.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { mockConnection } from "../helpers/repoMocks.ts";

vi.mock("../../src/database/connection.ts", () =>
  mockConnection({ withReadSnapshot: vi.fn() }),
);
vi.mock("../../src/services/aggregationRefresh.ts", () => ({
  scheduleAggregationRefresh: vi.fn(),
}));

import * as connection from "../../src/database/connection.ts";
import {
  __clearDbEditorMetadataCacheForTests,
  getTableMeta,
  readRows,
  applyMutations,
} from "../../src/services/dbEditor.ts";
import { must } from "../helpers/must.ts";

/** The structural slice of the driver's query surface these fakes implement. */
type FakeQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;
interface FakeClient {
  query: Mock<FakeQuery>;
  release: Mock;
}
type SnapshotRunner = (fn: (client: FakeClient) => Promise<unknown>) => Promise<unknown>;

const query = connection.query as unknown as Mock<FakeQuery>;
const withReadSnapshot = connection.withReadSnapshot as unknown as Mock<SnapshotRunner>;

const CATALOG_TABLE = "transactions";
const CATALOG_COLUMNS = ["id", "amount", "memo"];

/** A `pragma_table_xinfo` row. */
function catalogColumnRow(name: string, cid: number, pk = 0, type = "TEXT", hidden = 0) {
  return { cid, name, type, notnull: 0, dflt_value: null, pk, hidden };
}

/** Route the catalog reads: the table list and the table's columns. */
function catalog(columns: ReturnType<typeof catalogColumnRow>[]) {
  query.mockImplementation((sql: string) => {
    if (sql.includes("pragma_table_list")) {
      return Promise.resolve({ rows: [{ name: CATALOG_TABLE }] });
    }
    if (sql.includes("pragma_table_xinfo")) {
      return Promise.resolve({ rows: columns });
    }
    return Promise.reject(new Error(`unexpected catalog query: ${sql}`));
  });
}

const defaultColumns = () =>
  CATALOG_COLUMNS.map((c, i) => catalogColumnRow(c, i, c === "id" ? 1 : 0));

/** SQL statements seen by the snapshot client during the last call. */
let clientSql: string[] = [];

/** A snapshot client that records its SQL and answers SELECT * with `rows`. */
function snapshotClient(rows: Record<string, unknown>[] = [], onSelect?: (params: unknown[]) => void): FakeClient {
  return {
    query: vi.fn((sql: string, params: unknown[] = []) => {
      clientSql.push(sql);
      if (sql.startsWith("SELECT *")) {
        onSelect?.(params);
        return Promise.resolve({ rows: rows.map((row) => ({ ...row })) });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  };
}

/** The next readRows call runs on this client. */
function nextSnapshot(client: FakeClient) {
  withReadSnapshot.mockImplementationOnce((fn) => fn(client));
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearDbEditorMetadataCacheForTests();
  clientSql = [];
  catalog(defaultColumns());
  withReadSnapshot.mockImplementation((fn) => fn(snapshotClient()));
});

describe("table identifiers", () => {
  it("rejects a table that is not in the catalog", async () => {
    await expect(readRows("transactions; DROP TABLE users")).rejects.toThrow(
      /Unknown table/,
    );
    expect(clientSql).toEqual([]);
  });

  it("rejects a table name that only differs by case", async () => {
    // PostgreSQL's quoted identifiers were case-sensitive, so "Transactions"
    // is not the catalog's table — the lookup must not fold case, even though
    // SQLite itself would.
    await expect(readRows("Transactions")).rejects.toThrow(/Unknown table/);
  });

  it("reports the catalog name back on the metadata", async () => {
    const meta = await getTableMeta(CATALOG_TABLE);
    expect(meta.table).toBe(CATALOG_TABLE);
  });

  it("lists only ordinary main-schema tables and reads columns by bound name", async () => {
    await getTableMeta(CATALOG_TABLE);
    const listSql = must(
      query.mock.calls.find(([sql]) => sql.includes("pragma_table_list")),
      "pragma_table_list call",
    )[0];
    expect(listSql).toContain("schema = 'main'");
    expect(listSql).toContain("type = 'table'");
    expect(listSql).toContain("NOT LIKE 'sqlite_%'");
    const columnsCall = must(
      query.mock.calls.find(([sql]) => sql.includes("pragma_table_xinfo")),
      "pragma_table_xinfo call",
    );
    // The table name is a bound parameter, never SQL text.
    expect(columnsCall[0]).toContain("pragma_table_xinfo($1)");
    expect(columnsCall[1]).toEqual([CATALOG_TABLE]);
  });

  it("keeps the sequence table out of the editor", async () => {
    query.mockImplementation((sql: string) =>
      Promise.resolve({
        rows: sql.includes("pragma_table_list")
          ? [{ name: CATALOG_TABLE }, { name: "vision_sequences" }]
          : defaultColumns(),
      }),
    );
    await expect(getTableMeta("vision_sequences")).rejects.toThrow(/Unknown table/);
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
      // @ts-expect-error -- a hostile string limit must be coerced at runtime
      limit: "10; DROP TABLE users",
    });
    const dataSql = clientSql.find((s) => s.startsWith("SELECT *"));
    expect(dataSql).toMatch(/LIMIT \d+$/);
    expect(dataSql).not.toContain("OFFSET");
    expect(clientSql.some((sql) => sql.includes("count(*)"))).toBe(false);
    expect(dataSql).not.toContain("DROP TABLE");
  });

  it("binds an opaque cursor to sort, filters, and a primary-key tie-breaker", async () => {
    nextSnapshot(
      snapshotClient([
        { id: 1, amount: 10, memo: "a", __vision_cursor_value_1: "10", __vision_cursor_value_2: "1" },
        { id: 2, amount: 10, memo: "b", __vision_cursor_value_1: "10", __vision_cursor_value_2: "2" },
        { id: 3, amount: null, memo: "c", __vision_cursor_value_1: null, __vision_cursor_value_2: "3" },
      ]),
    );
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
      cursor: must(page.nextCursor, "page.nextCursor"),
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
    expect(cursorSql).toContain('ilike(CAST("memo" AS TEXT), $1)');

    await expect(
      readRows(CATALOG_TABLE, {
        cursor: must(page.nextCursor, "page.nextCursor"),
        orderBy: "id",
        dir: "desc",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("projects the stored text for typed cursor values", async () => {
    nextSnapshot(
      snapshotClient([
        // The driver strips the `::text` hint from the key and returns the
        // stored text: timestamp microseconds and big integers stay exact.
        { id: "9007199254740993", amount: new Date("2026-09-08T10:11:12.123Z"), memo: "a", __vision_cursor_value_1: "2026-09-08T10:11:12.123456Z", __vision_cursor_value_2: "9007199254740993" },
        { id: "9007199254740994", amount: new Date("2026-09-08T10:11:12.123Z"), memo: "b", __vision_cursor_value_1: "2026-09-08T10:11:12.123457Z", __vision_cursor_value_2: "9007199254740994" },
      ]),
    );
    const timestampPage = await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
    });
    const firstSql = must(clientSql.find((sql) => sql.startsWith("SELECT *")), "data SQL");
    expect(firstSql).toContain('"amount" AS "__vision_cursor_value_1::text"');
    expect(firstSql).toContain('"id" AS "__vision_cursor_value_2::text"');

    let selectParams: unknown[] = [];
    nextSnapshot(snapshotClient([], (params) => (selectParams = params)));
    await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
      cursor: must(timestampPage.nextCursor, "timestampPage.nextCursor"),
    });
    expect(selectParams).toContain("2026-09-08T10:11:12.123456Z");
    expect(selectParams).toContain("9007199254740993");
  });

  it("orders and pages a decimal column by value, not by its text", async () => {
    catalog([
      catalogColumnRow("id", 0, 1, "INTEGER"),
      catalogColumnRow("amount", 1, 0, "DECIMAL_TEXT(18,4)"),
      catalogColumnRow("memo", 2),
    ]);
    nextSnapshot(
      snapshotClient([
        { id: 1, amount: "-10.0000", memo: "a", __vision_cursor_value_1: "-10.0000", __vision_cursor_value_2: "1" },
        { id: 2, amount: "9.5000", memo: "b", __vision_cursor_value_1: "9.5000", __vision_cursor_value_2: "2" },
      ]),
    );
    const page = await readRows(CATALOG_TABLE, { limit: 1, orderBy: "amount" });
    expect(clientSql.find((sql) => sql.startsWith("SELECT *"))).toContain(
      'ORDER BY dec_key("amount") ASC NULLS LAST, "id" ASC NULLS LAST',
    );

    clientSql = [];
    let selectParams: unknown[] = [];
    nextSnapshot(snapshotClient([], (params) => (selectParams = params)));
    await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
      cursor: must(page.nextCursor, "page.nextCursor"),
    });
    const cursorSql = must(clientSql.find((sql) => sql.startsWith("SELECT *")), "cursor SQL");
    expect(cursorSql).toContain('(dec_key("amount") > dec_key($1) OR "amount" IS NULL)');
    expect(cursorSql).toContain('dec_key("amount") IS NOT DISTINCT FROM dec_key($2)');
    // The boundary is the exact stored text.
    expect(selectParams).toEqual(["-10.0000", "-10.0000", "1"]);
  });

  it("uses a collision-free hidden rowid alias for a table without a primary key", async () => {
    catalog([
      ...CATALOG_COLUMNS.map((c, i) => catalogColumnRow(c, i)),
      catalogColumnRow("__vision_cursor_value_1", 3),
    ]);
    nextSnapshot(
      snapshotClient([
        { id: 1, amount: 10, memo: "a", __vision_cursor_value_1: "user value", __vision_cursor_value_1_2: "1" },
        { id: 2, amount: 20, memo: "b", __vision_cursor_value_1: "other value", __vision_cursor_value_1_2: "2" },
      ]),
    );
    const page = await readRows(CATALOG_TABLE, { limit: 1 });
    expect(must(page.rows[0], "page.rows[0]").__vision_cursor_value_1).toBe("user value");
    expect(page.rows[0]).not.toHaveProperty("__vision_cursor_value_1_2");
    expect(clientSql.find((sql) => sql.startsWith("SELECT *"))).toContain(
      'rowid AS "__vision_cursor_value_1_2::text"',
    );

    clientSql = [];
    await readRows(CATALOG_TABLE, { limit: 1, cursor: must(page.nextCursor, "page.nextCursor") });
    expect(clientSql.find((sql) => sql.startsWith("SELECT *"))).toContain(
      "rowid > CAST($1 AS INTEGER)",
    );
  });

  it("continues from a null sort boundary through composite primary keys", async () => {
    catalog(
      CATALOG_COLUMNS.map((c, i) =>
        catalogColumnRow(c, i, c === "id" ? 1 : c === "memo" ? 2 : 0),
      ),
    );
    nextSnapshot(
      snapshotClient([
        { id: 1, amount: null, memo: "a", __vision_cursor_value_1: null, __vision_cursor_value_2: "1", __vision_cursor_value_3: "a" },
        { id: 2, amount: null, memo: "b", __vision_cursor_value_1: null, __vision_cursor_value_2: "2", __vision_cursor_value_3: "b" },
      ]),
    );
    const page = await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
    });
    clientSql = [];
    await readRows(CATALOG_TABLE, {
      limit: 1,
      orderBy: "amount",
      cursor: must(page.nextCursor, "page.nextCursor"),
    });
    const cursorSql = clientSql.find((sql) => sql.startsWith("SELECT *"));
    expect(cursorSql).toContain(
      'ORDER BY "amount" ASC NULLS LAST, "id" ASC NULLS LAST, "memo" ASC NULLS LAST',
    );
    expect(cursorSql).toContain('"amount" IS NOT DISTINCT FROM');
    expect(cursorSql).toContain('"memo" >');
  });

  it("orders composite primary keys by their key position, not column order", async () => {
    catalog(
      CATALOG_COLUMNS.map((c, i) =>
        catalogColumnRow(c, i, c === "memo" ? 1 : c === "id" ? 2 : 0),
      ),
    );
    const meta = await getTableMeta(CATALOG_TABLE);
    expect(meta.primaryKey).toEqual(["memo", "id"]);
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
    expect(must(must(res.statements, "res.statements")[0], "res.statements![0]").preview).toContain(
      'INSERT INTO "transactions" ("memo")',
    );
    expect(must(must(res.statements, "res.statements")[0], "res.statements![0]").preview).not.toContain("VALUES (1)--");
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
    expect(must(must(res.statements, "res.statements")[0], "res.statements![0]").preview).toContain(
      'UPDATE "transactions" SET "memo"',
    );
    expect(must(must(res.statements, "res.statements")[0], "res.statements![0]").preview).toContain('WHERE "id"');
  });

  it("treats a generated column as read-only", async () => {
    catalog([
      ...defaultColumns(),
      catalogColumnRow("memo_upper", 3, 0, "TEXT", 3),
    ]);
    const meta = await getTableMeta(CATALOG_TABLE);
    expect(meta.columns.find((c) => c.name === "memo_upper")).toMatchObject({
      generated: true,
      writable: false,
    });
    await expect(
      applyMutations(
        CATALOG_TABLE,
        [{ op: "update", pk: { id: 1 }, set: { memo_upper: "X" } }],
        { dryRun: true },
      ),
    ).rejects.toThrow(/generated and cannot be written/);
  });
});
