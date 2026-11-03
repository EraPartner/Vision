import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { psqlRestoreGuardArgs } from "./psql-restore-guard";

const KEY = "gqnVQ6F4imcFbGKpuwXEGo0ADr2S2I8m";
const GUARD = ["--command", "\\restrict fixedkey"];

async function guardFor(t: test.TestContext, sql: string): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-psql-guard-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "db.sql");
  await fs.writeFile(file, sql, "latin1");
  return psqlRestoreGuardArgs(file, () => "fixedkey");
}

// The shape pg_dump 18 writes: comments, \restrict, SQL and COPY data, \unrestrict.
const pgDump = (body: string) =>
  `--\n-- PostgreSQL database dump\n--\n\n\\restrict ${KEY}\n\n${body}\n\\unrestrict ${KEY}\n\n`;

void test("a pg_dump file that restricts itself runs unchanged", async (t) => {
  const sql = pgDump(
    "SET standard_conforming_strings = on;\nCOPY public.t (id, memo) FROM stdin;\n1\t\\\\restrict abc\n2\t\\N\n\\.\n",
  );
  assert.deepEqual(await guardFor(t, sql), []);
});

void test("a dump without the restrict pair runs under a fresh restriction", async (t) => {
  assert.deepEqual(
    await guardFor(t, "SELECT 1;\n\\! open -a Calculator\n"),
    GUARD,
  );
  assert.deepEqual(await guardFor(t, "CREATE TABLE t (id int);\n"), GUARD);
});

void test("a second unrestrict anywhere means the file is not trusted to restrict itself", async (t) => {
  const early = pgDump(`SELECT 1;\n\\unrestrict ${KEY}\n\\! id\n`);
  const midLine = pgDump(`SELECT 1 \\UNRESTRICT ${KEY}\n;\n`);
  assert.deepEqual(await guardFor(t, early), GUARD);
  assert.deepEqual(await guardFor(t, midLine), GUARD);
});

void test("the restrict pair must enclose the whole file with one key", async (t) => {
  const sqlBefore = `SELECT 1;\n\\restrict ${KEY}\nSELECT 2;\n\\unrestrict ${KEY}\n`;
  const otherKey = `\\restrict ${KEY}\nSELECT 1;\n\\unrestrict other\n`;
  const trailing = `\\restrict ${KEY}\nSELECT 1;\n\\unrestrict ${KEY}\nSELECT 2;\n`;
  // psql ends lines at LF only, so a lone CR must not end the header line.
  const loneCr = `\\restrict ${KEY}\r\\! id\nSELECT 1;\n\\unrestrict ${KEY}\n`;
  for (const sql of [sqlBefore, otherKey, trailing, loneCr]) {
    assert.deepEqual(await guardFor(t, sql), GUARD);
  }
});

void test("the default restriction key is random and alphanumeric", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-psql-guard-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "db.sql");
  await fs.writeFile(file, "SELECT 1;\n");
  const [first, second] = [
    await psqlRestoreGuardArgs(file),
    await psqlRestoreGuardArgs(file),
  ];
  assert.match(first[1] ?? "", /^\\restrict [0-9a-f]{48}$/);
  assert.notEqual(first[1], second[1]);
});
