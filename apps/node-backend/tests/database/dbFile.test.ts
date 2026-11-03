/**
 * The database-file commands the desktop runtime runs with the bundled Bun
 * (scripts/db-file.ts, ADR-263): `create` builds the Demo database, `snapshot`
 * writes backups, `verify` gates every restore. Each refusal leaves nothing
 * behind.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createDatabase, snapshotDatabase, verifyDatabaseFile } from "../../scripts/db-file.ts";
import { LEDGER_TABLE, loadMigrations } from "../../src/database/migrate.ts";

const root = mkdtempSync(path.join(process.env.VISION_TEST_DB_DIR ?? os.tmpdir(), "db-file-"));
let counter = 0;
const fresh = (name = "db") => {
  counter += 1;
  return path.join(root, `${name}-${counter}.sqlite3`);
};
const seedFile = (sql: string) => {
  const file = fresh("seed").replace(/\.sqlite3$/u, ".sql");
  writeFileSync(file, sql);
  return file;
};
const latest = loadMigrations().at(-1)?.version ?? 0;

function edit(file: string, sql: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

describe("create", () => {
  it("builds a verified database at the latest migration", async () => {
    const file = fresh();
    const result = await createDatabase(file);
    expect(result).toMatchObject({ ok: true, schemaVersion: latest, pendingMigrations: 0 });
    expect(result.tableCounts[LEDGER_TABLE]).toBe(latest);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("runs a seed in one transaction and counts its rows", async () => {
    const plain = await createDatabase(fresh());
    const seeded = await createDatabase(
      fresh(),
      seedFile("INSERT INTO vision_sequences (name, last_value) VALUES ('db_file_test_seq', 41);"),
    );
    expect(seeded.tableCounts.vision_sequences).toBe((plain.tableCounts.vision_sequences ?? 0) + 1);
  });

  it.each([
    ["changes the migration ledger", `DELETE FROM ${LEDGER_TABLE};`, /changed the migration ledger/u],
    ["changes the schema", "CREATE TABLE db_file_extra (id INTEGER);", /schema differs from a fresh Vision install/u],
    ["fails", "INSERT INTO no_such_table VALUES (1);", /no such table/u],
    ["opens its own transaction", "BEGIN; COMMIT;", /transaction/u],
  ])("refuses a seed that %s and removes the partial file", async (_label, sql, message) => {
    const file = fresh();
    await expect(createDatabase(file, seedFile(sql))).rejects.toThrow(message);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) expect(existsSync(`${file}${suffix}`)).toBe(false);
  });

  it("refuses an existing destination and leaves it alone", async () => {
    const file = fresh();
    writeFileSync(file, "not a database");
    await expect(createDatabase(file)).rejects.toThrow(/already exists/u);
    expect(existsSync(file)).toBe(true);
  });
});

describe("snapshot and verify", () => {
  it("snapshots a database into an identical, verified copy", async () => {
    const source = fresh();
    await createDatabase(source, seedFile("INSERT INTO vision_sequences (name, last_value) VALUES ('snap_seq', 7);"));
    const copy = fresh("copy");
    const result = await snapshotDatabase(source, copy);
    const original = await verifyDatabaseFile(source);
    expect(result.tableCounts).toEqual(original.tableCounts);
    expect(result.schemaVersion).toBe(latest);
    await expect(snapshotDatabase(source, copy)).rejects.toThrow(/already exists/u);
  });

  it("refuses a database whose schema was changed by hand", async () => {
    const file = fresh();
    await createDatabase(file);
    edit(file, "CREATE INDEX db_file_extra_idx ON vision_sequences (last_value);");
    await expect(verifyDatabaseFile(file)).rejects.toThrow(/schema differs/u);
  });

  it("refuses a database written by a newer Vision", async () => {
    const file = fresh();
    await createDatabase(file);
    edit(
      file,
      `INSERT INTO ${LEDGER_TABLE} (version, name, sha256, applied_at)
         VALUES (${latest + 1}, '${String(latest + 1).padStart(4, "0")}_future', 'x', '2030-01-01T00:00:00Z');`,
    );
    await expect(verifyDatabaseFile(file)).rejects.toThrow(/newer/u);
  });

  it("refuses a file that is not a Vision database", async () => {
    const file = fresh();
    edit(file, "CREATE TABLE t (a INTEGER);");
    await expect(verifyDatabaseFile(file)).rejects.toThrow();
    await expect(verifyDatabaseFile(fresh("missing"))).rejects.toThrow(/does not exist/u);
  });

  it("never writes to the file it verifies", async () => {
    const file = fresh();
    await createDatabase(file);
    const before = await verifyDatabaseFile(file);
    const after = await verifyDatabaseFile(file);
    expect(after.sha256).toBe(before.sha256);
    expect(existsSync(`${file}-wal`)).toBe(false);
  });
});
