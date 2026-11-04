/**
 * Forward-only, versioned schema migrations for the SQLite database
 * (ADR-263; replaces the Kysely PostgreSQL migrator of ADR-222).
 *
 * Every `db/migrations/NNNN_name.sql` is one migration, numbered from 0001
 * without gaps; an optional `NNNN_name.down.sql` makes it reversible from
 * the CLI. The ledger table `vision_migrations` records each applied
 * migration's version, name and SHA-256, and the runner refuses to touch a
 * database when:
 *   - it holds application tables but no ledger,
 *   - its ledger lists a version this build does not know (a newer Vision
 *     wrote it), or
 *   - an applied migration's file changed since it was applied.
 *
 * Pending migrations run in one `BEGIN IMMEDIATE` transaction with foreign
 * keys switched off for the run (SQLite's procedure for table rebuilds), and
 * `PRAGMA foreign_key_check` must come back empty before COMMIT; any failure
 * rolls the whole run back. Before a database that already holds data is
 * migrated, a `VACUUM INTO` copy is written next to it; the newest three
 * copies are kept.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { logger } from "../config/logger.ts";
import { openDatabase } from "./connection.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// repo root: apps/node-backend/src/database/ -> ../../../..
const REPO_ROOT = process.env.VISION_RUNTIME_ROOT
  ? path.resolve(process.env.VISION_RUNTIME_ROOT)
  : path.resolve(__dirname, "..", "..", "..", "..");

export const MIGRATIONS_DIR = path.join(REPO_ROOT, "db", "migrations");
export const LEDGER_TABLE = "vision_migrations";
/** Pre-migration copies kept next to the database. */
export const PRE_MIGRATION_BACKUPS_KEPT = 3;

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  version: number;
  /** `NNNN_name` */
  name: string;
  upSql: string;
  downSql: string | undefined;
  sha256: string;
}

export interface AppliedMigration {
  version: number;
  name: string;
  sha256: string;
  appliedAt: string;
}

export interface RunMigrationsResult {
  /** Latest applied migration after the run (`NNNN_name`). */
  revision: string | undefined;
  applied: string[];
  /** The pre-migration copy written before this run, if any. */
  backupFile: string | undefined;
}

export interface MigrateOptions {
  dir?: string;
  /** Stop after this version (tests that start from an older schema). */
  targetVersion?: number;
  /** Where pre-migration copies go; default `<db dir>/pre-migration-backups`. */
  backupDir?: string;
  /** Skip the pre-migration copy (tests, and the transition script's fresh file). */
  skipBackup?: boolean;
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Read and validate the migration files. */
export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  if (!existsSync(dir)) throw new MigrationError(`Migrations directory missing: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const migrations: Migration[] = [];
  for (const file of files.filter((f) => !f.endsWith(".down.sql")).sort()) {
    const match = MIGRATION_FILE.exec(file);
    if (!match) throw new MigrationError(`Invalid migration file name: ${file}`);
    const version = Number(match[1]);
    const name = file.slice(0, -".sql".length);
    const upSql = readFileSync(path.join(dir, file), "utf8");
    const downFile = path.join(dir, `${name}.down.sql`);
    migrations.push({
      version,
      name,
      upSql,
      downSql: existsSync(downFile) ? readFileSync(downFile, "utf8") : undefined,
      sha256: sha256(upSql),
    });
  }
  for (const file of files.filter((f) => f.endsWith(".down.sql"))) {
    const up = file.replace(/\.down\.sql$/, ".sql");
    if (!files.includes(up)) throw new MigrationError(`${file} has no matching ${up}`);
  }
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(
        `Migration numbers must run from 0001 without gaps; found ${m.name} at position ${i + 1}`,
      );
    }
  });
  if (migrations.length === 0) throw new MigrationError(`No migrations in ${dir}`);
  return migrations;
}

function ensureLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

function ledgerExists(db: DatabaseSync): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(LEDGER_TABLE) !==
    undefined
  );
}

function hasApplicationObjects(db: DatabaseSync): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%' AND name <> ? LIMIT 1`,
      )
      .get(LEDGER_TABLE) !== undefined
  );
}

/** The ledger rows, oldest first. Empty when there is no ledger. */
export function readLedger(db: DatabaseSync): AppliedMigration[] {
  if (!ledgerExists(db)) return [];
  const rows = db
    .prepare(`SELECT version, name, sha256, applied_at FROM ${LEDGER_TABLE} ORDER BY version`)
    .all() as Array<{ version: number; name: string; sha256: string; applied_at: string }>;
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    sha256: r.sha256,
    appliedAt: r.applied_at,
  }));
}

