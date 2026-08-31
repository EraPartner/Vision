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

vi.mock("../../src/database/connection.js", () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));
vi.mock("../../src/services/aggregationRefresh.js", () => ({
  scheduleAggregationRefresh: vi.fn(),
}));

import { query, getClient } from "../../src/database/connection.js";
import {
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
  it("coerces limit and offset to clamped integers", async () => {
    await readRows(CATALOG_TABLE, {
      limit: "10; DROP TABLE users",
      offset: "-5",
    });
    const dataSql = clientSql.find((s) => s.startsWith("SELECT *"));
    expect(dataSql).toMatch(/LIMIT \d+ OFFSET \d+$/);
    expect(dataSql).toContain("OFFSET 0");
    expect(dataSql).not.toContain("DROP TABLE");
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
