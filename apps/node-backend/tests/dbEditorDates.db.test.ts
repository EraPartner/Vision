/**
 * Admin DB editor against the real SQLite database, with the backend running
 * east of UTC (Europe/Brussels).
 *
 * Regression: GET /api/admin/database/tables/:table/rows sent DATE cells as
 * the driver's local-midnight `Date`, i.e. the previous day's UTC timestamp
 * (2024-05-28T22:00:00.000Z for 2024-05-29). The editor shows that text and
 * sends it back on save, so saving an untouched date moved it one day earlier.
 *
 * The second suite pins the SQLite storage contract at the editor boundary:
 * decimals order and compare by value and are written canonically, dates and
 * timestamps keep their calendar day and offset across month ends and DST
 * changes, the row-version token catches a concurrent edit, AFTER triggers are
 * reflected in the returned row, and generated columns are read-only.
 *
 * The third suite covers the admin maintenance endpoints the editor page sits
 * on: table statistics from SQLite's catalog and dbstat, and VACUUM / ANALYZE.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPool, getTestPool } from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import adminRouter from "../src/routes/admin.ts";
import {
  __clearDbEditorMetadataCacheForTests,
  applyMutations,
  getTableMeta,
  readRows,
} from "../src/services/dbEditor.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import { must } from "./helpers/must.ts";

/** A result row whose columns the test reads without a fixed shape. */
type DbRow = Record<string, unknown>;

const SOURCE = `dbeditor_dates_${process.pid}`;
const TABLE = "belgian_inflation_rates";
const previousTz = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "Europe/Brussels";
});

afterAll(async () => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
  await closeTestPool();
  await closePool();
});

