/**
 * Shared fixtures for the Vision 2.0 -> SQLite transition tests.
 *
 * fixtures/ holds two bundles Vision 2.0.0's own backup code wrote (plain
 * and encrypted) from a PostgreSQL 18 database of edge-case rows, and
 * expected.json, computed by PostgreSQL itself (row counts, per-table
 * checksums of the expected SQLite values, numeric totals, sequences). The
 * generator needs a PostgreSQL server and lives outside the repository.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZipWriter, readEntry, readZipEntries, MAX_TOTAL_BYTES } from "../../scripts/transition/zip.ts";
import { runTransition } from "../../scripts/transition/run.ts";
import type { RunOptions, RunResult } from "../../scripts/transition/run.ts";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const PLAIN_BUNDLE = path.join(FIXTURES, "vision-2.0.0-fixture.visionbak");
export const ENCRYPTED_BUNDLE = path.join(FIXTURES, "vision-2.0.0-fixture.visionbak.enc");

export interface Expected {
  passphrase: string;
  bundles: { plain: { file: string; sha256: string }; encrypted: { file: string; sha256: string } };
  dbSqlSha256: string;
  attachments: Record<string, string>;
  frontendState: unknown;
  tables: Record<string, { rows: number; sha256: string; columns: string[]; primaryKey: string[] }>;
  numericTotals: Record<string, { count: number; sum: string | null; min: string | null; max: string | null }>;
  sequences: Record<string, string>;
  ledger: string[];
}

export function expected(): Expected {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(FIXTURES, "expected.json"), "utf8"));
  return parsed as Expected;
}

const created: string[] = [];

export function tempDir(prefix = "vision-transition-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export interface Captured extends RunResult {
  out: string[];
  err: string[];
  text: string;
}

/** Run the transition in-process with captured output. */
export async function run(
  options: Partial<RunOptions> & Pick<RunOptions, "input" | "mode">,
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const passphrase = expected().passphrase;
  const result = await runTransition({
    userData: tempDir(),
    passphrase: () => Promise.resolve(passphrase),
    print: (line) => out.push(line),
    progress: (line) => err.push(line),
    toolVersion: "test",
    ...options,
  });
  return { ...result, out, err, text: out.join("\n") };
}

/**
 * Write a copy of a plain bundle with db.sql (and optionally other members)
 * changed, keeping every other member as it was.
 */
export async function rewriteBundle(
  source: string,
  destination: string,
  change: { dbSql?: (text: string) => string; drop?: string[]; add?: Record<string, Buffer> },
): Promise<void> {
  const entries = await readZipEntries(source);
  const budget = { remaining: MAX_TOTAL_BYTES };
  const writer = await createZipWriter(destination);
  for (const entry of entries) {
    if (change.drop?.includes(entry.name) === true) continue;
    if (entry.isDirectory) {
      await writer.addDirectory(entry.name);
      continue;
    }
    let data = await readEntry(source, entry, budget);
    if (entry.name === "db.sql" && change.dbSql !== undefined) data = Buffer.from(change.dbSql(data.toString("utf8")), "utf8");
    await writer.addBuffer(entry.name, data);
  }
  for (const [name, data] of Object.entries(change.add ?? {})) await writer.addBuffer(name, data);
  await writer.finalize();
}

export function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
