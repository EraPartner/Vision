import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  verifyRuntimeManifest,
  verifyRuntimeManifestOnLaunch,
} from "./runtime-manifest";

for (const fault of ["none", "missing", "extra", "size", "hash", "symlink"] as const) {
  test(`worker runtime verification fails closed for ${fault}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vision-manifest-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const contents = Buffer.alloc(128 * 1024, 7);
    await fs.writeFile(path.join(root, "binary"), contents);
    await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify({version: 1, entries: [{ path: "binary", bytes: contents.length + (fault === "size" ? 1 : 0), sha256: crypto.createHash("sha256").update(contents).digest("hex") }]}));
    if (fault === "missing") await fs.unlink(path.join(root, "binary"));
    if (fault === "extra") await fs.writeFile(path.join(root, "extra"), "unlisted");
    if (fault === "hash") await fs.writeFile(path.join(root, "binary"), Buffer.alloc(contents.length, 8));
    if (fault === "symlink") { await fs.rename(path.join(root, "binary"), path.join(root, "target")); await fs.symlink("target", path.join(root, "binary")); }
    if (fault === "none") assert.deepEqual(await verifyRuntimeManifest(root, { required: true }), { status: "verified", entries: 1 });
    else await assert.rejects(verifyRuntimeManifest(root, { required: true }), { code: "NATIVE_RUNTIME_CORRUPT" });
  });
}

const FILES: Record<string, Buffer> = {
  "bin/postgres": Buffer.alloc(64 * 1024, 1),
  "dist/index.html": Buffer.from("<!DOCTYPE html>"),
};

async function payload(t: test.TestContext, appVersion = "1.0.2") {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "vision-launch-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "native-runtime");
  for (const [relative, contents] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), contents);
  }
  await writeManifest(root, appVersion);
  const markerPath = path.join(temp, "userData", "native", "vision", "runtime-verification.json");
  return { root, markerPath };
}

async function writeManifest(root: string, appVersion: string) {
  const entries = Object.entries(FILES).map(([relative, contents]) => ({
    path: relative,
    bytes: contents.length,
    sha256: crypto.createHash("sha256").update(contents).digest("hex"),
  }));
  await fs.writeFile(
    path.join(root, "manifest.json"),
    JSON.stringify({ version: 1, appVersion, entries }),
  );
}

test("the first launch hashes the payload and records it; later launches only check sizes", async (t) => {
  const { root, markerPath } = await payload(t);
  const options = { required: true, markerPath };

  assert.deepEqual(await verifyRuntimeManifestOnLaunch(root, options), {
    status: "verified",
    entries: 2,
    mode: "full",
  });
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  const manifestSha256 = crypto
    .createHash("sha256")
    .update(await fs.readFile(path.join(root, "manifest.json")))
    .digest("hex");
  assert.equal(marker.manifestSha256, manifestSha256);
  assert.equal(marker.appVersion, "1.0.2");
  assert.equal(marker.runtimeRoot, root);
  assert.equal((await fs.stat(markerPath)).mode & 0o777, 0o600);

  // A same-size change is invisible to the size check (ADR-235): the launch
  // stays on the cached path instead of re-reading every byte.
  await fs.writeFile(path.join(root, "bin/postgres"), Buffer.alloc(64 * 1024, 2));
  assert.deepEqual(await verifyRuntimeManifestOnLaunch(root, options), {
    status: "verified",
    entries: 2,
    mode: "cached",
  });
});

for (const fault of ["size", "missing", "extra", "symlink"] as const) {
  test(`a recorded payload with a ${fault} fault falls back to the full check and fails closed`, async (t) => {
    const { root, markerPath } = await payload(t);
    const options = { required: true, markerPath };
    await verifyRuntimeManifestOnLaunch(root, options);

    const target = path.join(root, "dist/index.html");
    if (fault === "size") await fs.writeFile(target, "<!DOCTYPE html><p>changed</p>");
    if (fault === "missing") await fs.unlink(target);
    if (fault === "extra") await fs.writeFile(path.join(root, "dist/extra.js"), "x");
    if (fault === "symlink") {
      await fs.rename(target, path.join(root, "dist/real.html"));
      await fs.symlink("real.html", target);
    }
    await assert.rejects(verifyRuntimeManifestOnLaunch(root, options), {
      code: "NATIVE_RUNTIME_CORRUPT",
    });
  });
}

test("a new installed version, moved payload or unusable marker re-hashes the payload", async (t) => {
  const { root, markerPath } = await payload(t);
  const options = { required: true, markerPath };
  await verifyRuntimeManifestOnLaunch(root, options);

  await writeManifest(root, "1.0.3");
  assert.equal((await verifyRuntimeManifestOnLaunch(root, options)).status, "verified");
  assert.equal(
    JSON.parse(await fs.readFile(markerPath, "utf8")).appVersion,
    "1.0.3",
  );

  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  await fs.writeFile(markerPath, JSON.stringify({ ...marker, runtimeRoot: "/elsewhere" }));
  assert.deepEqual(await verifyRuntimeManifestOnLaunch(root, options), {
    status: "verified",
    entries: 2,
    mode: "full",
  });

  await fs.writeFile(markerPath, "not json");
  assert.deepEqual(await verifyRuntimeManifestOnLaunch(root, options), {
    status: "verified",
    entries: 2,
    mode: "full",
  });
});

test("a marker that cannot be written never blocks a verified launch", async (t) => {
  const { root, markerPath } = await payload(t);
  // The marker's parent is a regular file, so the write fails.
  await fs.mkdir(path.dirname(path.dirname(markerPath)), { recursive: true });
  await fs.writeFile(path.dirname(markerPath), "blocking file");
  const options = { required: true, markerPath };
  for (let launch = 0; launch < 2; launch++) {
    assert.deepEqual(await verifyRuntimeManifestOnLaunch(root, options), {
      status: "verified",
      entries: 2,
      mode: "full",
    });
  }
});

test("launch verification keeps the missing-manifest rules", async (t) => {
  const { root, markerPath } = await payload(t);
  await fs.unlink(path.join(root, "manifest.json"));
  assert.deepEqual(
    await verifyRuntimeManifestOnLaunch(root, { required: false, markerPath }),
    { status: "not-present" },
  );
  await assert.rejects(
    verifyRuntimeManifestOnLaunch(root, { required: true, markerPath }),
    { code: "NATIVE_RUNTIME_CORRUPT" },
  );
});
