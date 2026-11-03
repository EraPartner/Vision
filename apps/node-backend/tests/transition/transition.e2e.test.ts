/**
 * End to end: the transition on the Vision 2.0.0 fixture bundles, checked
 * against values PostgreSQL computed (fixtures/expected.json).
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/database/connection.ts";
import { verifyDatabaseFile } from "../../scripts/db-file.ts";
import { main } from "../../scripts/transition/cli.ts";
import { TYPE_MAPPING } from "../../scripts/transition/typeMapping.ts";
import type { TypeRule } from "../../scripts/transition/typeMapping.ts";
import { readZipEntries } from "../../scripts/transition/zip.ts";
import {
  ENCRYPTED_BUNDLE,
  PLAIN_BUNDLE,
  expected,
  removeTempDirs,
  rewriteBundle,
  run,
  sha256,
  tempDir,
} from "./helpers.ts";
import type { Captured } from "./helpers.ts";

const EXPECTED = expected();

afterAll(removeTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
});

function rule(sqlite: string): TypeRule {
  const found = TYPE_MAPPING.find((r) => r.sqlite === sqlite);
  if (found === undefined) throw new Error(`no rule ${sqlite}`);
  return found;
}

/** Every table, numeric total and sequence equals what PostgreSQL computed. */
function expectMatchesPostgres(result: Captured): void {
  const report = result.report;
  expect(report).not.toBeNull();
  if (report === null) return;
  const tables = new Map(report.tables.map((t) => [t.table, t]));
  const skipped = new Set(report.skippedDumpTables.map((t) => t.name.replace(/^public\./, "")));
  for (const [name, table] of Object.entries(EXPECTED.tables)) {
    if (skipped.has(name)) continue;
    const got = tables.get(name);
    expect(got, name).toBeDefined();
    expect(got?.rows, name).toEqual({ dump: table.rows, sqlite: table.rows });
    expect(got?.checksum.sqlite, name).toBe(table.sha256);
    expect(got?.checksum.dump, name).toBe(table.sha256);
  }
  const totals = new Map(report.decimalTotals.map((d) => [`${d.table}.${d.column}`, d]));
  expect(totals.size).toBe(Object.keys(EXPECTED.numericTotals).length);
  for (const [key, total] of Object.entries(EXPECTED.numericTotals)) {
    expect(totals.get(key)?.sqlite, key).toEqual(total);
    expect(totals.get(key)?.dump, key).toEqual(total);
  }
  const sequences = new Map(report.sequences.map((s) => [s.sequence.replace(/^public\./, ""), s.actual]));
  expect(Object.fromEntries(sequences)).toEqual(EXPECTED.sequences);
  expect(report.attachments.sha256).toEqual(EXPECTED.attachments);
}

describe("dry run", () => {
  it("converts and verifies the plain fixture, installs nothing, leaves the input alone", async () => {
    const userData = tempDir();
    const work = tempDir();
    const before = sha256(PLAIN_BUNDLE);
    const result = await run({ input: PLAIN_BUNDLE, mode: "dry-run", userData, tempRoot: work, report: path.join(tempDir(), "r.json") });
    expect(result.exitCode).toBe(0);
    expect(result.report?.status).toBe("verified");
    expect(result.report?.checks.every((c) => c.ok)).toBe(true);
    expect(result.report?.failures).toEqual([]);
    expectMatchesPostgres(result);
    expect(sha256(PLAIN_BUNDLE)).toBe(before);
    expect(result.report?.input.sha256).toBe(EXPECTED.bundles.plain.sha256);
    expect(result.report?.bundle.dumpSha256).toBe(EXPECTED.dbSqlSha256);
    expect(fs.readdirSync(userData)).toEqual([]);
    expect(fs.readdirSync(work)).toEqual([]); // the private work directory is gone
    expect(result.text).toContain("all checks passed");
    expect(result.text).toContain("They cannot prove");
    expect(result.reportPath).not.toBeNull();
    const written: unknown = JSON.parse(fs.readFileSync(result.reportPath ?? "", "utf8"));
    expect(written).toMatchObject({ status: "verified", input: { sha256: EXPECTED.bundles.plain.sha256 } });
    expect(result.report?.notVerifiable.length).toBeGreaterThan(3);
    expect(result.report?.customSqlAnalyses.length).toBeGreaterThan(0);
  });
});

