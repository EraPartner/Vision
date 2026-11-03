import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import {
  STABLE_TABLES,
  assertTableCountsEqual,
  describeDatabaseFileStats,
  isSqliteDatabaseFile,
  parseSqliteHeader,
  readDatabaseFileStats,
  sqliteVersionString,
} from "./database-stats";

type SqliteModule = typeof import("node:sqlite");

// node:sqlite exists from Node 22.13; older runners skip the real-file test.
const sqlite = ((): SqliteModule | undefined => {
  try {
    const loaded: unknown = createRequire(__filename)("node:sqlite");
    return loaded as SqliteModule;
  } catch {
    return undefined;
  }
})();

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-db-stats-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface HeaderFields {
  pageSize?: number;
  wal?: boolean;
  pages?: number;
  validFor?: number;
  freelist?: number;
  encoding?: number;
  userVersion?: number;
  sqliteVersion?: number;
}

function header({
  pageSize = 4096,
  wal = true,
  pages = 3,
  validFor = 7,
  freelist = 1,
  encoding = 1,
  userVersion = 12,
  sqliteVersion = 3_046_001,
}: HeaderFields = {}): Buffer {
  const buffer = Buffer.alloc(100);
  buffer.write("SQLite format 3\0", 0, "latin1");
  buffer.writeUInt16BE(pageSize === 65_536 ? 1 : pageSize, 16);
  buffer.writeUInt8(wal ? 2 : 1, 18);
  buffer.writeUInt8(wal ? 2 : 1, 19);
  buffer.writeUInt32BE(7, 24);
  buffer.writeUInt32BE(pages, 28);
  buffer.writeUInt32BE(freelist, 36);
  buffer.writeUInt32BE(4, 44);
  buffer.writeUInt32BE(encoding, 56);
  buffer.writeInt32BE(userVersion, 60);
  buffer.writeUInt32BE(validFor, 92);
  buffer.writeUInt32BE(sqliteVersion, 96);
  return buffer;
}

void test("the SQLite header yields page geometry, schema version and writer version", () => {
  assert.deepEqual(parseSqliteHeader(header()), {
    pageSize: 4096,
    journalMode: "wal",
    pageCount: 3,
    freelistPages: 1,
    schemaFormat: 4,
    textEncoding: "UTF-8",
    userVersion: 12,
    applicationId: 0,
    sqliteVersionNumber: 3_046_001,
  });
  assert.equal(parseSqliteHeader(header({ pageSize: 65_536 })).pageSize, 65_536);
  assert.equal(parseSqliteHeader(header({ wal: false })).journalMode, "rollback");
});

void test("a stale in-header page count is not trusted", () => {
  assert.equal(parseSqliteHeader(header({ validFor: 6 })).pageCount, undefined);
});

void test("files that are not SQLite databases are refused", () => {
  assert.throws(
    () => parseSqliteHeader(Buffer.from("CREATE TABLE notes (id int);\n")),
    hasCode("NOT_SQLITE_DATABASE"),
  );
  assert.throws(
    () => parseSqliteHeader(header({ pageSize: 1000 })),
    hasCode("NOT_SQLITE_DATABASE"),
  );
});

void test("SQLite version numbers render as dotted versions", () => {
  assert.equal(sqliteVersionString(3_046_001), "3.46.1");
  assert.equal(sqliteVersionString(0), undefined);
});

