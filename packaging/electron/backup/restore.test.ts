import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { createZipWriter } from "./zip-writer";
import { openBundle } from "./bundle";
import {
  assertBackupSchemaCompatible,
  init,
  resolveDatabaseEnvironment,
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
    () =>
      assertBackupSchemaCompatible(
        "0072_future_revision",
        "0071_current_revision",
      ),
    (error) =>
      error instanceof Error &&
      error.message.startsWith("BUNDLE_SCHEMA_NEWER:") &&
      error.message.includes("0072_future_revision") &&
      error.message.includes("0071_current_revision"),
  );
});

void test("restore accepts equal and older Vision schema revisions", () => {
  assert.doesNotThrow(() =>
    assertBackupSchemaCompatible(
      "0071_current_revision",
      "0071_current_revision",
    ),
  );
  assert.doesNotThrow(() =>
    assertBackupSchemaCompatible(
      "0070_previous_revision",
      "0071_current_revision",
    ),
  );
});

void test("restore does not reject schema identifiers that cannot be ordered", () => {
  assert.doesNotThrow(() =>
    assertBackupSchemaCompatible("hash_revision", "0071_current_revision"),
  );
});

void test("a bundle whose metadata.json is not an object is rejected as corrupt", async (t) => {
  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vision-restore-meta-"),
  );
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const bundlePath = path.join(workDir, "null-metadata.visionbak");
  const archive = await createZipWriter(bundlePath);
  await archive.append("metadata.json", "null");
  await archive.append("db.sql", "SELECT 1;\n");
  await archive.finalize();

  await assert.rejects(openBundle(bundlePath), /missing metadata\.json/);
});

const PRE_BASELINE_DUMP = "CREATE TABLE public.notes (id int);\n";

function kyselyDump(...names: string[]): string {
  return `CREATE TABLE public.kysely_migration (
    name character varying(255) NOT NULL,
    "timestamp" character varying(255) NOT NULL
);
COPY public.notes (id, body) FROM stdin;
1\tCOPY public.kysely_migration (name, "timestamp") FROM stdin;
\\.
COPY public.kysely_migration (name, "timestamp") FROM stdin;
${names.map((name) => `${name}\t2026-10-19T00:00:00.000Z`).join("\n")}
\\.
`;
}

function initRuntime(currentHead: string, restored: string[]): void {
  init({
    runtimeProvider: () => ({
      mode: "native",
      getSchemaHead: () => Promise.resolve(currentHead),
      activateRestoredDatabase: () => {
        restored.push("activateRestoredDatabase");
        return Promise.reject(new Error("restore must not be reached"));
      },
    }),
  });
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    error.code === code &&
    /only backups taken after that switch can be restored/i.test(error.message);
}

async function writeDump(t: TestContext, sql: string): Promise<string> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-dump-"));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const dumpPath = path.join(workDir, "backup.sql");
  await fs.promises.writeFile(dumpPath, sql);
  return dumpPath;
}

async function writeBundle(
  t: TestContext,
  sql: string,
  schemaHead: string,
): Promise<string> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-bundle-"));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const bundlePath = path.join(workDir, "backup.visionbak");
  const archive = await createZipWriter(bundlePath);
  await archive.append(
    "metadata.json",
    JSON.stringify({ bundleVersion: 1, schemaHead, appVersion: "1.0.2" }),
  );
  await archive.append("db.sql", sql);
  await archive.finalize();
  return bundlePath;
}

void test("restore refuses a plain dump without a migration ledger", async (t) => {
  const restored: string[] = [];
  initRuntime("0001_baseline", restored);
  const dumpPath = await writeDump(t, PRE_BASELINE_DUMP);

  await assert.rejects(runRestore(dumpPath), hasCode("BACKUP_PRE_BASELINE"));
  assert.deepEqual(restored, []);
});

void test("restore refuses a bundle whose dump predates the baseline", async (t) => {
  const restored: string[] = [];
  initRuntime("0001_baseline", restored);
  const bundlePath = await writeBundle(
    t,
    PRE_BASELINE_DUMP,
    "0128_category_path_on_legacy_rename",
  );

  await assert.rejects(
    runBundleRestore(bundlePath),
    hasCode("BACKUP_PRE_BASELINE"),
  );
  assert.deepEqual(restored, []);
});

void test("restore rejects a dump whose highest migration is newer than this install", async (t) => {
  const restored: string[] = [];
  initRuntime("0001_baseline", restored);
  const dumpPath = await writeDump(
    t,
    kyselyDump("0001_baseline", "0003_future", "0002_next"),
  );

  await assert.rejects(
    runRestore(dumpPath),
    (error) =>
      error instanceof Error &&
      error.message.startsWith("BUNDLE_SCHEMA_NEWER:") &&
      error.message.includes('"0003_future"') &&
      error.message.includes('"0001_baseline"'),
  );
  assert.deepEqual(restored, []);
});

void test("restore rejects a bundle whose metadata disagrees with its dump", async (t) => {
  const restored: string[] = [];
  initRuntime("0002_next", restored);
  const bundlePath = await writeBundle(
    t,
    kyselyDump("0001_baseline"),
    "0002_next",
  );

  await assert.rejects(runBundleRestore(bundlePath), /does not match/);
  assert.deepEqual(restored, []);
});