describe("install", () => {
  it("installs the encrypted fixture, then recognises a re-run with the same backup", async () => {
    const userData = tempDir();
    const first = await run({ input: ENCRYPTED_BUNDLE, mode: "install", userData });
    expect(first.exitCode).toBe(0);
    expect(first.report?.status).toBe("installed");
    expect(first.report?.input.encrypted).toBe(true);
    expectMatchesPostgres(first);

    const database = path.join(userData, "database", "vision.sqlite3");
    expect(fs.statSync(database).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(userData, "database")).mode & 0o777).toBe(0o700);
    expect(sha256(database)).toBe(first.report?.target.databaseSha256);
    // The app's own restore verifier accepts it.
    await expect(verifyDatabaseFile(database)).resolves.toMatchObject({ ok: true });
    // The input, byte for byte, beside it.
    const sources = fs.readdirSync(path.join(userData, "database", "transition-source"));
    expect(sources).toHaveLength(1);
    expect(sha256(path.join(userData, "database", "transition-source", sources[0] ?? ""))).toBe(EXPECTED.bundles.encrypted.sha256);
    // Attachments where Vision keeps them, each with its SHA-256.
    for (const [relative, digest] of Object.entries(EXPECTED.attachments)) {
      expect(sha256(path.join(userData, "native", "vision", "attachments", ...relative.split("/"))), relative).toBe(digest);
    }
    // The record and the report.
    const record = JSON.parse(fs.readFileSync(path.join(userData, "database", "vision-transition.json"), "utf8")) as {
      input: { sha256: string };
      report: { file: string; sha256: string };
    };
    expect(record.input.sha256).toBe(EXPECTED.bundles.encrypted.sha256);
    expect(sha256(record.report.file)).toBe(record.report.sha256);
    expect(path.dirname(record.report.file)).toBe(path.join(userData, "database"));

    // A spot check of values through a plain connection.
    const db = openDatabase(database, "inspect");
    try {
      const amounts = db.prepare("SELECT amount FROM transactions WHERE id IN (1, 2, 4) ORDER BY id").all();
      expect(amounts).toEqual([{ amount: "-12345678901234.5678" }, { amount: "99999999999999.9999" }, { amount: "-0.0001" }]);
      const ts = db.prepare("SELECT created_at, updated_at FROM transactions WHERE id = 1").get();
      expect(ts).toEqual({ created_at: "2026-03-29T00:59:59.999999Z", updated_at: "2026-03-29T01:00:00.000000Z" });
      const seq = db.prepare("SELECT last_value FROM vision_sequences WHERE name = 'portfolio_transactions_id_seq'").get();
      expect(seq).toEqual({ last_value: Number(EXPECTED.sequences.portfolio_transactions_id_seq) });
    } finally {
      db.close();
    }

    // Same backup again: nothing changes, exit 0.
    const before = fs.readdirSync(path.join(userData, "database")).sort();
    const again = await run({ input: ENCRYPTED_BUNDLE, mode: "install", userData });
    expect(again.exitCode).toBe(0);
    expect(again.alreadyTransitioned).toBe(true);
    expect(again.text).toContain("already transitioned from this backup");
    expect(fs.readdirSync(path.join(userData, "database")).sort()).toEqual(before);

    // A different backup: refused, nothing overwritten.
    const dbSha = sha256(database);
    const other = await run({ input: PLAIN_BUNDLE, mode: "install", userData });
    expect(other.exitCode).toBe(1);
    expect(other.text).toContain("never overwrites a database");
    expect(sha256(database)).toBe(dbSha);
  });

  it("refuses to install over an existing database it did not write", async () => {
    const userData = tempDir();
    fs.mkdirSync(path.join(userData, "database"));
    fs.writeFileSync(path.join(userData, "database", "vision.sqlite3"), "not ours");
    const result = await run({ input: PLAIN_BUNDLE, mode: "install", userData });
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("already exists");
    expect(fs.readFileSync(path.join(userData, "database", "vision.sqlite3"), "utf8")).toBe("not ours");
  });

  it("refuses a stale -wal file and an attachment that would be replaced", async () => {
    const userData = tempDir();
    fs.mkdirSync(path.join(userData, "database"));
    fs.writeFileSync(path.join(userData, "database", "vision.sqlite3-wal"), "old");
    const wal = await run({ input: PLAIN_BUNDLE, mode: "install", userData });
    expect(wal.exitCode).toBe(1);
    expect(wal.text).toContain("-wal exists without its database");

    const second = tempDir();
    const clash = path.join(second, "native", "vision", "attachments", "1", "3f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf");
    fs.mkdirSync(path.dirname(clash), { recursive: true });
    fs.writeFileSync(clash, "a different file");
    const att = await run({ input: PLAIN_BUNDLE, mode: "install", userData: second });
    expect(att.exitCode).toBe(1);
    expect(att.text).toContain("never overwrites a file");
    expect(fs.readFileSync(clash, "utf8")).toBe("a different file");
    expect(fs.existsSync(path.join(second, "database", "vision.sqlite3"))).toBe(false);
  });

  it("leaves Vision 2.0's PostgreSQL data untouched", async () => {
    const userData = tempDir();
    const pgData = path.join(userData, "native", "vision", "postgres", "data");
    fs.mkdirSync(pgData, { recursive: true });
    fs.writeFileSync(path.join(pgData, "PG_VERSION"), "18\n");
    const result = await run({ input: PLAIN_BUNDLE, mode: "install", userData });
    expect(result.exitCode).toBe(0);
    expect(fs.readdirSync(pgData)).toEqual(["PG_VERSION"]);
    expect(fs.readFileSync(path.join(pgData, "PG_VERSION"), "utf8")).toBe("18\n");
    expect(result.report?.warnings.some((w) => w.includes("left untouched"))).toBe(true);
  });
});

