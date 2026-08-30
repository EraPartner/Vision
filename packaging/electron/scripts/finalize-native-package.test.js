"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  finalizePackagedApp,
  refreshRuntimeManifest,
} = require("./finalize-native-package");

test("packaged app refreshes integrity after nested signing and seals the bundle", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "vision-package-sign-"));
  const calls = [];
  const refreshed = [];
  const verified = [];
  try {
    await finalizePackagedApp(
      {
        appOutDir: output,
        packager: { appInfo: { productFilename: "Vision" } },
      },
      {
        refreshManifest(runtimeRoot) {
          refreshed.push(runtimeRoot);
        },
        runner(executable, args) {
          calls.push([executable, args]);
          return { status: 0, stdout: "", stderr: "" };
        },
        async verifyManifest(runtimeRoot, options) {
          verified.push([runtimeRoot, options]);
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
    assert.deepEqual(calls, [
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

test("post-sign manifest refresh covers modified and newly sealed runtime files", async () => {
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
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(root, "manifest.json"), "utf8"),
    );
    assert.deepEqual(
      manifest.entries.map((entry) => entry.path),
      ["payload@18+safe", "sealed.txt"],
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