void test("file statistics combine the header with the database and WAL sizes", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "vision.sqlite3");
  fs.writeFileSync(file, Buffer.concat([header(), Buffer.alloc(3 * 4096 - 100)]));
  fs.writeFileSync(`${file}-wal`, Buffer.alloc(8192));
  const stats = await readDatabaseFileStats(file);
  assert.deepEqual(stats, {
    file,
    exists: true,
    bytes: 3 * 4096,
    walBytes: 8192,
    shmBytes: 0,
    pageSize: 4096,
    pageCount: 3,
    freelistPages: 1,
    freeBytes: 4096,
    journalMode: "wal",
    textEncoding: "UTF-8",
    schemaVersion: 12,
    sqliteVersion: "3.46.1",
  });
  assert.equal(
    describeDatabaseFileStats(stats),
    "bytes=12288 wal=8192 pages=3x4096 free=1 schema=12 journal=wal sqlite=3.46.1",
  );
  assert.equal(describeDatabaseFileStats(stats).includes(dir), false);
});

void test("a missing database reports absence instead of failing", async (t) => {
  const file = path.join(tempDir(t), "vision.sqlite3");
  const stats = await readDatabaseFileStats(file);
  assert.equal(stats.exists, false);
  assert.equal(stats.schemaVersion, undefined);
  assert.equal(describeDatabaseFileStats(stats), "database file absent");
  assert.equal(await isSqliteDatabaseFile(file), false);
});

void test("statistics refuse a database path that is a symbolic link or a directory", async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, "target.sqlite3");
  fs.writeFileSync(target, header());
  const link = path.join(dir, "vision.sqlite3");
  fs.symlinkSync(target, link);
  await assert.rejects(readDatabaseFileStats(link), hasCode("DATABASE_PATH_UNSAFE"));
  await assert.rejects(readDatabaseFileStats(dir), hasCode("DATABASE_PATH_UNSAFE"));
  assert.equal(await isSqliteDatabaseFile(link), false);
  assert.equal(await isSqliteDatabaseFile(target), true);
});

void test(
  "statistics of a real WAL database report its schema version",
  { skip: sqlite ? false : "node:sqlite is unavailable on this Node" },
  async (t) => {
    assert.ok(sqlite);
    const file = path.join(tempDir(t), "vision.sqlite3");
    const db = new sqlite.DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    db.exec("INSERT INTO notes (body) VALUES ('one'), ('two')");
    db.exec("PRAGMA user_version = 42");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const pageSize = Number(
      (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size,
    );
    db.close();
    const stats = await readDatabaseFileStats(file);
    assert.equal(stats.exists, true);
    assert.equal(stats.schemaVersion, 42);
    assert.equal(stats.journalMode, "wal");
    assert.equal(stats.pageSize, pageSize);
    assert.equal(stats.bytes, (stats.pageCount ?? 0) * pageSize);
    assert.match(stats.sqliteVersion ?? "", /^3\.\d+\.\d+$/);
  },
);

void test("row-count comparison names every drifting table", () => {
  assert.doesNotThrow(() =>
    assertTableCountsEqual({ accounts: 2, transactions: 7 }, { transactions: 7, accounts: 2 }),
  );
  assert.throws(
    () =>
      assertTableCountsEqual(
        { accounts: 2, transactions: 7 },
        { accounts: 2, transactions: 8, provider_health: 1 },
      ),
    (error) =>
      hasCode("DATABASE_COUNT_MISMATCH")(error) &&
      error instanceof Error &&
      /provider_health: expected none, found 1/.test(error.message) &&
      /transactions: expected 7, found 8/.test(error.message) &&
      !/accounts/.test(error.message),
  );
});

void test("a post-start comparison of stable tables permits startup bookkeeping", () => {
  assert.equal(STABLE_TABLES.includes("user_settings"), false);
  assert.ok(STABLE_TABLES.includes("transactions"));
  assert.doesNotThrow(() =>
    assertTableCountsEqual(
      { transactions: 7, user_settings: 2 },
      { transactions: 7, user_settings: 5, provider_health: 3 },
      { tables: STABLE_TABLES },
    ),
  );
  assert.throws(
    () =>
      assertTableCountsEqual(
        { transactions: 7 },
        { transactions: 6 },
        { tables: STABLE_TABLES },
      ),
    hasCode("DATABASE_COUNT_MISMATCH"),
  );
});