describe("refusals", () => {
  it("names a wrong passphrase", async () => {
    const result = await run({ input: ENCRYPTED_BUNDLE, mode: "dry-run", passphrase: () => Promise.resolve("wrong") });
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("wrong passphrase, or the file was changed or damaged");
  });

  it("detects a changed byte in an encrypted backup (GCM)", async () => {
    const copy = path.join(tempDir(), "tampered.visionbak.enc");
    const data = fs.readFileSync(ENCRYPTED_BUNDLE);
    const at = Math.floor(data.length / 2);
    data[at] = (data[at] ?? 0) ^ 0x01;
    fs.writeFileSync(copy, data);
    const result = await run({ input: copy, mode: "dry-run" });
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("AES-GCM authentication failed");
  });

  it("detects a changed byte inside the zip (CRC-32)", async () => {
    const entries = await readZipEntries(PLAIN_BUNDLE);
    const dump = entries.find((e) => e.name === "db.sql");
    if (dump === undefined) throw new Error("fixture has no db.sql");
    const copy = path.join(tempDir(), "crc.visionbak");
    const data = fs.readFileSync(PLAIN_BUNDLE);
    const at = dump.dataOffset + Math.floor(dump.compressedSize / 2);
    data[at] = (data[at] ?? 0) ^ 0x10;
    fs.writeFileSync(copy, data);
    const result = await run({ input: copy, mode: "dry-run" });
    expect(result.exitCode).toBe(1);
    expect(result.text).toMatch(/not a valid Vision bundle/);
  });

  it("names table, column, row and value when db.sql holds a value the schema cannot take", async () => {
    const copy = path.join(tempDir(), "value.visionbak");
    await rewriteBundle(PLAIN_BUNDLE, copy, {
      dbSql: (text) => text.replace("\n2\t2024-02-29\t99999999999999.9999\t", "\n2\t2024-02-29\t99999999999999.99990\t"),
    });
    const result = await run({ input: copy, mode: "dry-run" });
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("transactions.amount");
    expect(result.text).toContain("row id=\"2\"");
    expect(result.text).toContain("99999999999999.99990");
    expect(result.text).toContain("what to do:");
  });

  it("refuses a truncated dump", async () => {
    const copy = path.join(tempDir(), "truncated.visionbak");
    await rewriteBundle(PLAIN_BUNDLE, copy, { dbSql: (text) => text.slice(0, Math.floor(text.length * 0.7)) });
    const result = await run({ input: copy, mode: "dry-run" });
    expect(result.exitCode).toBe(1);
    expect(result.text).toMatch(/truncated/);
  });

  it("refuses an older and a newer migration ledger", async () => {
    const older = path.join(tempDir(), "older.visionbak");
    await rewriteBundle(PLAIN_BUNDLE, older, {
      dbSql: (text) => text.replace(/\n0005_simplify_portfolio_reconciliation\t[^\n]*/, ""),
    });
    const a = await run({ input: older, mode: "dry-run" });
    expect(a.exitCode).toBe(1);
    expect(a.text).toContain("lacks 0005_simplify_portfolio_reconciliation (an older database)");

    const newer = path.join(tempDir(), "newer.visionbak");
    await rewriteBundle(PLAIN_BUNDLE, newer, {
      dbSql: (text) =>
        text.replace(
          /(\n0005_simplify_portfolio_reconciliation\t[^\n]*)/,
          "$1\n0006_something_newer\t2026-12-01T00:00:00.000Z",
        ),
    });
    const b = await run({ input: newer, mode: "dry-run" });
    expect(b.exitCode).toBe(1);
    expect(b.text).toContain("0006_something_newer (a newer database)");
  });

  it("refuses a bundle with an unexpected member or a SQLite database", async () => {
    const extra = path.join(tempDir(), "extra.visionbak");
    await rewriteBundle(PLAIN_BUNDLE, extra, { add: { "notes.txt": Buffer.from("hi") } });
    const a = await run({ input: extra, mode: "dry-run" });
    expect(a.exitCode).toBe(1);
    expect(a.text).toContain('"notes.txt"');

    const sqlite = path.join(tempDir(), "sqlite.visionbak");
    await rewriteBundle(PLAIN_BUNDLE, sqlite, { drop: ["db.sql"], add: { "db.sqlite3": Buffer.from("SQLite format 3\0") } });
    const b = await run({ input: sqlite, mode: "dry-run" });
    expect(b.exitCode).toBe(1);
    expect(b.text).toContain("needs no transition");
  });
});

