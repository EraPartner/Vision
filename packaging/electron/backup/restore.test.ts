import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { createZipWriter } from "./zip-writer";
import { BUNDLE_VERSION, createBundle, encryptBundle, openBundle } from "./bundle";
import {
  assertBackupSchemaCompatible,
  init,
  resolveDatabaseEnvironment,
  runBundleBackup,
  runBundleRestore,
  runRestore,
} from "./restore";

void test("encrypted bundle authentication failures retain the UI sentinel", async (t) => {
  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vision-restore-pass-"),
  );
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const bundlePath = path.join(workDir, "fixture.visionbak.enc");
  fs.writeFileSync(
    bundlePath,
    Buffer.from(
      "564953494f4e42414b32101112131415161718191a1b1c1d1e1f202122232425262728292a2bbd9495463b5f7bc5ffe64f413139d351365637cf70df5ba6862a7887fda8f510ddc61336d088aff162cd4ca0e7",
      "hex",
    ),
  );

  await assert.rejects(
    runBundleRestore(bundlePath, { passphrase: "wrong-passphrase" }),
    /INVALID_PASSPHRASE/,
  );
});

void test("restore environment resolves the active native runtime", async () => {
  const nativeRuntime = { mode: "native" };
  init({
    workDir: () => "/path/that/must/not/be/read",
    runtimeProvider: () => nativeRuntime,
  });

  const resolved = await resolveDatabaseEnvironment();

  assert.equal(resolved.nativeRuntime, nativeRuntime);
});

void test("restore fails closed without a native runtime", async () => {
  init({ runtimeProvider: () => null });

  await assert.rejects(resolveDatabaseEnvironment(), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(
      "code" in error ? error.code : undefined,
      "NATIVE_RUNTIME_REQUIRED",
    );
    return true;
  });
});

void test("restore rejects a backup created on a newer Vision schema", () => {
  assert.throws(
    () => assertBackupSchemaCompatible(72, 71),
    (error) =>
      error instanceof Error &&
      error.message.startsWith("BUNDLE_SCHEMA_NEWER:") &&
      error.message.includes("schema version 72") &&
      error.message.includes("at 71"),
  );
});

void test("restore accepts equal and older Vision schema versions", () => {
  assert.doesNotThrow(() => assertBackupSchemaCompatible(71, 71));
  assert.doesNotThrow(() => assertBackupSchemaCompatible(70, 71));
});

void test("restore leaves the decision to verification when this install's version is unknown", () => {
  assert.doesNotThrow(() => assertBackupSchemaCompatible(72, 0));
});

/** A file with a valid SQLite header; user_version is the schema version. */
function sqliteHeader(userVersion: number): Buffer {
  const header = Buffer.alloc(4096);
  header.write("SQLite format 3\0", 0, "latin1");
  header.writeUInt16BE(4096, 16);
  header.writeUInt8(2, 18);
  header.writeUInt8(2, 19);
  header.writeUInt32BE(1, 28);
  header.writeUInt32BE(1, 56);
  header.writeInt32BE(userVersion, 60);
  header.writeUInt32BE(3_043_002, 96);
  return header;
}

function tempDir(t: TestContext, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An install whose db/migrations ends at `version`. */
function installWithMigrations(t: TestContext, version: number): string {
  const root = tempDir(t, "vision-install-");
  const migrations = path.join(root, "db", "migrations");
  fs.mkdirSync(migrations, { recursive: true });
  for (let current = 1; current <= version; current += 1) {
    fs.writeFileSync(
      path.join(migrations, `${String(current).padStart(4, "0")}_step.sql`),
      "SELECT 1;\n",
    );
  }
  return root;
}

interface RecordedRuntime {
  calls: unknown[];
}

function initRuntime(
  workDir: string | undefined,
  { failActivation = true }: { failActivation?: boolean } = {},
): RecordedRuntime {
  const recorded: RecordedRuntime = { calls: [] };
  const step = (name: string) => () => {
    recorded.calls.push(name);
    return Promise.resolve();
  };
  init({
    workDir: () => workDir,
    runtimeProvider: () => ({
      mode: "native",
      activateRestoredDatabase: (sourcePath: string, options: unknown) => {
        recorded.calls.push([
          "activateRestoredDatabase",
          fs.readFileSync(sourcePath).subarray(0, 16).toString("latin1"),
          options,
        ]);
        if (failActivation)
          return Promise.reject(new Error("restore must not be reached"));
        return Promise.resolve({ switchToken: { id: "database" } });
      },
      replaceAttachments: () => {
        recorded.calls.push("replaceAttachments");
        return Promise.resolve({ id: "attachments" });
      },
      start: step("start"),
      waitUntilReady: step("waitUntilReady"),
      finalizeDatabaseSwitch: step("finalizeDatabase"),
      finalizeAttachmentSwitch: step("finalizeAttachments"),
      rollbackAttachmentSwitch: step("rollbackAttachments"),
      rollbackDatabaseSwitch: step("rollbackDatabase"),
    }),
  });
  return recorded;
}

function isUnsupportedFormat(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "BACKUP_FORMAT_UNSUPPORTED" &&
    error.message.includes("backup format 1")
  );
}

