/**
 * The SQLite migration runner (ADR-263): every migration from an empty file
 * and from each earlier version, down migrations, the refusals that protect a
 * database, the pre-migration copy, and the table-rebuild procedure SQLite
 * needs for changes ALTER TABLE cannot make (foreign keys, triggers, CHECKs).
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/database/connection.ts";
import {
  LEDGER_TABLE,
  MIGRATIONS_DIR,
  PRE_MIGRATION_BACKUPS_KEPT,
  loadMigrations,
  migrateConnection,
  readLedger,
  revertLatestMigration,
  runMigrations,
  schemaFingerprint,
} from "../../src/database/migrate.ts";

const root = mkdtempSync(path.join(process.env.VISION_TEST_DB_DIR ?? os.tmpdir(), "migrations-"));
let counter = 0;

function freshFile(): string {
  counter += 1;
  return path.join(root, `db-${counter}.sqlite3`);
}

function migrationsDir(files: Record<string, string>): string {
  counter += 1;
  const dir = path.join(root, `migrations-${counter}`);
  mkdirSync(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
  return dir;
}

function withDb<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = openDatabase(file, "writer");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function fingerprintOf(file: string): string {
  return withDb(file, (db) => schemaFingerprint(db));
}

afterAll(() => {
  // The run's temporary directory is removed by the global teardown.
});

describe("the repository's migrations", () => {
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const latest = migrations.at(-1)?.version ?? 0;

  it("are numbered from 0001 without gaps and the baseline comes first", () => {
    expect(migrations[0]?.name).toBe("0001_baseline");
    migrations.forEach((m, i) => expect(m.version).toBe(i + 1));
  });

  it("apply to an empty database, record every version and pass the integrity checks", async () => {
    const file = freshFile();
    const result = await runMigrations(file);
    expect(result.applied).toEqual(migrations.map((m) => m.name));
    expect(result.backupFile).toBeUndefined();
    withDb(file, (db) => {
      expect(readLedger(db).map((r) => r.version)).toEqual(migrations.map((m) => m.version));
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: latest });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    });
  });

  it("reach the same schema from every earlier version as from an empty database", async () => {
    const fresh = freshFile();
    await runMigrations(fresh);
    const expected = fingerprintOf(fresh);
    for (let from = 1; from < latest; from++) {
      const file = freshFile();
      await runMigrations(file, { targetVersion: from });
      const result = await runMigrations(file);
      expect(result.applied).toEqual(migrations.slice(from).map((m) => m.name));
      expect(result.backupFile).toBeDefined();
      expect(fingerprintOf(file)).toBe(expected);
    }
  });

  it("are idempotent: a second run applies nothing and writes no backup", async () => {
    const file = freshFile();
    await runMigrations(file);
    const again = await runMigrations(file);
    expect(again.applied).toEqual([]);
    expect(again.backupFile).toBeUndefined();
    expect(again.revision).toBe(migrations.at(-1)?.name);
  });

  it("revert and re-apply every migration that has a down file, back to the same schema", async () => {
    for (const migration of migrations.filter((m) => m.downSql !== undefined)) {
      const before = freshFile();
      await runMigrations(before, { targetVersion: migration.version - 1 });
      const file = freshFile();
      await runMigrations(file, { targetVersion: migration.version });
      await revertLatestMigration(file);
      expect(fingerprintOf(file)).toBe(fingerprintOf(before));
      await runMigrations(file, { targetVersion: migration.version });
      const after = freshFile();
      await runMigrations(after, { targetVersion: migration.version });
      expect(fingerprintOf(file)).toBe(fingerprintOf(after));
    }
  });
});

describe("the runner's refusals", () => {
  const baseline = "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);";

  it("refuses a database whose ledger holds a version this build does not know", async () => {
    const newer = migrationsDir({
      "0001_baseline.sql": baseline,
      "0002_more.sql": "ALTER TABLE items ADD COLUMN note TEXT;",
    });
    const older = migrationsDir({ "0001_baseline.sql": baseline });
    const file = freshFile();
    await runMigrations(file, { dir: newer });
    const before = fingerprintOf(file);
    await expect(runMigrations(file, { dir: older })).rejects.toThrow(/newer Vision/);
    expect(fingerprintOf(file)).toBe(before);
  });

  it("refuses an applied migration whose file changed", async () => {
    const original = migrationsDir({ "0001_baseline.sql": baseline });
    const edited = migrationsDir({ "0001_baseline.sql": `${baseline}\n-- edited` });
    const file = freshFile();
    await runMigrations(file, { dir: original });
    await expect(runMigrations(file, { dir: edited })).rejects.toThrow(/changed after it was applied/);
  });

  it("refuses a database that has tables but no ledger", async () => {
    const file = freshFile();
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE stray (x INTEGER)");
    db.close();
    await expect(
      runMigrations(file, { dir: migrationsDir({ "0001_baseline.sql": baseline }) }),
    ).rejects.toThrow(/no migration ledger/);
  });

  it("refuses migration files with a gap or a bad name", () => {
    expect(() =>
      loadMigrations(migrationsDir({ "0001_baseline.sql": baseline, "0003_skip.sql": "" })),
    ).toThrow(/without gaps/);
    expect(() =>
      loadMigrations(migrationsDir({ "0001_baseline.sql": baseline, "0002-Bad.sql": "" })),
    ).toThrow(/Invalid migration file name/);
  });

  it("rolls back the whole run when a later migration fails, and keeps the pre-migration copy", async () => {
    const good = migrationsDir({ "0001_baseline.sql": baseline });
    const failing = migrationsDir({
      "0001_baseline.sql": baseline,
      "0002_add_note.sql": "ALTER TABLE items ADD COLUMN note TEXT;",
      // SQLite cannot add a NOT NULL column without a default.
      "0003_bad.sql": "ALTER TABLE items ADD COLUMN required TEXT NOT NULL;",
    });
    const file = freshFile();
    await runMigrations(file, { dir: good });
    withDb(file, (db) => db.exec("INSERT INTO items (name) VALUES ('kept')"));
    const before = fingerprintOf(file);
    await expect(runMigrations(file, { dir: failing })).rejects.toThrow(
      /0003_bad failed: .*NOT NULL.*Nothing was changed/,
    );
    expect(fingerprintOf(file)).toBe(before);
    withDb(file, (db) => {
      expect(readLedger(db).map((r) => r.name)).toEqual(["0001_baseline"]);
      expect(db.prepare("SELECT name FROM items").all()).toEqual([{ name: "kept" }]);
    });
    const copies = readdirSync(path.join(path.dirname(file), "pre-migration-backups"));
    expect(copies.some((f) => f.includes("-v1-to-v3-"))).toBe(true);
  });

  it("keeps only the newest pre-migration copies", async () => {
    const file = freshFile();
    const backupDir = path.join(root, `copies-${counter}`);
    const files: Record<string, string> = { "0001_baseline.sql": baseline };
    await runMigrations(file, { dir: migrationsDir(files), backupDir });
    for (let v = 2; v <= PRE_MIGRATION_BACKUPS_KEPT + 3; v++) {
      files[`${String(v).padStart(4, "0")}_step.sql`] = `ALTER TABLE items ADD COLUMN c${v} TEXT;`;
      const result = await runMigrations(file, { dir: migrationsDir(files), backupDir });
      expect(result.backupFile).toBeDefined();
    }
    expect(readdirSync(backupDir)).toHaveLength(PRE_MIGRATION_BACKUPS_KEPT);
  });

  it("copies hold the data as it was before the run", async () => {
    const file = freshFile();
    const dir1 = migrationsDir({ "0001_baseline.sql": baseline });
    await runMigrations(file, { dir: dir1 });
    withDb(file, (db) => db.exec("INSERT INTO items (name) VALUES ('before')"));
    const result = await runMigrations(file, {
      dir: migrationsDir({
        "0001_baseline.sql": baseline,
        "0002_wipe.sql": "DELETE FROM items;",
      }),
    });
    expect(result.backupFile).toBeDefined();
    const copy = new DatabaseSync(result.backupFile ?? "", { readOnly: true });
    expect(copy.prepare("SELECT name FROM items").all()).toEqual([{ name: "before" }]);
    copy.close();
  });
});

describe("table rebuilds (SQLite's procedure for changes ALTER TABLE cannot make)", () => {
  const baseline = `
    CREATE TABLE parents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE children (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE
    );
    CREATE INDEX children_parent_idx ON children(parent_id);
    CREATE TABLE audit (parent_id INTEGER, amount TEXT);
    CREATE TRIGGER parents_audit AFTER UPDATE ON parents BEGIN
      INSERT INTO audit VALUES (NEW.id, NEW.amount);
    END;
    CREATE VIEW parent_totals AS SELECT p.id, count(c.id) AS n FROM parents p LEFT JOIN children c ON c.parent_id = p.id GROUP BY p.id;
  `;
  // Change parents.amount to a checked decimal column: needs a rebuild.
  const rebuild = `
    CREATE TABLE parents_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount DECIMAL_TEXT(18,2) NOT NULL CONSTRAINT parents_amount__vtype CHECK (vision_numeric_ok(amount, 18, 2)),
      updated_at TEXT
    );
    INSERT INTO parents_new (id, amount, updated_at) SELECT id, vision_numeric(amount, 18, 2), updated_at FROM parents;
    DROP VIEW parent_totals;
    DROP TABLE parents;
    ALTER TABLE parents_new RENAME TO parents;
    CREATE TRIGGER parents_audit AFTER UPDATE ON parents BEGIN
      INSERT INTO audit VALUES (NEW.id, NEW.amount);
    END;
    CREATE VIEW parent_totals AS SELECT p.id, count(c.id) AS n FROM parents p LEFT JOIN children c ON c.parent_id = p.id GROUP BY p.id;
  `;

  it("keeps rows, child foreign keys, triggers and views, and enforces the new CHECK", async () => {
    const file = freshFile();
    await runMigrations(file, { dir: migrationsDir({ "0001_baseline.sql": baseline }) });
    withDb(file, (db) => {
      db.exec("INSERT INTO parents (amount) VALUES ('12.5'), ('3')");
      db.exec("INSERT INTO children (parent_id) VALUES (1), (1), (2)");
    });
    await runMigrations(file, {
      dir: migrationsDir({ "0001_baseline.sql": baseline, "0002_rebuild_parents.sql": rebuild }),
    });
    withDb(file, (db) => {
      expect(db.prepare("SELECT id, amount FROM parents ORDER BY id").all()).toEqual([
        { id: 1, amount: "12.50" },
        { id: 2, amount: "3.00" },
      ]);
      expect(db.prepare("SELECT id, n FROM parent_totals ORDER BY id").all()).toEqual([
        { id: 1, n: 2 },
        { id: 2, n: 1 },
      ]);
      db.exec("UPDATE parents SET amount = '1.00' WHERE id = 2");
      expect(db.prepare("SELECT * FROM audit").all()).toEqual([{ parent_id: 2, amount: "1.00" }]);
      expect(() => db.exec("UPDATE parents SET amount = '1.001' WHERE id = 2")).toThrow(/CHECK/);
      // The child foreign key now points at the rebuilt table and still cascades.
      db.exec("DELETE FROM parents WHERE id = 1");
      expect(db.prepare("SELECT count(*) AS n FROM children").get()).toEqual({ n: 1 });
      expect(() => db.exec("INSERT INTO children (parent_id) VALUES (99)")).toThrow(/FOREIGN KEY/);
    });
  });

  it("refuses a rebuild that leaves rows pointing at missing parents", async () => {
    const file = freshFile();
    await runMigrations(file, { dir: migrationsDir({ "0001_baseline.sql": baseline }) });
    withDb(file, (db) => {
      db.exec("INSERT INTO parents (amount) VALUES ('1')");
      db.exec("INSERT INTO children (parent_id) VALUES (1)");
    });
    const lossy = rebuild.replace("SELECT id, vision_numeric", "SELECT id + 100, vision_numeric");
    await expect(
      runMigrations(file, {
        dir: migrationsDir({ "0001_baseline.sql": baseline, "0002_rebuild_parents.sql": lossy }),
      }),
    ).rejects.toThrow(/foreign key violations: children/);
    withDb(file, (db) => {
      expect(readLedger(db)).toHaveLength(1);
      expect(db.prepare("SELECT id FROM parents").all()).toEqual([{ id: 1 }]);
    });
  });

  it("restores foreign key enforcement after a run", () => {
    const file = freshFile();
    const db = openDatabase(file, "writer");
    try {
      migrateConnection(db, file, { dir: migrationsDir({ "0001_baseline.sql": baseline }) });
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare(`SELECT count(*) AS n FROM ${LEDGER_TABLE}`).get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