/**
 * Compare the ledger with the known migrations. Returns the migrations still
 * to apply, or throws when the database must not be touched.
 */
export function planMigrations(db: DatabaseSync, migrations: readonly Migration[]): Migration[] {
  const ledger = readLedger(db);
  if (ledger.length === 0 && hasApplicationObjects(db)) {
    throw new MigrationError(
      "The database holds tables but no migration ledger; refusing to migrate it. " +
        "Open a database created by Vision, or restore a Vision backup.",
    );
  }
  const known = new Map(migrations.map((m) => [m.version, m]));
  const latestKnown = migrations.at(-1)?.version ?? 0;
  for (const [i, applied] of ledger.entries()) {
    if (applied.version !== i + 1) {
      throw new MigrationError(`The migration ledger has a gap before version ${applied.version}`);
    }
    const migration = known.get(applied.version);
    if (!migration) {
      throw new MigrationError(
        `The database was migrated to ${applied.name} by a newer Vision ` +
          `(this build knows up to version ${latestKnown}). Install the newer Vision or restore a backup.`,
      );
    }
    if (migration.name !== applied.name || migration.sha256 !== applied.sha256) {
      throw new MigrationError(
        `Migration ${applied.name} changed after it was applied (recorded ${applied.sha256.slice(0, 12)}, ` +
          `file ${migration.name} ${migration.sha256.slice(0, 12)}). Applied migrations must never be edited; add a new one.`,
      );
    }
  }
  return migrations.slice(ledger.length);
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Error code of a start-up refused because the pre-migration copy failed. */
export const PRE_MIGRATION_BACKUP_FAILED = "PRE_MIGRATION_BACKUP_FAILED";

/**
 * Prove a copy can be restored before anything relies on it: SQLite's
 * integrity_check (pages, indexes, NOT NULL and every CHECK) and
 * foreign_key_check, on a read-only handle. Throws on the first problem.
 */
function verifyCopy(file: string): void {
  const copy = openDatabase(file, "inspect");
  try {
    const integrity = copy.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(
        `the copy failed integrity_check: ${integrity.slice(0, 5).map((r) => r.integrity_check).join("; ")}`,
      );
    }
    const violations = foreignKeyViolations(copy);
    if (violations.length > 0) {
      throw new Error(`the copy has foreign key violations: ${violations.join("; ")}`);
    }
  } finally {
    copy.close();
  }
}

/**
 * Write a consistent copy of the database with VACUUM INTO, verify it, and
 * prune old copies. A copy that fails verification is removed and the error
 * thrown, so nothing is migrated without a restorable copy.
 */