async function writeZip(
  t: TestContext,
  members: Record<string, string | Buffer>,
): Promise<string> {
  const bundlePath = path.join(tempDir(t, "vision-bundle-"), "backup.visionbak");
  const archive = await createZipWriter(bundlePath);
  for (const [name, contents] of Object.entries(members))
    await archive.append(name, contents);
  await archive.finalize();
  return bundlePath;
}

void test("a bundle whose metadata.json is not an object is rejected as corrupt", async (t) => {
  const bundlePath = await writeZip(t, {
    "metadata.json": "null",
    "db.sqlite3": sqliteHeader(1),
  });
  await assert.rejects(openBundle(bundlePath), /missing metadata\.json/);
});

void test("a bundle without a database member is rejected as corrupt", async (t) => {
  const bundlePath = await writeZip(t, {
    "metadata.json": JSON.stringify({ bundleVersion: 2 }),
  });
  await assert.rejects(openBundle(bundlePath), /missing db\.sqlite3/);
});

void test("createBundle writes the SQLite snapshot and its facts into format 2", async (t) => {
  const work = tempDir(t, "vision-create-");
  const databasePath = path.join(work, "snapshot.sqlite3");
  fs.writeFileSync(databasePath, sqliteHeader(9));
  const { bundlePath } = await createBundle({
    destDir: path.join(work, "out"),
    deviceId: "testdev",
    appVersion: "2.1.0",
    databasePath,
    database: {
      schemaVersion: 9,
      sqliteVersion: "3.43.2",
      sha256: "b".repeat(64),
      bytes: 4096,
    },
    frontendState: { keys: { theme: "dark" } },
  });
  assert.match(path.basename(bundlePath), /^vision_backup_testdev_.*\.visionbak$/);
  const opened = await openBundle(bundlePath);
  t.after(opened.cleanup);
  assert.ok(opened.databasePath);
  assert.deepEqual(
    fs.readFileSync(opened.databasePath),
    fs.readFileSync(databasePath),
  );
  assert.equal(opened.metadata.bundleVersion, BUNDLE_VERSION);
  assert.equal(opened.metadata.database, "sqlite");
  assert.equal(opened.metadata.schemaVersion, 9);
  assert.equal(opened.metadata.sqliteVersion, "3.43.2");
  assert.equal(opened.metadata.databaseSha256, "b".repeat(64));
  assert.equal(opened.metadata.databaseBytes, 4096);
  assert.deepEqual(opened.frontendState, { keys: { theme: "dark" } });
});

void test("createBundle refuses a database file that is not SQLite", async (t) => {
  const work = tempDir(t, "vision-create-");
  const databasePath = path.join(work, "db.sql");
  fs.writeFileSync(databasePath, "CREATE TABLE notes (id int);\n");
  await assert.rejects(
    createBundle({
      destDir: work,
      deviceId: "testdev",
      databasePath,
      database: { schemaVersion: 1 },
    }),
    /not a SQLite database/,
  );
  assert.deepEqual(
    fs.readdirSync(work).filter((name) => name.includes("visionbak")),
    [],
  );
});

void test("restore refuses a bundle of an older format", async (t) => {
  const recorded = initRuntime(installWithMigrations(t, 3));
  const bundlePath = await writeZip(t, {
    "metadata.json": JSON.stringify({
      bundleVersion: 1,
      schemaHead: "0128_category_path_on_legacy_rename",
      appVersion: "2.0.0",
    }),
    "db.sql": "CREATE TABLE public.notes (id int);\n",
  });
  await assert.rejects(runBundleRestore(bundlePath), isUnsupportedFormat);
  assert.deepEqual(recorded.calls, []);
});

void test("restore refuses a file that is not a SQLite database", async (t) => {
  const recorded = initRuntime(installWithMigrations(t, 3));
  const filePath = path.join(tempDir(t, "vision-other-"), "notes.sqlite3");
  fs.writeFileSync(filePath, "not a database");
  await assert.rejects(runRestore(filePath), {
    code: "BACKUP_UNRECOGNIZED",
  });
  assert.deepEqual(recorded.calls, []);
});

