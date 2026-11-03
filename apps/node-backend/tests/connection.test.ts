/**
 * The SQLite driver (src/database/connection.ts, ADR-263) at its boundary:
 * transactions, savepoints and the ambient transaction context, the write
 * lock, the read connection, value mapping, and the PostgreSQL error codes
 * services rely on. Runs against this file's own database copy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkConnection,
  closePool,
  getPoolStats,
  getTableCount,
  MINIMUM_SQLITE_VERSION,
  query,
  sameTransaction,
  withExclusiveWriter,
  withReadSnapshot,
  withSavepointIfInTransaction,
  withTransaction,
} from "../src/database/connection.ts";
import type { DbClient } from "../src/database/connection.ts";
import { must } from "./helpers/must.ts";

interface DbError {
  code?: string;
  constraint?: string;
  message: string;
}

async function errorOf(fn: () => Promise<unknown>): Promise<DbError> {
  try {
    await fn();
  } catch (err) {
    return err as DbError;
  }
  throw new Error("expected a rejection");
}

beforeAll(async () => {
  await query(`CREATE TABLE conn_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    amount DECIMAL_TEXT(18,2) CONSTRAINT conn_items_amount__vtype CHECK (vision_numeric_ok(amount, 18, 2)),
    flag BOOLEAN CHECK (flag IN (0, 1)),
    day DATE_TEXT,
    at TIMESTAMPTZ_TEXT,
    meta JSONB_TEXT,
    big BIGINT,
    parent_id INTEGER REFERENCES conn_items(id),
    CONSTRAINT conn_items_name_not_blank CHECK (length(name) > 0)
  )`);
  await query("CREATE UNIQUE INDEX conn_items_name_key ON conn_items(name)");
});

afterAll(async () => {
  await query("DROP TABLE IF EXISTS conn_items");
  await closePool();
});

async function count(): Promise<number> {
  const { rows } = await query<{ n: number }>("SELECT count(*) AS n FROM conn_items");
  return rows[0]?.n ?? -1;
}

describe("statements", () => {
  it("binds $N placeholders by position and maps values by declared type", async () => {
    const at = new Date("2026-03-29T00:30:00.123Z");
    const { rows, rowCount } = await query<Record<string, unknown>>(
      `INSERT INTO conn_items (name, amount, flag, day, at, meta, big)
       VALUES ($1, vision_numeric($2, 18, 2), $3, $4, $5, vision_jsonb($6), $7)
       RETURNING name, amount, flag, day, at, meta, big`,
      ["map", "12.345", true, "2026-01-31", at, JSON.stringify({ b: 1, a: [1, "x"] }), 9007199254740993n],
    );
    expect(rowCount).toBe(1);
    expect(rows[0]).toEqual({
      name: "map",
      amount: "12.35",
      flag: true,
      day: new Date(2026, 0, 31),
      at,
      meta: { a: [1, "x"], b: 1 },
      big: "9007199254740993",
    });
  });

  it("reads expression columns through alias type hints", async () => {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT EXISTS (SELECT 1 FROM conn_items) AS "any::bool",
              max(at) AS "latest::timestamptz",
              json_group_array(name) AS "names::json",
              count(*) AS "n::bigint",
              count(*) AS plain_count
         FROM conn_items WHERE name = 'map'`,
    );
    expect(rows[0]).toEqual({
      any: true,
      latest: new Date("2026-03-29T00:30:00.123Z"),
      names: ["map"],
      n: "1",
      plain_count: 1,
    });
  });

  it("returns the number of rows a write touched", async () => {
    const result = await query("UPDATE conn_items SET flag = $1 WHERE name = $2", [false, "map"]);
    expect(result).toEqual({ rows: [], rowCount: 1 });
  });

  it("runs multi-statement text without parameters", async () => {
    await query("CREATE TABLE conn_tmp (x INTEGER); INSERT INTO conn_tmp VALUES (1); DROP TABLE conn_tmp;");
    await expect(query("SELECT 1; SELECT 2", [1])).rejects.toThrow(/multi-statement/);
  });
});

describe("PostgreSQL error codes", () => {
  it("23505 names the unique index", async () => {
    const err = await errorOf(() => query("INSERT INTO conn_items (name) VALUES ('map')"));
    expect(err.code).toBe("23505");
    expect(err.constraint).toBe("conn_items_name_key");
  });

  it("23505 on a primary key names <table>_pkey", async () => {
    const { rows } = await query<{ id: number }>("SELECT id FROM conn_items WHERE name = 'map'");
    const err = await errorOf(() =>
      query("INSERT INTO conn_items (id, name) VALUES ($1, 'other')", [rows[0]?.id]),
    );
    expect(err.code).toBe("23505");
    expect(err.constraint).toBe("conn_items_pkey");
  });

  it("23514 names the CHECK constraint, including the decimal storage check", async () => {
    const blank = await errorOf(() => query("INSERT INTO conn_items (name) VALUES ('')"));
    expect([blank.code, blank.constraint]).toEqual(["23514", "conn_items_name_not_blank"]);
    const scale = await errorOf(() => query("INSERT INTO conn_items (name, amount) VALUES ('s', '1.234')"));
    expect([scale.code, scale.constraint]).toEqual(["23514", "conn_items_amount__vtype"]);
  });

  it("23502 for NOT NULL, 23503 for a foreign key, 42P01 for a missing table", async () => {
    expect((await errorOf(() => query("INSERT INTO conn_items (name) VALUES (NULL)"))).code).toBe("23502");
    expect(
      (await errorOf(() => query("INSERT INTO conn_items (name, parent_id) VALUES ('fk', 999999)"))).code,
    ).toBe("23503");
    expect((await errorOf(() => query("SELECT * FROM no_such_table"))).code).toBe("42P01");
  });

  it("22003 when a value overflows NUMERIC(p, s)", async () => {
    const err = await errorOf(() =>
      query("INSERT INTO conn_items (name, amount) VALUES ('o', vision_numeric('12345678901234567', 18, 2))"),
    );
    expect(err.code).toBe("22003");
  });
});

describe("transactions", () => {
  it("commits on success and rolls back on throw", async () => {
    const before = await count();
    await withTransaction(async (client) => {
      await client.query("INSERT INTO conn_items (name) VALUES ('tx-commit')");
    });
    await expect(
      withTransaction(async () => {
        await query("INSERT INTO conn_items (name) VALUES ('tx-rollback')");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await count()).toBe(before + 1);
  });

  it("refuses transaction control outside withTransaction()", async () => {
    // A bare BEGIN would leave the shared writer in a transaction that later
    // writes join while reads still go to the reader.
    for (const text of ["BEGIN", "begin immediate", "COMMIT", "END", "ROLLBACK", "SAVEPOINT s", "RELEASE s"]) {
      await expect(query(text), text).rejects.toMatchObject({ code: "25000" });
    }
    const before = await count();
    await query("INSERT INTO conn_items (name) VALUES ('after-refused-begin')");
    await expect(withTransaction(() => Promise.reject(new Error("undo")))).rejects.toThrow("undo");
    expect(await count()).toBe(before + 1);
  });

  it("module-level query() joins the ambient transaction, so reads see its own writes", async () => {
    await withTransaction(async () => {
      await query("INSERT INTO conn_items (name) VALUES ('ambient')");
      const { rows } = await query<{ n: number }>("SELECT count(*) AS n FROM conn_items WHERE name = 'ambient'");
      expect(rows[0]?.n).toBe(1);
      throw new Error("undo");
    }).catch(() => undefined);
    const { rows } = await query<{ n: number }>("SELECT count(*) AS n FROM conn_items WHERE name = 'ambient'");
    expect(rows[0]?.n).toBe(0);
  });

  it("reads outside a transaction see only committed data", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => (inserted = r));
    const tx = withTransaction(async () => {
      await query("INSERT INTO conn_items (name) VALUES ('uncommitted')");
      inserted();
      await gate;
    });
    await didInsert;
    const outside = await query<{ n: number }>(
      "SELECT count(*) AS n FROM conn_items WHERE name = 'uncommitted'",
    );
    expect(outside.rows[0]?.n).toBe(0);
    release();
    await tx;
    const after = await query<{ n: number }>("SELECT count(*) AS n FROM conn_items WHERE name = 'uncommitted'");
    expect(after.rows[0]?.n).toBe(1);
  });

  it("now() is the transaction start time inside a transaction", async () => {
    const [first, second] = await withTransaction(async () => {
      const a = await query<{ t: string }>("SELECT now() AS t");
      await new Promise((r) => setTimeout(r, 5));
      const b = await query<{ t: string }>("SELECT now() AS t");
      return [a.rows[0]?.t, b.rows[0]?.t];
    });
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(second).toBe(first);
  });

  it("serializes writers: a second transaction waits for the first", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withTransaction(async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = withTransaction(() => {
      order.push("second:start");
      return Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("a nested call is a savepoint: a caught inner failure keeps the outer work", async () => {
    await withTransaction(async () => {
      await query("INSERT INTO conn_items (name) VALUES ('outer')");
      await expect(
        withTransaction(async () => {
          await query("INSERT INTO conn_items (name) VALUES ('inner')");
          throw new Error("inner failed");
        }),
      ).rejects.toThrow("inner failed");
      await withTransaction(async () => {
        await query("INSERT INTO conn_items (name) VALUES ('inner-ok')");
      });
    });
    const { rows } = await query<{ name: string }>(
      "SELECT name FROM conn_items WHERE name IN ('outer', 'inner', 'inner-ok') ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual(["inner-ok", "outer"]);
  });

  it("sameTransaction relates a savepoint's client to its parent and nothing else", async () => {
    let first: DbClient | undefined;
    await withTransaction(async (outer) => {
      first = outer;
      await withTransaction(async (inner) => {
        expect(inner).not.toBe(outer);
        expect(sameTransaction(inner, outer)).toBe(true);
        await withTransaction(async (deeper) => {
          expect(sameTransaction(deeper, outer)).toBe(true);
          await Promise.resolve();
        });
      });
      await withReadSnapshot(async (snapshot) => {
        expect(sameTransaction(snapshot, outer)).toBe(false);
        await Promise.resolve();
      });
    });
    await withTransaction(async (next) => {
      expect(sameTransaction(next, must(first, "first transaction client"))).toBe(false);
      await Promise.resolve();
    });
  });

  it("withSavepointIfInTransaction rolls back only its own statements and passes through outside", async () => {
    await withTransaction(async () => {
      await expect(
        withSavepointIfInTransaction("conn_sp", async () => {
          await query("INSERT INTO conn_items (name) VALUES ('sp-lost')");
          throw new Error("sp failed");
        }),
      ).rejects.toThrow("sp failed");
      await query("INSERT INTO conn_items (name) VALUES ('sp-kept')");
    });
    const { rows } = await query<{ name: string }>(
      "SELECT name FROM conn_items WHERE name LIKE 'sp-%' ORDER BY name",
    );
    expect(rows.map((r) => r.name)).toEqual(["sp-kept"]);
    await expect(withSavepointIfInTransaction("x", () => Promise.resolve(7))).resolves.toBe(7);
    await expect(
      withTransaction(() => withSavepointIfInTransaction("bad name;", () => Promise.resolve(1))),
    ).rejects.toThrow(/Unsafe savepoint name/);
  });

  it("rejects concurrent sibling nested transactions", async () => {
    await expect(
      withTransaction(async () => {
        await Promise.all([
          withTransaction(() => new Promise((r) => setTimeout(r, 5))),
          withTransaction(() => Promise.resolve(undefined)),
        ]);
      }),
    ).rejects.toThrow(/Concurrent sibling withTransaction/);
  });

  it("a continuation that outlives its transaction runs in autocommit, not in a finished transaction", async () => {
    let leaked: Promise<unknown> = Promise.resolve();
    await withTransaction(() => {
      leaked = new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
        query("INSERT INTO conn_items (name) VALUES ('leaked')"),
      );
      return Promise.resolve();
    });
    await leaked;
    const { rows } = await query<{ n: number }>("SELECT count(*) AS n FROM conn_items WHERE name = 'leaked'");
    expect(rows[0]?.n).toBe(1);
  });
});

describe("snapshots and maintenance", () => {
  it("withReadSnapshot sees one consistent state while writes commit", async () => {
    let firstRead!: () => void;
    const didFirstRead = new Promise<void>((r) => (firstRead = r));
    let wrote!: () => void;
    const didWrite = new Promise<void>((r) => (wrote = r));
    const snapshot = withReadSnapshot(async (client) => {
      const a = await client.query("SELECT count(*) AS n FROM conn_items");
      firstRead();
      await didWrite;
      const b = await client.query("SELECT count(*) AS n FROM conn_items");
      return [a.rows[0], b.rows[0]];
    });
    await didFirstRead;
    // Outside the snapshot's context: another writer commits meanwhile.
    await query("INSERT INTO conn_items (name) VALUES ('during-snapshot')");
    wrote();
    const seen = await snapshot;
    expect(seen[0]).toEqual(seen[1]);
    const now = await query<{ n: number }>("SELECT count(*) AS n FROM conn_items");
    expect(now.rows[0]).not.toEqual(seen[0]);
  });

  it("withExclusiveWriter waits for running transactions", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tx = withTransaction(async () => {
      order.push("tx");
      await gate;
    });
    const exclusive = withExclusiveWriter(() => {
      order.push("exclusive");
    });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([tx, exclusive]);
    expect(order).toEqual(["tx", "exclusive"]);
  });

  it("reports health and reopens after closePool()", async () => {
    expect(await checkConnection()).toBe(true);
    expect(await getTableCount()).toBeGreaterThan(0);
    expect(getPoolStats().maxConnections).toBe(2);
    await closePool();
    expect(await count()).toBeGreaterThan(0);
    expect(MINIMUM_SQLITE_VERSION).toBe("3.39.0");
  });
});
