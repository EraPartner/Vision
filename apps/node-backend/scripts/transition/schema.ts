/**
 * The SQLite side of the transition: a freshly migrated database and what
 * its schema says about each table (declared types, primary keys,
 * AUTOINCREMENT, sequences, triggers).
 */
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../../src/database/connection.ts";
import {
  LEDGER_TABLE,
  loadMigrations,
  migrateConnection,
  readLedger,
  schemaFingerprint,
} from "../../src/database/migrate.ts";
import { TransitionError } from "./errors.ts";

export interface TargetColumn {
  name: string;
  declaredType: string;
  notNull: boolean;
  /** 1-based position in the primary key, 0 when not part of it. */
  pkPosition: number;
  /** PRAGMA table_xinfo hidden: 0 ordinary, 1 hidden (virtual tables), 2/3 generated. */
  hidden: number;
}

export interface TargetTable {
  name: string;
  /** Every column, in table order. */
  columns: TargetColumn[];
  /** Ordinary (stored, insertable) columns. */
  insertable: TargetColumn[];
  primaryKey: string[];
  /** INTEGER PRIMARY KEY AUTOINCREMENT: its counter lives in sqlite_sequence. */
  autoincrement: boolean;
  /** The sequence named by a `DEFAULT (nextval('<seq>'))` on a column. */
  nextvalDefaults: Map<string, string>;
}

export interface TargetTrigger {
  name: string;
  table: string;
  sql: string;
}

export interface TargetSchema {
  sqliteVersion: string;
  tables: Map<string, TargetTable>;
  triggers: TargetTrigger[];
  /** Names in vision_sequences after the migrations ran. */
  sequences: Set<string>;
  fingerprint: string;
  migrations: Array<{ version: number; name: string; sha256: string }>;
  schemaVersion: number;
}

export const SEQUENCES_TABLE = "vision_sequences";

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
export { quoteIdent };

interface XInfoRow {
  name: string;
  type: string;
  notnull: number | bigint;
  pk: number | bigint;
  hidden: number | bigint;
  dflt_value: string | null;
}

/** Read the schema of an open database. */
export function readTargetSchema(db: DatabaseSync): TargetSchema {
  const tables = new Map<string, TargetTable>();
  const tableRows = db
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string; sql: string | null }>;
  for (const row of tableRows) {
    const xinfo = db.prepare(`PRAGMA table_xinfo(${quoteIdent(row.name)})`).all() as unknown as XInfoRow[];
    const columns: TargetColumn[] = xinfo.map((c) => ({
      name: c.name,
      declaredType: c.type,
      notNull: Number(c.notnull) !== 0,
      pkPosition: Number(c.pk),
      hidden: Number(c.hidden),
    }));
    const primaryKey = columns
      .filter((c) => c.pkPosition > 0)
      .sort((a, b) => a.pkPosition - b.pkPosition)
      .map((c) => c.name);
    const nextvalDefaults = new Map<string, string>();
    for (const c of xinfo) {
      const m = c.dflt_value === null ? null : /^\(?\s*nextval\('((?:[^']|'')+)'\)\s*\)?$/i.exec(c.dflt_value);
      if (m?.[1] !== undefined) nextvalDefaults.set(c.name, m[1].replaceAll("''", "'"));
    }
    tables.set(row.name, {
      name: row.name,
      columns,
      insertable: columns.filter((c) => c.hidden === 0),
      primaryKey,
      autoincrement: /\bAUTOINCREMENT\b/i.test(row.sql ?? ""),
      nextvalDefaults,
    });
  }
  const triggers = db
    .prepare("SELECT name, tbl_name AS tbl, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY rowid")
    .all() as Array<{ name: string; tbl: string; sql: string | null }>;
  const sequences = new Set<string>();
  if (tables.has(SEQUENCES_TABLE)) {
    for (const r of db.prepare(`SELECT name FROM ${SEQUENCES_TABLE}`).all() as Array<{ name: string }>) {
      sequences.add(r.name);
    }
  }
  const ledger = readLedger(db);
  const version = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
  return {
    sqliteVersion: version.v,
    tables,
    triggers: triggers.map((t) => {
      if (t.sql === null) throw new TransitionError(`Trigger ${t.name} has no SQL in sqlite_schema.`);
      return { name: t.name, table: t.tbl, sql: t.sql };
    }),
    sequences,
    fingerprint: schemaFingerprint(db),
    migrations: ledger.map((m) => ({ version: m.version, name: m.name, sha256: m.sha256 })),
    schemaVersion: ledger.at(-1)?.version ?? 0,
  };
}

/**
 * Create a new database file with every migration applied, through the
 * backend's own migrator. Returns the open writer connection.
 */
export function createTargetDatabase(file: string): DatabaseSync {
  const db = openDatabase(file, "writer");
  try {
    migrateConnection(db, file, { skipBackup: true });
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** The schema fingerprint of an empty database at the latest migration. */
export function freshSchemaFingerprint(): { fingerprint: string; version: number } {
  const db = openDatabase(":memory:", "writer");
  try {
    migrateConnection(db, ":memory:", { skipBackup: true });
    const migrations = loadMigrations();
    return { fingerprint: schemaFingerprint(db), version: migrations.at(-1)?.version ?? 0 };
  } finally {
    db.close();
  }
}

export { LEDGER_TABLE };