void test("restore rejects a bundle whose schema is newer than this install", async (t) => {
  const recorded = initRuntime(installWithMigrations(t, 3));
  const bundlePath = await writeZip(t, {
    "metadata.json": JSON.stringify({ bundleVersion: 2, schemaVersion: 4 }),
    "db.sqlite3": sqliteHeader(4),
  });
  await assert.rejects(runBundleRestore(bundlePath), /^Error: BUNDLE_SCHEMA_NEWER:/);
  assert.deepEqual(recorded.calls, []);
});

void test("restore rejects a database file whose schema is newer than this install", async (t) => {
  const recorded = initRuntime(installWithMigrations(t, 3));
  const filePath = path.join(tempDir(t, "vision-file-"), "copy.sqlite3");
  fs.writeFileSync(filePath, sqliteHeader(5));
  await assert.rejects(runRestore(filePath), /BUNDLE_SCHEMA_NEWER:/);
  assert.deepEqual(recorded.calls, []);
});

void test("bundle restore activates the database with the facts its metadata recorded", async (t) => {
  const recorded = initRuntime(installWithMigrations(t, 3), {
    failActivation: false,
  });
  const bundlePath = await writeZip(t, {
    "metadata.json": JSON.stringify({
      bundleVersion: 2,
      schemaVersion: 3,
      databaseSha256: "c".repeat(64),
    }),
    "db.sqlite3": sqliteHeader(3),
    "attachments/receipt.txt": "synthetic",
    "frontend-state.json": JSON.stringify({ keys: { locale: "en" } }),
  });
  const result = await runBundleRestore(bundlePath);
  assert.deepEqual(result.frontendState, { keys: { locale: "en" } });
  assert.deepEqual(recorded.calls, [
    [
      "activateRestoredDatabase",
      "SQLite format 3\0",
      { expectedSchemaVersion: 3, expectedSha256: "c".repeat(64) },
    ],
    "replaceAttachments",
    "start",
    "waitUntilReady",
    "finalizeDatabase",
    "finalizeAttachments",
  ]);
});

void test("bundle restore ignores malformed metadata expectations and lets verification decide", async (t) => {
  const recorded = initRuntime(installWithMigrations(t, 3), {
    failActivation: false,
  });
  const bundlePath = await writeZip(t, {
    "metadata.json": JSON.stringify({
      bundleVersion: 2,
      schemaVersion: "3",
      databaseSha256: "not-a-digest",
    }),
    "db.sqlite3": sqliteHeader(3),
  });
  await runBundleRestore(bundlePath);
  assert.deepEqual(recorded.calls[0], [
    "activateRestoredDatabase",
    "SQLite format 3\0",
    { expectedSchemaVersion: undefined, expectedSha256: undefined },
  ]);
});

void test("database file restore activates a SQLite file without attachments", async (t) => {
  const recorded = initRuntime(installWithMigrations(t, 3), {
    failActivation: false,
  });
  const filePath = path.join(tempDir(t, "vision-file-"), "copy.sqlite3");
  fs.writeFileSync(filePath, sqliteHeader(2));
  await runRestore(filePath);
  assert.deepEqual(recorded.calls, [
    ["activateRestoredDatabase", "SQLite format 3\0", {
      expectedSchemaVersion: undefined,
      expectedSha256: undefined,
    }],
    "start",
    "waitUntilReady",
    "finalizeDatabase",
  ]);
});

void test("a backup refuses a system directory even when it comes from stored settings", async () => {
  init({ runtimeProvider: () => null });
  await assert.rejects(
    runBundleBackup("/etc/vision", null),
    /system directories is not allowed/,
  );
});

void test("an encrypted backup reaches its folder only as owner-only ciphertext", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-backup-dest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staging = path.join(root, "staging");
  const destDir = path.join(root, "iCloud Backups");
  fs.mkdirSync(staging);
  const databasePath = path.join(staging, "snapshot.sqlite3");
  fs.writeFileSync(databasePath, sqliteHeader(1));

  const { bundlePath } = await createBundle({
    destDir: staging,
    deviceId: "abcd1234",
    appVersion: "2.1.0",
    databasePath,
    database: {
      schemaVersion: 1,
      sqliteVersion: "3.43.2",
      sha256: "c".repeat(64),
      bytes: 4096,
    },
    attachmentsDir: null,
    frontendState: null,
  });
  assert.equal(fs.statSync(bundlePath).mode & 0o777, 0o600);
  const { encPath } = await encryptBundle(bundlePath, "correct horse", {
    destDir,
  });

  assert.deepEqual(fs.readdirSync(destDir), [path.basename(encPath)]);
  assert.match(path.basename(encPath), /\.visionbak\.enc$/);
  assert.equal(fs.statSync(encPath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(bundlePath), false);
  const opened = await openBundle(encPath, { passphrase: "correct horse" });
  t.after(opened.cleanup);
  assert.equal(opened.metadata.schemaVersion, 1);
});