export function writePreMigrationBackup(
  db: DatabaseSync,
  dbFile: string,
  fromVersion: number,
  toVersion: number,
  backupDir = path.join(path.dirname(dbFile), "pre-migration-backups"),
): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const target = path.join(
    backupDir,
    `${path.basename(dbFile, path.extname(dbFile))}-v${fromVersion}-to-v${toVersion}-${timestampForFile()}.sqlite3`,
  );
  try {
    db.prepare("VACUUM INTO ?").run(target);
    verifyCopy(target);
  } catch (err) {
    rmSync(target, { force: true });
    throw err;
  }
  const copies = readdirSync(backupDir)
    .filter((f) => f.endsWith(".sqlite3"))
    .map((f) => ({ f, t: statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => (b.t !== a.t ? b.t - a.t : b.f.localeCompare(a.f)));
  for (const old of copies.slice(PRE_MIGRATION_BACKUPS_KEPT)) {
    rmSync(path.join(backupDir, old.f), { force: true });
  }
  return target;
}

function foreignKeyViolations(db: DatabaseSync): string[] {
  const rows = db.prepare("PRAGMA foreign_key_check").all() as Array<{
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }>;
  return rows.slice(0, 20).map((r) => `${r.table} row ${String(r.rowid)} -> ${r.parent}`);
}

/**
 * Apply pending migrations to an open connection. The connection must not be
 * inside a transaction. Exported for the transition script and tests;
 * the backend calls {@link runMigrations}.
 */
export function migrateConnection(
  db: DatabaseSync,
  dbFile: string,
  options: MigrateOptions = {},
): RunMigrationsResult {
  const migrations = loadMigrations(options.dir);
  const target = options.targetVersion ?? migrations.at(-1)?.version ?? 0;
  const pending = planMigrations(db, migrations).filter((m) => m.version <= target);
  const ledgerBefore = readLedger(db);
  const current = ledgerBefore.at(-1);
  const last = pending.at(-1);
  if (!last) {
    return { revision: current?.name, applied: [], backupFile: undefined };
  }

  let backupFile: string | undefined;
  if (!options.skipBackup && current && dbFile !== ":memory:") {
    try {
      backupFile = writePreMigrationBackup(
        db,
        dbFile,
        current.version,
        last.version,
        options.backupDir,
      );
    } catch (err) {
      // Nothing was migrated. The desktop app shows this code's own message.
      throw Object.assign(
        new Error(
          `Vision could not back up the database before migrating it: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        ),
        { code: PRE_MIGRATION_BACKUP_FAILED },
      );
    }
    logger.info("pre-migration backup written", { file: backupFile });
  }

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    let running: Migration | undefined;
    try {
      ensureLedger(db);
      const record = db.prepare(
        `INSERT INTO ${LEDGER_TABLE} (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)`,
      );
      for (const migration of pending) {
        running = migration;
        db.exec(migration.upSql);
        record.run(migration.version, migration.name, migration.sha256, new Date().toISOString());
      }
      running = undefined;
      const violations = foreignKeyViolations(db);
      if (violations.length > 0) {
        throw new MigrationError(
          `Migrations left foreign key violations: ${violations.join("; ")}`,
        );
      }
      db.exec(`PRAGMA user_version = ${last.version}`);
      db.exec("COMMIT");
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      const where = running ? `${running.name} failed` : "Migration run failed";
      throw err instanceof MigrationError
        ? err
        : new MigrationError(
            `${where}: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`,
            { cause: err },
          );
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  const applied = pending.map((m) => m.name);
  logger.info("migrations applied", { applied });
  return { revision: applied.at(-1), applied, backupFile };
}

/** Run `fn` on a dedicated writer connection; failures become a rejected promise. */
function withMigrationConnection<T>(file: string, fn: (db: DatabaseSync) => T): Promise<T> {
  try {
    const db = openDatabase(file, "writer");
    try {
      return Promise.resolve(fn(db));
    } finally {
      db.close();
    }
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Apply every pending migration to the database file. Runs on its own
 * connection before the backend opens its shared ones.
 */
export function runMigrations(
  file: string,
  options: MigrateOptions = {},
): Promise<RunMigrationsResult> {
  return withMigrationConnection(file, (db) => migrateConnection(db, file, options));
}

/** Revert the latest migration. Only migrations with a `.down.sql` can revert. */
export function revertLatestMigration(
  file: string,
  options: Pick<MigrateOptions, "dir"> = {},
): Promise<string | undefined> {
  return withMigrationConnection(file, (db) => {
    const migrations = loadMigrations(options.dir);
    planMigrations(db, migrations);
    const ledger = readLedger(db);
    const current = ledger.at(-1);
    const migration = current ? migrations[current.version - 1] : undefined;
    if (!current || !migration?.downSql) {
      throw new MigrationError(
        `${current?.name ?? "No migration"} has no down migration; restore a backup instead`,
      );
    }
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(migration.downSql);
        db.prepare(`DELETE FROM ${LEDGER_TABLE} WHERE version = ?`).run(current.version);
        const violations = foreignKeyViolations(db);
        if (violations.length > 0) {
          throw new MigrationError(`Down migration left foreign key violations: ${violations.join("; ")}`);
        }
        db.exec(`PRAGMA user_version = ${current.version - 1}`);
        db.exec("COMMIT");
      } catch (err) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
    return ledger.at(-2)?.name;
  });
}

export interface MigrationStatus {
  name: string;
  executedAt: Date | undefined;
}

export function readMigrationStatus(
  file: string,
  options: Pick<MigrateOptions, "dir"> = {},
): Promise<MigrationStatus[]> {
  return withMigrationConnection(file, (db) => {
    const applied = new Map(readLedger(db).map((a) => [a.version, a]));
    return loadMigrations(options.dir).map((m) => {
      const at = applied.get(m.version)?.appliedAt;
      return { name: m.name, executedAt: at ? new Date(at) : undefined };
    });
  });
}

/**
 * Normalised schema of a database for comparisons: every table, index,
 * trigger and view with its SQL, whitespace collapsed, excluding SQLite's own
 * objects and the migration ledger.
 */
export function schemaFingerprint(db: DatabaseSync): string {
  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%' AND tbl_name <> ?
        ORDER BY type, name`,
    )
    .all(LEDGER_TABLE) as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const text = rows
    .map((r) => {
      // ALTER TABLE ... RENAME rewrites names, and references to them, as
      // quoted identifiers; double quotes only ever quote identifiers here.
      const sql = (r.sql ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1");
      return `${r.type}\t${r.name}\t${r.tbl_name}\t${sql}`;
    })
    .join("\n");
  return sha256(text);
}