describe("verification catches a broken conversion", () => {
  it("a timestamp off by one microsecond", async () => {
    const timestamps = rule("TIMESTAMPTZ_TEXT");
    const original = timestamps.build.bind(timestamps);
    vi.spyOn(timestamps, "build").mockImplementation((facts, typmod, checks) => {
      const convert = original(facts, typmod, checks);
      return (text, note) => {
        const value = convert(text, note);
        if (facts.table !== "transactions" || facts.column !== "updated_at" || typeof value !== "string") return value;
        return value.replace(/([0-9])Z$/, (_m, d: string) => `${(Number(d) + 1) % 10}Z`);
      };
    });
    const userData = tempDir();
    const result = await run({ input: PLAIN_BUNDLE, mode: "install", userData });
    expect(result.exitCode).toBe(1);
    expect(result.report?.status).toBe("failed");
    const failure = result.report?.failures.find((f) => f.check === "round trip");
    expect(failure).toMatchObject({ table: "transactions", column: "updated_at" });
    // The run's own checksums agree (both sides used the broken conversion); the round trip does not.
    expect(result.report?.checks.find((c) => c.name === "table checksums")?.ok).toBe(true);
    expect(result.report?.checks.find((c) => c.name === "round trip")?.ok).toBe(false);
    expect(fs.existsSync(path.join(userData, "database"))).toBe(false);
    expect(result.text).toContain("Nothing was installed");
  });

  it("an amount changed in its last digit", async () => {
    const decimals = rule("DECIMAL_TEXT(p,s)");
    const original = decimals.build.bind(decimals);
    vi.spyOn(decimals, "build").mockImplementation((facts, typmod, checks) => {
      const convert = original(facts, typmod, checks);
      return (text, note) => {
        const value = convert(text, note);
        if (facts.table !== "transactions" || facts.column !== "amount" || value !== "-0.0001") return value;
        return "-0.0002";
      };
    });
    const result = await run({ input: PLAIN_BUNDLE, mode: "dry-run" });
    expect(result.exitCode).toBe(1);
    const checks = new Map(result.report?.checks.map((c) => [c.name, c.ok]));
    expect(checks.get("round trip")).toBe(false);
    expect(checks.get("decimal totals")).toBe(false);
    const total = result.report?.decimalTotals.find((d) => d.table === "transactions" && d.column === "amount");
    expect(total?.dump.sum).toBe(EXPECTED.numericTotals["transactions.amount"]?.sum);
    expect(total?.sqlite.sum).not.toBe(total?.dump.sum);
    expect(result.text).toContain('dump value   "-0.0001"');
  });
});

