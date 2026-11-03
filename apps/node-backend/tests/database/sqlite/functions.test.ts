/**
 * Boundary tests for the storage CHECK helpers (`vision_uuid_ok`,
 * `vision_array_ok`) and the `nextval()` sequence function.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { registerFunctions } from "../../../src/database/sqlite/functions.ts";
import { openDb, outcome, scalar } from "./harness.ts";

const db = openDb();

describe("vision_uuid_ok", () => {
  it("accepts only lower-case canonical 8-4-4-4-12 hex", () => {
    const ok = ["00000000-0000-0000-0000-000000000000", "123e4567-e89b-12d3-a456-426614174000", "ffffffff-ffff-ffff-ffff-ffffffffffff"];
    const bad = [
      "123E4567-E89B-12D3-A456-426614174000",
      "123e4567e89b12d3a456426614174000",
      "{123e4567-e89b-12d3-a456-426614174000}",
      "123e4567-e89b-12d3-a456-42661417400",
      "123e4567-e89b-12d3-a456-4266141740000",
      "123e4567-e89b-12d3-a456-42661417400g",
      " 123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-12d3-a456-426614174000\n",
      "",
    ];
    for (const u of ok) expect(scalar(db, "SELECT vision_uuid_ok(?)", u), u).toBe(1);
    for (const u of bad) expect(scalar(db, "SELECT vision_uuid_ok(?)", u), JSON.stringify(u)).toBe(0);
    expect(scalar(db, "SELECT vision_uuid_ok(42)")).toBe(0);
    expect(scalar(db, "SELECT vision_uuid_ok(NULL)")).toBeNull();
    expect(scalar(db, "SELECT typeof(vision_uuid_ok(gen_random_uuid()))")).toBe("integer");
    expect(scalar(db, "SELECT vision_uuid_ok(gen_random_uuid())")).toBe(1);
  });
});

describe("vision_array_ok", () => {
  it("accepts canonical JSON arrays of strings or of integers, with NULLs", () => {
    const ok = ["[]", '["a","b"]', "[1,2,3]", "[null]", '["a",null]', "[-1,null,0]", '[""]', '["é","😀"]', '["a\\"b"]', "[9007199254740991]"];
    for (const a of ok) expect(scalar(db, "SELECT vision_array_ok(?)", a), a).toBe(1);
  });

  it("refuses mixed, nested, non-canonical and non-array values", () => {
    const bad = [
      '["a",1]',
      "[1.5]",
      "[1.0]",
      "[1e2]",
      "[-0]",
      "[9007199254740993]",
      "[[1]]",
      '[{"a":1}]',
      "[true]",
      "[1, 2]",
      " [1]",
      '["\\u00e9"]',
      '{"a":1}',
      '"a"',
      "1",
      "null",
      "",
      "not json",
    ];
    for (const a of bad) expect(scalar(db, "SELECT vision_array_ok(?)", a), JSON.stringify(a)).toBe(0);
    expect(scalar(db, "SELECT vision_array_ok(NULL)")).toBeNull();
    expect(scalar(db, "SELECT vision_array_ok(1)")).toBe(0);
  });
});

describe("nextval", () => {
  function sequenceDb(): DatabaseSync {
    const conn = new DatabaseSync(":memory:");
    registerFunctions(conn, { transactionStart: null, statementStart: null });
    conn.exec(`
      CREATE TABLE vision_sequences (name TEXT PRIMARY KEY, last_value INTEGER NOT NULL);
      INSERT INTO vision_sequences VALUES ('s', 0), ('big', 9007199254740992);
      CREATE TABLE t (id BIGINT PRIMARY KEY NOT NULL DEFAULT (nextval('s')), label TEXT);
    `);
    return conn;
  }

  it("fills a BIGINT primary key default from vision_sequences", () => {
    const conn = sequenceDb();
    conn.prepare("INSERT INTO t (label) VALUES (?)").run("first");
    conn.prepare("INSERT INTO t (label) VALUES (?), (?)").run("second", "third");
    expect(conn.prepare("SELECT id, label FROM t ORDER BY id").all()).toEqual([
      { id: 1, label: "first" },
      { id: 2, label: "second" },
      { id: 3, label: "third" },
    ]);
    expect(scalar(conn, "SELECT last_value FROM vision_sequences WHERE name = 's'")).toBe(3);
    expect(scalar(conn, "SELECT typeof(nextval('s'))")).toBe("integer");
  });

  it("is rolled back with the transaction that advanced it", () => {
    const conn = sequenceDb();
    conn.exec("BEGIN");
    conn.prepare("INSERT INTO t (label) VALUES ('x')").run();
    conn.exec("ROLLBACK");
    conn.prepare("INSERT INTO t (label) VALUES ('y')").run();
    expect(scalar(conn, "SELECT id FROM t")).toBe(1);
  });

  it("keeps values beyond 2^53 exact", () => {
    const conn = sequenceDb();
    const row = conn.prepare("SELECT CAST(nextval('big') AS TEXT) AS v").get();
    expect(row?.v).toBe("9007199254740993");
  });

  it("raises 42P01 for a missing sequence and NULL for a NULL name", () => {
    const conn = sequenceDb();
    expect(outcome(() => scalar(conn, "SELECT nextval('missing')"))).toEqual({ error: "42P01" });
    expect(() => scalar(conn, "SELECT nextval('missing')")).toThrow('sequence "missing" does not exist');
    expect(scalar(conn, "SELECT nextval(NULL)")).toBeNull();
    expect(scalar(conn, "SELECT last_value FROM vision_sequences WHERE name = 's'")).toBe(0);
  });

  it("is not deterministic, so SQLite refuses it in an index expression", () => {
    const conn = sequenceDb();
    expect(() => conn.exec("CREATE INDEX t_next ON t ((id + nextval('s')))")).toThrow(/non-deterministic/);
  });
});
