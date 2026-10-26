import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getConfig } from "app-builder-lib/out/util/config/config";
import { log } from "electron-builder";
import type { FileSet } from "electron-builder";

import { appRoot } from "../paths";
import {
  packageConfig,
  packageResources,
  parseArgs,
} from "./build-native-package";

// The test runner reads its report messages from this process's stdout, where
// electron-builder's "  • " log prefix can be misread as a message length and
// fail the file with "Unable to deserialize cloned data". The stream is
// declared protected, so it is replaced reflectively.
assert.equal(Reflect.set(log, "stream", process.stderr), true);

function fileSets(
  value: FileSet | string | (FileSet | string)[] | null | undefined,
): FileSet[] {
  assert.ok(Array.isArray(value));
  return value.map((entry) => {
    assert.ok(typeof entry === "object", "expected a file set");
    return entry;
  });
}

void test("native package builder accepts only the isolated directory mode flag", () => {
  assert.deepEqual(parseArgs([]), { demo: false, directoryOnly: false });
  assert.deepEqual(parseArgs(["--dir"]), {
    demo: false,
    directoryOnly: true,
  });
  assert.deepEqual(parseArgs(["--demo"]), {
    demo: true,
    directoryOnly: false,
  });
  assert.throws(() => parseArgs(["--publish"]), /Unexpected package argument/);
});

void test("native package resources use the prepared payload without path strings", () => {
  const runtimeRoot = path.join("/private", "tmp", "vision", "native-runtime");
  const resources = packageResources(runtimeRoot);
  assert.deepEqual(resources, [
    {
      from: runtimeRoot,
      to: "native-runtime",
    },
  ]);
  assert.ok(resources.every((entry) => typeof entry.from === "string"));
  const { afterPack } = packageConfig(runtimeRoot);
  assert.equal(afterPack, path.join(__dirname, "finalize-native-package.js"));
  assert.ok(fs.existsSync(afterPack), "afterPack hook must be compiled");
});

void test("Demo packages reuse the native payload and add only isolated seed resources", async () => {
  const runtimeRoot = path.join("/private", "tmp", "vision", "native-runtime");
  const demoSeedRoot = path.join("/private", "tmp", "vision", "demo-seed");
  const config = packageConfig(runtimeRoot, { demoSeedRoot });
  assert.equal(config.extends, "./electron-builder-demo.json");
  assert.deepEqual(config.extraResources, [
    { from: runtimeRoot, to: "native-runtime" },
    { from: demoSeedRoot, to: "demo-seed" },
  ]);

  const { extends: configPath, ...overrides } = config;
  const effective = await getConfig(appRoot, configPath, overrides);
  assert.equal(effective.appId, "com.vaultvoyager.vision-demo");
  assert.equal(effective.productName, "Vision Demo");
  assert.equal(effective.directories?.output, "dist-demo");
  const extraResources = fileSets(effective.extraResources);
  assert.deepEqual(
    extraResources.map(({ to }) => to),
    ["i18n", "resources/DEMO", "native-runtime", "demo-seed"],
  );
  assert.deepEqual(extraResources[1], {
    from: "resources-demo/DEMO",
    to: "resources/DEMO",
  });
  assert.equal(
    extraResources.some(({ from }) => from === "resources"),
    false,
  );
});

void test("native package excludes test data, source maps, and foreign Bare prebuilds", async () => {
  const effective = await getConfig(appRoot, null, undefined);
  const [fileSet] = fileSets(effective.files);
  const files = fileSet?.filter;
  assert.ok(Array.isArray(files));
  assert.ok(files.includes("out/**/*"));
  assert.ok(files.includes("assets/**/*"));
  assert.ok(files.includes("!out/**/*.test.js"));
  assert.ok(files.includes("!out/scripts/**/*"));
  assert.ok(files.includes("!out/demo-db/**/*"));
  assert.ok(files.includes("!out/.built"));
  assert.ok(files.includes("!node_modules/**/*.map"));
  assert.ok(
    files.includes(
      "!node_modules/bare-{fs,os,url}/prebuilds/!(darwin-arm64)/**/*",
    ),
  );
});
