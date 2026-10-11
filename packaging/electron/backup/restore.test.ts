import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ZipArchive } from "archiver";
import { openBundle } from "./bundle";
import {
  assertBackupSchemaCompatible,
  init,
  resolveDatabaseEnvironment,
  runBundleRestore,
} from "./restore";

test("encrypted bundle authentication failures retain the UI sentinel", async (t) => {
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

test("restore environment resolves the active native runtime", async () => {
  const nativeRuntime = { mode: "native" };
  init({
    workDir: () => "/path/that/must/not/be/read",
    runtimeProvider: () => nativeRuntime,
  });

  const resolved = await resolveDatabaseEnvironment();

  assert.equal(resolved.nativeRuntime, nativeRuntime);
});

test("restore fails closed without a native runtime", async () => {
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

test("restore rejects a backup created on a newer Vision schema", () => {
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

test("restore accepts equal and older Vision schema revisions", () => {
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

test("restore does not reject schema identifiers that cannot be ordered", () => {
  assert.doesNotThrow(() =>
    assertBackupSchemaCompatible("hash_revision", "0071_current_revision"),
  );
});

test("a bundle whose metadata.json is not an object is rejected as corrupt", async (t) => {
  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vision-restore-meta-"),
  );
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const bundlePath = path.join(workDir, "null-metadata.visionbak");
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(bundlePath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("error", reject);
    output.on("error", reject);
    output.on("close", () => resolve());
    archive.pipe(output);
    archive.append("null", { name: "metadata.json" });
    archive.append("SELECT 1;\n", { name: "db.sql" });
    void archive.finalize();
  });

  await assert.rejects(openBundle(bundlePath), /missing metadata\.json/);
});
