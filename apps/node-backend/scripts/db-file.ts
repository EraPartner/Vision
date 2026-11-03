#!/usr/bin/env bun
/**
 * Database-file operations the desktop runtime runs with the bundled Bun
 * (ADR-263). Each command prints one JSON line on stdout and exits 0 on
 * success, 1 on failure (the JSON then carries `error`).
 *
 *   snapshot <database> <destination>
 *       Write a consistent copy with VACUUM INTO while the backend may be
 *       running (WAL readers never block), then verify the copy. Refuses an
 *       existing destination.
 *   verify <database>
 *       Check a database before it is restored or opened, without writing to
 *       it: SQLite integrity_check (which also evaluates every CHECK),
 *       foreign_key_check, that its migration ledger is one this build can
 *       open (not newer, no edited migration), and that its schema equals a
 *       fresh install migrated to the same version.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, rmSync, statSync } from "node:fs";
import { openDatabase } from "../src/database/connection.ts";
import {
  loadMigrations,
  migrateConnection,
  planMigrations,
  readLedger,
  schemaFingerprint,
} from "../src/database/migrate.ts";

interface VerifyResult {
  ok: boolean;
  file: string;
  bytes: number;
  sha256: string;
  sqliteVersion: string;
  schemaVersion: number;
  pendingMigrations: number;
  error?: string;
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function freshFingerprint(version: number): string {
  const db = openDatabase(":memory:", "writer");
  try {
    migrateConnection(db, ":memory:", { targetVersion: version, skipBackup: true });
    return schemaFingerprint(db);
  } finally {
    db.close();
  }
}

export async function verifyDatabaseFile(file: string): Promise<VerifyResult> {
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  // Opened read-only so verification never changes the file it checks; the
  // Vision functions are registered because CHECKs call them.
  const raw = openDatabase(file, "inspect");
  try {
    const integrity = raw.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(`integrity_check failed: ${integrity.slice(0, 5).map((r) => r.integrity_check).join("; ")}`);
    }
    const fk = raw.prepare("PRAGMA foreign_key_check").all();
    if (fk.length > 0) throw new Error(`foreign_key_check found ${fk.length} violation(s)`);
    const pending = planMigrations(raw, loadMigrations());
    const ledger = readLedger(raw);
    if (ledger.length === 0) throw new Error("not a Vision database (no migration ledger)");
    const schemaVersion = ledger.at(-1)?.version ?? 0;
    if (schemaFingerprint(raw) !== freshFingerprint(schemaVersion)) {
      throw new Error(`schema differs from a fresh Vision install at version ${schemaVersion}`);
    }
    const version = (raw.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    return {
      ok: true,
      file,
      bytes: statSync(file).size,
      sha256: await fileSha256(file),
      sqliteVersion: version,
      schemaVersion,
      pendingMigrations: pending.length,
    };
  } finally {
    raw.close();
  }
}

export async function snapshotDatabase(source: string, destination: string): Promise<VerifyResult> {
  if (existsSync(destination)) throw new Error(`${destination} already exists`);
  if (!existsSync(source)) throw new Error(`${source} does not exist`);
  // VACUUM INTO only reads the source, but query_only would refuse it.
  const db = openDatabase(source, "writer");
  try {
    db.prepare("VACUUM INTO ?").run(destination);
    return await verifyDatabaseFile(destination);
  } catch (err) {
    rmSync(destination, { force: true });
    throw err;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    let result: VerifyResult;
    const [first, second] = args;
    if (command === "snapshot" && first !== undefined && second !== undefined && args.length === 2) {
      result = await snapshotDatabase(first, second);
    } else if (command === "verify" && first !== undefined && args.length === 1) {
      result = await verifyDatabaseFile(first);
    } else {
      throw new Error("usage: db-file.ts snapshot <database> <destination> | verify <database>");
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`);
    process.exit(1);
  }
}
