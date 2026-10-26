import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import finalizeHook, {
  afterPack,
  ELECTRON_FUSES,
  finalizePackagedApp,
  refreshRuntimeManifest,
} from "./finalize-native-package";

void test("packaged app hook exports resolve to the finalizer", () => {
  assert.equal(finalizeHook, finalizePackagedApp);
  assert.equal(afterPack, finalizePackagedApp);
});

void test("packaged app refuses to seal a bundle whose fuses it cannot flip", async () => {
  await assert.rejects(
    finalizePackagedApp(
      { appOutDir: "/tmp", packager: { appInfo: { productFilename: "Vision" } } },
      {
        runner: () => assert.fail("must not sign"),
        async verifyManifest() {},
      },
    ),
    /cannot flip the packaged app fuses/,
  );
});

void test("packaged app flips fuses, refreshes integrity after nested signing and seals the bundle", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "vision-package-sign-"));
  const calls: [string, unknown][] = [];
  const refreshed: string[] = [];
  const verified: [string, { required: boolean }][] = [];
  try {
    await finalizePackagedApp(
      {
        appOutDir: output,
        packager: {
          appInfo: { productFilename: "Vision" },
          addElectronFuses(_context, fuses) {
            calls.push(["fuses", fuses]);
            return Promise.resolve();
          },
        },
      },
      {
        refreshManifest(runtimeRoot) {
          refreshed.push(runtimeRoot);
        },
        runner(executable, args) {
          calls.push([executable, args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        verifyManifest(runtimeRoot, options) {
          verified.push([runtimeRoot, options]);
          return Promise.resolve();
        },
      },
    );
    assert.deepEqual(verified, [
      [
        path.join(
          output,
          "Vision.app",
          "Contents",
          "Resources",
          "native-runtime",
        ),
        { required: true },
      ],
      [
        path.join(
          output,
          "Vision.app",
          "Contents",
          "Resources",
          "native-runtime",
        ),
        { required: true },
      ],
    ]);
    assert.deepEqual(refreshed, [
      path.join(
        output,
        "Vision.app",
        "Contents",
        "Resources",
        "native-runtime",
      ),
    ]);
    // Fuses must be flipped before the ad-hoc seal, or they break it.
    assert.deepEqual(calls, [
      ["fuses", ELECTRON_FUSES],
      [
        "/usr/bin/codesign",
        ["--force", "--deep", "--sign", "-", path.join(output, "Vision.app")],
      ],
      [
        "/usr/bin/codesign",
        ["--force", "--sign", "-", path.join(output, "Vision.app")],
      ],
      [
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", path.join(output, "Vision.app")],
      ],
    ]);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

void test("post-sign manifest refresh covers modified and newly sealed runtime files", async () => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-package-manifest-"),
  );
  try {
    await fs.promises.writeFile(path.join(root, "payload@18+safe"), "before");
    await fs.promises.writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({ version: 1, entries: [] }),
    );
    await fs.promises.writeFile(path.join(root, "sealed.txt"), "seal");
    assert.equal(refreshRuntimeManifest(root), 2);
    const manifest: unknown = JSON.parse(
      await fs.promises.readFile(path.join(root, "manifest.json"), "utf8"),
    );
    assert.ok(
      typeof manifest === "object" &&
        manifest !== null &&
        "entries" in manifest &&
        Array.isArray(manifest.entries),
    );
    assert.deepEqual(
      manifest.entries.map((entry: unknown) =>
        typeof entry === "object" && entry !== null && "path" in entry
          ? entry.path
          : undefined,
      ),
      ["payload@18+safe", "sealed.txt"],
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