// The compiled Electron backup module (the vitest global setup builds packaging/electron/out).
interface OpenedBundle {
  metadata: Readonly<Record<string, unknown>>;
  databasePath: string | null;
  dbSqlPath: string | null;
  attachmentsDir: string | null;
  frontendState: unknown;
  cleanup: () => void;
}
interface BundleModule {
  openBundle: (file: string, options?: { passphrase?: string | null }) => Promise<OpenedBundle>;
  createBundle: (options: {
    destDir: string;
    deviceId: string;
    appVersion?: string | null;
    databasePath: string;
    database: { schemaVersion: number; sqliteVersion?: string | null; sha256?: string | null; bytes?: number | null };
    attachmentsDir?: string | null;
    frontendState?: unknown;
  }) => Promise<{ bundlePath: string }>;
  BUNDLE_VERSION: number;
}
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const bundleModule = createRequire(import.meta.url)(
  path.join(REPO_ROOT, "packaging/electron/out/backup/bundle.js"),
) as BundleModule;

describe("--to-backup", () => {
  it("writes an encrypted format-2 bundle that Vision's openBundle restores, laid out like createBundle", async () => {
    const dir = tempDir();
    const out = path.join(dir, "converted.visionbak.enc");
    const result = await run({ input: ENCRYPTED_BUNDLE, mode: "to-backup", toBackup: out });
    expect(result.exitCode).toBe(0);
    expect(result.report?.output).toMatchObject({ backup: out, backupEncrypted: true, backupFormat: bundleModule.BUNDLE_VERSION });
    expect(fs.readFileSync(out).subarray(0, 10).toString()).toBe("VISIONBAK2");

    const opened = await bundleModule.openBundle(out, { passphrase: EXPECTED.passphrase });
    try {
      expect(opened.dbSqlPath).toBeNull();
      expect(opened.databasePath).not.toBeNull();
      const databasePath = opened.databasePath ?? "";
      expect(opened.metadata).toMatchObject({
        bundleVersion: bundleModule.BUNDLE_VERSION,
        database: "sqlite",
        schemaVersion: result.report?.target.schemaVersion,
        databaseSha256: sha256(databasePath),
        databaseBytes: fs.statSync(databasePath).size,
        deviceId: "fixture0",
        encrypted: false,
      });
      expect(opened.frontendState).toEqual(EXPECTED.frontendState);
      for (const [relative, digest] of Object.entries(EXPECTED.attachments)) {
        expect(sha256(path.join(opened.attachmentsDir ?? "", ...relative.split("/"))), relative).toBe(digest);
      }
      await expect(verifyDatabaseFile(databasePath)).resolves.toMatchObject({ ok: true });

      // Same members, same order, same metadata keys as Vision's own createBundle.
      const reference = await bundleModule.createBundle({
        destDir: dir,
        deviceId: "fixture0",
        appVersion: "test",
        databasePath,
        database: { schemaVersion: 1, sqliteVersion: "x", sha256: sha256(databasePath), bytes: 1 },
        attachmentsDir: opened.attachmentsDir,
        frontendState: opened.frontendState,
      });
      const plain = path.join(dir, "converted-plain.visionbak");
      const again = await run({ input: PLAIN_BUNDLE, mode: "to-backup", toBackup: plain });
      expect(again.exitCode).toBe(0);
      const names = async (file: string): Promise<string[]> => (await readZipEntries(file)).map((e) => e.name);
      expect(await names(plain)).toEqual(await names(reference.bundlePath));
      const refOpened = await bundleModule.openBundle(reference.bundlePath);
      const ownOpened = await bundleModule.openBundle(plain);
      try {
        expect(Object.keys(ownOpened.metadata)).toEqual(Object.keys(refOpened.metadata));
      } finally {
        refOpened.cleanup();
        ownOpened.cleanup();
      }
    } finally {
      opened.cleanup();
    }
  });

  it("refuses an existing destination", async () => {
    const out = path.join(tempDir(), "exists.visionbak");
    fs.writeFileSync(out, "keep me");
    const result = await run({ input: PLAIN_BUNDLE, mode: "to-backup", toBackup: out });
    expect(result.exitCode).toBe(1);
    expect(fs.readFileSync(out, "utf8")).toBe("keep me");
  });
});

