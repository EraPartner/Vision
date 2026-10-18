import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyRuntimeManifest } from "./runtime-manifest";

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
