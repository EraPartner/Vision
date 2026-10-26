import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bumpVersions } from "../version-bump.ts";
import type { VersionBumpFileSystem } from "../version-bump.ts";

function fixture(
  rootVersion = "1.0.2",
  frontendVersion = rootVersion,
  electronVersion = rootVersion,
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-version-bump-"));
  fs.mkdirSync(path.join(root, "apps/frontend"), { recursive: true });
  fs.mkdirSync(path.join(root, "packaging/electron"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "vision", version: rootVersion, private: true }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "apps/frontend/package.json"),
    `${JSON.stringify({ name: "vision-frontend", version: frontendVersion, private: true }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "packaging/electron/package.json"),
    `${JSON.stringify({ name: "vision-desktop", version: electronVersion, main: "main.js" }, null, 2)}\n`,
  );
  return root;
}

function readManifest(root: string, relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function versionOf(root: string, relativePath: string): unknown {
  const manifest = readManifest(root, relativePath);
  assert.ok(typeof manifest === "object" && manifest !== null);
  return "version" in manifest ? manifest.version : undefined;
}

function manifestTexts(root: string): string[] {
  return [
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
    fs.readFileSync(path.join(root, "apps/frontend/package.json"), "utf8"),
    fs.readFileSync(path.join(root, "packaging/electron/package.json"), "utf8"),
  ];
}

void test("updates all enforced version sources and preserves other fields", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  bumpVersions(root, "2.3.4");

  const app = readManifest(root, "package.json");
  const frontend = readManifest(root, "apps/frontend/package.json");
  const electron = readManifest(root, "packaging/electron/package.json");
  assert.deepEqual(app, { name: "vision", version: "2.3.4", private: true });
  assert.deepEqual(frontend, {
    name: "vision-frontend",
    version: "2.3.4",
    private: true,
  });
  assert.deepEqual(electron, {
    name: "vision-desktop",
    version: "2.3.4",
    main: "main.js",
  });
});

void test("rejects invalid versions without changing any manifest", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = manifestTexts(root);

  for (const invalid of [
    "v2.3.4",
    "2.3.4-beta.1",
    "02.3.4",
    "2.03.4",
    "2.3.04",
  ]) {
    assert.throws(
      () => bumpVersions(root, invalid),
      /must use canonical x\.y\.z/,
    );
    assert.deepEqual(manifestTexts(root), before);
  }
});

void test("rejects a pre-existing mismatch instead of concealing it", (t) => {
  const root = fixture("1.0.2", "1.0.1", "1.0.2");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => bumpVersions(root, "2.0.0"), /existing version mismatch/);
  assert.equal(versionOf(root, "package.json"), "1.0.2");
  assert.equal(versionOf(root, "apps/frontend/package.json"), "1.0.1");
  assert.equal(versionOf(root, "packaging/electron/package.json"), "1.0.2");
});

void test("rolls back all manifests if the third staged replacement fails", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = manifestTexts(root);
  let renameCount = 0;
  const failingFileSystem: VersionBumpFileSystem = {
    readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
    writeFileSync: (file, data, encoding) =>
      fs.writeFileSync(file, data, encoding),
    existsSync: (file) => fs.existsSync(file),
    rmSync: (file, options) => fs.rmSync(file, options),
    renameSync(from, to) {
      renameCount += 1;
      if (renameCount === 6) {
        throw Object.assign(new Error("injected third replacement failure"), {
          code: "EACCES",
        });
      }
      fs.renameSync(from, to);
    },
  };

  assert.throws(
    () => bumpVersions(root, "2.0.0", failingFileSystem),
    /injected third replacement failure/,
  );
  assert.deepEqual(manifestTexts(root), before);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.includes(".version-bump-")),
    [],
  );
  assert.deepEqual(
    fs
      .readdirSync(path.join(root, "apps/frontend"))
      .filter((name) => name.includes(".version-bump-")),
    [],
  );
  assert.deepEqual(
    fs
      .readdirSync(path.join(root, "packaging/electron"))
      .filter((name) => name.includes(".version-bump-")),
    [],
  );
});