describe("DB editor DATE cells are calendar days (real DB, Europe/Brussels)", () => {
  const api = routeAgent(adminRouter, { mountPath: "/api/admin" });

  async function readMarkedRow() {
    const filters = JSON.stringify([
      { column: "source", op: "eq", value: SOURCE },
    ]);
    const res = await api
      .get(`/api/admin/database/tables/${TABLE}/rows`)
      .query({ filters });
    expect(res.status).toBe(200);
    return bodyAt(res, "data", "rows", 0) as Record<string, unknown>;
  }

  beforeAll(async () => {
    await getTestPool().query(
      `INSERT INTO ${TABLE} (month_date, monthly_rate, source)
       VALUES ('2024-05-29', vision_numeric('0.5', 10, 8), $1)`,
      [SOURCE],
    );
  });

  afterAll(async () => {
    await getTestPool().query(`DELETE FROM ${TABLE} WHERE source = $1`, [SOURCE]);
  });

  it("reads a DATE cell as YYYY-MM-DD", async () => {
    const row = await readMarkedRow();
    expect(row.month_date).toBe("2024-05-29");
    expect(row.monthly_rate).toBe("0.50000000");
  });

  it("keeps the same day when the unchanged date text is saved back", async () => {
    const row = await readMarkedRow();

    const res = await api
      .post(`/api/admin/database/tables/${TABLE}/mutate`)
      .send({
        changes: [
          {
            op: "update",
            pk: { id: row.id },
            xmin: row.__xmin,
            set: { month_date: row.month_date, monthly_rate: "0.6" },
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "results", 0, "after", "month_date")).toBe(
      "2024-05-29",
    );
    expect(bodyAt(res, "data", "results", 0, "after", "monthly_rate")).toBe(
      "0.60000000",
    );
    const { rows } = await getTestPool().query<DbRow>(
      `SELECT month_date AS "month_date::text", monthly_rate FROM ${TABLE} WHERE source = $1`,
      [SOURCE],
    );
    expect(must(rows[0], "rows[0]").month_date).toBe("2024-05-29");
    // Stored as canonical DECIMAL_TEXT(10,8), so its CHECK holds.
    expect(must(rows[0], "rows[0]").monthly_rate).toBe("0.60000000");
  });
});

describe("DB editor on SQLite storage (real DB)", () => {
  const SRC = `dbeditor_storage_${process.pid}`;
  const GENERATED = `dbeditor_generated_${process.pid}`;
  const NO_KEY = `dbeditor_nokey_${process.pid}`;
  const SETTING = `dbeditor_setting_${process.pid}`;
  const sourceFilter = [{ column: "source", op: "eq", value: SRC }];

  async function insertRate(day: string, rate: string, fetchedAt = "2024-01-01T00:00:00.000000Z") {
    const { rows } = await getTestPool().query<{ id: number }>(
      `INSERT INTO ${TABLE} (month_date, monthly_rate, source, fetched_at, updated_at)
       VALUES ($1, vision_numeric($2, 10, 8), $3, $4, '2020-01-01T00:00:00.000000Z')
       RETURNING id`,
      [day, rate, SRC, fetchedAt],
    );
    return must(rows[0], "inserted").id;
  }

  async function storedRate(id: number) {
    const { rows } = await getTestPool().query<DbRow>(
      `SELECT monthly_rate, updated_at AS "updated_at::text" FROM ${TABLE} WHERE id = $1`,
      [id],
    );
    return must(rows[0], "stored row");
  }

  async function rowById(id: number) {
    const page = await readRows(TABLE, {
      filters: [{ column: "id", op: "eq", value: String(id) }],
    });
    return must(page.rows[0], `row ${id}`);
  }

  beforeAll(async () => {
    const pool = getTestPool();
    await pool.query(
      `CREATE TABLE ${GENERATED} (
         id INTEGER PRIMARY KEY,
         label TEXT NOT NULL,
         flag BOOLEAN NOT NULL DEFAULT 0 CHECK (flag IN (0, 1)),
         label_twice TEXT GENERATED ALWAYS AS (label || label) VIRTUAL
       )`,
    );
    await pool.query(`CREATE TABLE ${NO_KEY} (label TEXT)`);
    await pool.query(
      `INSERT INTO ${NO_KEY} (label) VALUES ('b'), ('a'), ('b'), (NULL), ('a')`,
    );
  });

  beforeEach(async () => {
    __clearDbEditorMetadataCacheForTests();
    await getTestPool().query(`DELETE FROM ${TABLE} WHERE source = $1`, [SRC]);
  });

  afterAll(async () => {
    const pool = getTestPool();
    await pool.query(`DELETE FROM ${TABLE} WHERE source = $1`, [SRC]);
    await pool.query(`DELETE FROM user_settings WHERE "key" = $1`, [SETTING]);
    await pool.query(`DROP TABLE IF EXISTS ${GENERATED}`);
    await pool.query(`DROP TABLE IF EXISTS ${NO_KEY}`);
  });

  it("describes DECIMAL_TEXT, DATE_TEXT and TIMESTAMPTZ_TEXT columns by their PostgreSQL types", async () => {
    const meta = await getTableMeta(TABLE);
    const byName = new Map(meta.columns.map((c) => [c.name, c]));
    expect(meta.primaryKey).toEqual(["id"]);
    expect(byName.get("id")).toMatchObject({ dataType: "integer", hasDefault: true, nullable: false });
    expect(byName.get("monthly_rate")).toMatchObject({ dataType: "numeric", udtName: "numeric", nullable: false });
    expect(byName.get("month_date")).toMatchObject({ dataType: "date", udtName: "date" });
    expect(byName.get("fetched_at")).toMatchObject({ udtName: "timestamptz", hasDefault: true });
  });

  it("orders and pages decimals by value, where their text order differs", async () => {
    // Text order would be -0.5, -1, 10, 9; numeric order is -1, -0.5, 9, 10.
    for (const [day, rate] of [
      ["2024-01-31", "9"],
      ["2024-02-29", "-0.5"],
      ["2024-03-31", "10"],
      ["2024-04-30", "-1"],
      ["2024-05-31", "-0.50000000"],
    ] as const) {
      await insertRate(day, rate);
    }
    const seen: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await readRows(TABLE, {
        limit: 2,
        orderBy: "monthly_rate",
        filters: sourceFilter,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.rows.map((r) => [r.monthly_rate, r.month_date]));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual([
      ["-1.00000000", "2024-04-30"],
      // Equal values tie-break on the primary key, across the page boundary.
      ["-0.50000000", "2024-02-29"],
      ["-0.50000000", "2024-05-31"],
      ["9.00000000", "2024-01-31"],
      ["10.00000000", "2024-03-31"],
    ]);

    const desc = await readRows(TABLE, { orderBy: "monthly_rate", dir: "desc", filters: sourceFilter });
    expect(desc.rows.map((r) => r.monthly_rate)).toEqual([
      "10.00000000",
      "9.00000000",
      "-0.50000000",
      "-0.50000000",
      "-1.00000000",
    ]);
  });

  it("filters decimals by exact value", async () => {
    await insertRate("2024-01-31", "0.1");
    await insertRate("2024-02-29", "0.30000000");
    await insertRate("2024-03-31", "0.00000001");
    const eq = await readRows(TABLE, {
      filters: [...sourceFilter, { column: "monthly_rate", op: "eq", value: 0.3 }],
    });
    // 0.3 equals 0.30000000 as a decimal, not as text.
    expect(eq.rows.map((r) => r.month_date)).toEqual(["2024-02-29"]);
    const gt = await readRows(TABLE, {
      orderBy: "monthly_rate",
      filters: [...sourceFilter, { column: "monthly_rate", op: "gt", value: "0.00000001" }],
    });
    expect(gt.rows.map((r) => r.monthly_rate)).toEqual(["0.10000000", "0.30000000"]);
    const contains = await readRows(TABLE, {
      filters: [...sourceFilter, { column: "monthly_rate", op: "startsWith", value: "0.0000" }],
    });
    expect(contains.rows.map((r) => r.monthly_rate)).toEqual(["0.00000001"]);
  });

  it("filters month-end dates by calendar day, ignoring a time that would cross midnight", async () => {
    await insertRate("2024-02-29", "1");
    await insertRate("2024-03-31", "2");
    await insertRate("2024-04-01", "3");
    // 23:30Z on 31 March is already 1 April in Brussels (after the DST change);
    // PostgreSQL's date input took the written day, and so does the editor.
    const eq = await readRows(TABLE, {
      filters: [...sourceFilter, { column: "month_date", op: "eq", value: "2024-03-31T23:30:00Z" }],
    });
    expect(eq.rows.map((r) => r.month_date)).toEqual(["2024-03-31"]);
    const range = await readRows(TABLE, {
      orderBy: "month_date",
      filters: [
        ...sourceFilter,
        { column: "month_date", op: "gte", value: "2024-02-29" },
        { column: "month_date", op: "lt", value: "2024-04-01" },
      ],
    });
    expect(range.rows.map((r) => r.month_date)).toEqual(["2024-02-29", "2024-03-31"]);
    await expect(
      readRows(TABLE, { filters: [{ column: "month_date", op: "eq", value: "2024-02-30" }] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("compares timestamps by instant across the autumn DST change", async () => {
    // 02:30 local time happens twice on 27 October 2024 in Brussels.
    await insertRate("2024-10-31", "1", "2024-10-27T00:30:00.000000Z");
    await insertRate("2024-11-30", "2", "2024-10-27T01:30:00.000000Z");
    const later = await readRows(TABLE, {
      filters: [...sourceFilter, { column: "fetched_at", op: "gte", value: "2024-10-27 02:30:00+01" }],
    });
    expect(later.rows.map((r) => r.month_date)).toEqual(["2024-11-30"]);
    const first = await readRows(TABLE, {
      filters: [...sourceFilter, { column: "fetched_at", op: "eq", value: "2024-10-27T02:30:00+02:00" }],
    });
    expect(first.rows.map((r) => r.month_date)).toEqual(["2024-10-31"]);
  });

  it("writes decimals canonically, rounding half away from zero and refusing overflow", async () => {
    const id = await insertRate("2024-01-31", "1");
    const cases: Array<[unknown, string]> = [
      [0.1, "0.10000000"],
      ["1e-8", "0.00000001"],
      ["0.123456785", "0.12345679"],
      ["-0.123456785", "-0.12345679"],
      [" 12.5 ", "12.50000000"],
    ];
    for (const [value, stored] of cases) {
      const row = await rowById(id);
      await applyMutations(TABLE, [
        { op: "update", pk: { id }, xmin: row.__xmin, set: { monthly_rate: value } },
      ]);
      expect((await storedRate(id)).monthly_rate).toBe(stored);
    }
    await expect(
      applyMutations(TABLE, [{ op: "update", pk: { id }, set: { monthly_rate: "100" } }]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      applyMutations(TABLE, [{ op: "update", pk: { id }, set: { monthly_rate: "abc" } }]),
    ).rejects.toMatchObject({ status: 400 });
    expect((await storedRate(id)).monthly_rate).toBe("12.50000000");
  });

  it("refuses an edit made against a stale row version", async () => {
    const id = await insertRate("2024-01-31", "1");
    const loaded = await rowById(id);
    expect(loaded.__xmin).toMatch(/^[0-9a-f]{32}$/);

    // Someone else edits the row after it was loaded.
    await getTestPool().query(
      `UPDATE ${TABLE} SET monthly_rate = vision_numeric('2', 10, 8) WHERE id = $1`,
      [id],
    );
    await expect(
      applyMutations(TABLE, [
        { op: "update", pk: { id }, xmin: loaded.__xmin, set: { monthly_rate: "3" } },
      ]),
    ).rejects.toMatchObject({ status: 409 });
    expect((await storedRate(id)).monthly_rate).toBe("2.00000000");

    const fresh = await rowById(id);
    expect(fresh.__xmin).not.toBe(loaded.__xmin);
    await applyMutations(TABLE, [
      { op: "update", pk: { id }, xmin: fresh.__xmin, set: { monthly_rate: "3" } },
    ]);
    expect((await storedRate(id)).monthly_rate).toBe("3.00000000");

    await expect(
      applyMutations(TABLE, [{ op: "delete", pk: { id }, xmin: fresh.__xmin }]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns the row as its AFTER UPDATE trigger left it", async () => {
    const id = await insertRate("2024-01-31", "1");
    const row = await rowById(id);
    const result = await applyMutations(TABLE, [
      { op: "update", pk: { id }, xmin: row.__xmin, set: { monthly_rate: "1.5" } },
    ]);
    const after = must(must(result.results, "results")[0]?.after, "after");
    const stored = await storedRate(id);
    expect(stored["updated_at"]).not.toBe("2020-01-01T00:00:00.000000Z");
    expect((after.updated_at as Date).getTime()).toBe(
      new Date(String(stored["updated_at"]).replace(/(\.\d{3})\d{3}Z$/, "$1Z")).getTime(),
    );
  });

  it("inserts and deletes through the catalog key", async () => {
    const result = await applyMutations(TABLE, [
      {
        op: "insert",
        values: { month_date: "2024-12-31", monthly_rate: "-0.25", source: SRC },
      },
    ]);
    const inserted = must(must(result.results, "results")[0]?.after, "inserted");
    expect(inserted).toMatchObject({ month_date: "2024-12-31", monthly_rate: "-0.25000000" });
    const id = Number(inserted.id);
    const row = await rowById(id);
    await applyMutations(TABLE, [{ op: "delete", pk: { id }, xmin: row.__xmin }]);
    const { rows } = await getTestPool().query(`SELECT id FROM ${TABLE} WHERE id = $1`, [id]);
    expect(rows).toEqual([]);
  });

  it("stores jsonb canonically and matches it regardless of key order", async () => {
    await applyMutations("user_settings", [
      { op: "insert", values: { key: SETTING, value: { zeta: 1, b: [1.5, "x"], aa: null } } },
    ]);
    const { rows } = await getTestPool().query<DbRow>(
      `SELECT value AS "value::text" FROM user_settings WHERE "key" = $1`,
      [SETTING],
    );
    expect(must(rows[0], "setting").value).toBe('{"b": [1.5, "x"], "aa": null, "zeta": 1}');
    const found = await readRows("user_settings", {
      filters: [{ column: "value", op: "eq", value: { aa: null, b: [1.5, "x"], zeta: 1 } }],
    });
    expect(found.rows.map((r) => r.key)).toEqual([SETTING]);
    await expect(
      applyMutations("user_settings", [
        { op: "update", pk: { key: SETTING }, set: { value: "{not json" } },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      applyMutations("user_settings", [
        { op: "insert", values: { key: "includeTransfers", value: 1 } },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("reads generated columns but never writes them, and coerces booleans", async () => {
    const meta = await getTableMeta(GENERATED);
    expect(meta.columns.map((c) => [c.name, c.udtName, c.generated, c.writable])).toEqual([
      ["id", "int4", false, true],
      ["label", "text", false, true],
      ["flag", "bool", false, true],
      ["label_twice", "text", true, false],
    ]);
    const result = await applyMutations(GENERATED, [
      { op: "insert", values: { label: "ab", flag: "yes" } },
    ]);
    const inserted = must(must(result.results, "results")[0]?.after, "inserted");
    expect(inserted).toMatchObject({ label: "ab", flag: true, label_twice: "abab" });
    await expect(
      applyMutations(GENERATED, [
        { op: "update", pk: { id: inserted.id }, set: { label_twice: "x" } },
      ]),
    ).rejects.toThrow(/generated and cannot be written/);
    await expect(
      applyMutations(GENERATED, [{ op: "insert", values: { label: "c", flag: 2 } }]),
    ).rejects.toMatchObject({ status: 400 });
    const off = await readRows(GENERATED, {
      filters: [{ column: "flag", op: "eq", value: "off" }],
    });
    expect(off.rows).toEqual([]);
    const on = await readRows(GENERATED, {
      filters: [{ column: "flag", op: "contains", value: "TRU" }],
    });
    expect(on.rows.map((r) => r.label)).toEqual(["ab"]);
  });

  it("pages a table without a primary key through its rowid", async () => {
    const seen: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await readRows(NO_KEY, {
        limit: 2,
        orderBy: "label",
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.rows.map((r) => r.label));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual(["a", "a", "b", "b", null]);
    await expect(
      applyMutations(NO_KEY, [{ op: "insert", values: { label: "x" } }]),
    ).rejects.toThrow(/no primary key/);
  });
});

describe("Admin database maintenance on SQLite (real DB)", () => {
  const api = routeAgent(adminRouter, { mountPath: "/api/admin" });
  const MAINTENANCE = `dbeditor_maintenance_${process.pid}`;

  beforeAll(async () => {
    // ANALYZE records nothing for an empty table.
    await getTestPool().query(
      `INSERT INTO ${TABLE} (month_date, monthly_rate, source)
       VALUES ('2023-12-31', vision_numeric('0.25', 10, 8), $1)`,
      [MAINTENANCE],
    );
  });

  afterAll(async () => {
    await getTestPool().query(`DELETE FROM ${TABLE} WHERE source = $1`, [MAINTENANCE]);
  });
  type StatRow = {
    table_name: string;
    live_rows: string;
    last_vacuum: string | null;
    last_analyze: string | null;
    size: string;
    size_bytes: string;
  };

  async function stats() {
    const res = await api.get("/api/admin/database/stats");
    expect(res.status).toBe(200);
    return {
      tables: bodyAt(res, "data", "tables") as StatRow[],
      dbSize: bodyAt(res, "data", "db_size") as string | null,
    };
  }

  it("reports exact row counts, page sizes and the file size", async () => {
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*) AS n FROM ${TABLE}`,
    );
    const { tables, dbSize } = await stats();
    const names = tables.map((t) => t.table_name);
    expect(names).toContain(TABLE);
    // SQLite's own tables and the sequence state stay out.
    expect(names.some((n) => n.startsWith("sqlite_"))).toBe(false);
    expect(names).not.toContain("vision_sequences");

    const inflation = must(tables.find((t) => t.table_name === TABLE), "stats row");
    expect(inflation).toMatchObject({ live_rows: String(must(rows[0], "count").n) });
    expect(Object.keys(inflation).sort()).toEqual(
      ["last_analyze", "last_vacuum", "live_rows", "size", "size_bytes", "table_name"],
    );
    for (const t of tables) {
      expect(t.live_rows).toMatch(/^\d+$/);
      expect(t.size_bytes).toMatch(/^\d+$/);
      // Every table has at least its root page.
      expect(Number(t.size_bytes)).toBeGreaterThan(0);
      expect(t.size).toMatch(/^\d+ (bytes|kB|MB|GB)$/);
    }
    // Largest first.
    const sizes = tables.map((t) => Number(t.size_bytes));
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(dbSize).toMatch(/^\d+ (bytes|kB|MB|GB)$/);
  });

  it("vacuums the file and analyzes the requested table", async () => {
    const before = await stats();
    expect(before.tables.find((t) => t.table_name === TABLE)?.last_analyze).toBeNull();

    const res = await api
      .post("/api/admin/database/vacuum")
      .send({ table: TABLE });
    expect(res.status).toBe(200);
    expect(bodyAt(res, "data")).toEqual({ vacuumed: TABLE });

    const { rows } = await getTestPool().query<{ tbl: string }>(
      "SELECT DISTINCT tbl FROM sqlite_stat1 WHERE tbl = $1",
      [TABLE],
    );
    expect(rows).toEqual([{ tbl: TABLE }]);

    const after = await stats();
    const inflation = must(after.tables.find((t) => t.table_name === TABLE), "stats row");
    expect(inflation.last_vacuum).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(inflation.last_analyze).toBe(inflation.last_vacuum);
    // VACUUM rebuilt the whole file, so every table reports it; ANALYZE ran
    // for the requested table only.
    const other = must(after.tables.find((t) => t.table_name === "categories"), "categories");
    expect(other.last_vacuum).toBe(inflation.last_vacuum);
    expect(other.last_analyze).toBeNull();

    // The data is intact after the rebuild.
    const editor = await readRows(TABLE, {
      filters: [{ column: "source", op: "eq", value: MAINTENANCE }],
    });
    expect(editor.rows.map((r) => [r.month_date, r.monthly_rate])).toEqual([
      ["2023-12-31", "0.25000000"],
    ]);
  });
});