describe("--output", () => {
  it("writes the verified database to a new file only", async () => {
    const out = path.join(tempDir(), "vision.sqlite3");
    const result = await run({ input: PLAIN_BUNDLE, mode: "output", output: out });
    expect(result.exitCode).toBe(0);
    expect(sha256(out)).toBe(result.report?.target.databaseSha256);
    await expect(verifyDatabaseFile(out)).resolves.toMatchObject({ ok: true });
  });
});

describe("command line", () => {
  const io = (): { out: string[]; err: string[]; stdout: (l: string) => void; stderr: (l: string) => void } => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  };

  it("exits 2 on usage errors and 0 for --help", async () => {
    const a = io();
    expect((await main([], { ...a, env: {}, interactive: false })).exitCode).toBe(2);
    expect((await main(["x", "y"], { ...a, env: {}, interactive: false })).exitCode).toBe(2);
    expect((await main([PLAIN_BUNDLE, "--bogus"], { ...a, env: {}, interactive: false })).exitCode).toBe(2);
    expect((await main([PLAIN_BUNDLE, "--dry-run", "--to-backup", "x"], { ...a, env: {}, interactive: false })).exitCode).toBe(2);
    const b = io();
    expect((await main(["--help"], { ...b, env: {}, interactive: false })).exitCode).toBe(0);
    expect(b.out.join("\n")).toContain("transition:v2");
  });

  it("asks for a passphrase source when the backup is encrypted and stdin is not a terminal", async () => {
    const a = io();
    const result = await main([ENCRYPTED_BUNDLE, "--dry-run"], { ...a, env: {}, interactive: false });
    expect(result.exitCode).toBe(2);
    expect(a.out.join("\n")).toContain("--passphrase-file");
  });

  it("reads the passphrase from --passphrase-file and from VISION_BACKUP_PASSPHRASE", async () => {
    const file = path.join(tempDir(), "pass.txt");
    fs.writeFileSync(file, `${EXPECTED.passphrase}\n`, { mode: 0o600 });
    const report = path.join(tempDir(), "r1.json");
    const a = io();
    expect((await main([ENCRYPTED_BUNDLE, "--dry-run", "--passphrase-file", file, "--report", report], { ...a, env: {}, interactive: false })).exitCode).toBe(0);
    const b = io();
    const report2 = path.join(tempDir(), "r2.json");
    expect(
      (
        await main([ENCRYPTED_BUNDLE, "--dry-run", "--report", report2], {
          ...b,
          env: { VISION_BACKUP_PASSPHRASE: EXPECTED.passphrase },
          interactive: false,
        })
      ).exitCode,
    ).toBe(0);
    expect(b.out.join("\n")).toContain(`Report: ${report2}`);
  });
});
