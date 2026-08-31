"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { getConfig } = require("app-builder-lib/out/util/config/config");

const {
  packageConfig,
  packageResources,
  parseArgs,
} = require("./build-native-package");

test("native package builder accepts only the isolated directory mode flag", () => {
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

test("native package resources use the prepared payload without path strings", () => {
  const runtimeRoot = path.join("/private", "tmp", "vision", "native-runtime");
  const resources = packageResources(runtimeRoot);
  assert.deepEqual(resources, [
    {
      from: runtimeRoot,
      to: "native-runtime",
    },
  ]);
  assert.ok(resources.every((entry) => typeof entry.from === "string"));
  assert.equal(
    packageConfig(runtimeRoot).afterPack,
    path.join(__dirname, "finalize-native-package.js"),
  );
});

test("Demo packages reuse the native payload and add only isolated seed resources", async () => {
  const runtimeRoot = path.join("/private", "tmp", "vision", "native-runtime");
  const demoSeedRoot = path.join("/private", "tmp", "vision", "demo-seed");
  const config = packageConfig(runtimeRoot, { demoSeedRoot });
  assert.equal(config.extends, "./electron-builder-demo.json");
  assert.deepEqual(config.extraResources, [
    { from: runtimeRoot, to: "native-runtime" },
    { from: demoSeedRoot, to: "demo-seed" },
  ]);

  const { extends: configPath, ...overrides } = config;
  const effective = await getConfig(
    path.resolve(__dirname, ".."),
    configPath,
    overrides,
  );
  assert.equal(effective.appId, "com.vaultvoyager.vision-demo");
  assert.equal(effective.productName, "Vision Demo");
  assert.equal(effective.directories.output, "dist-demo");
  assert.deepEqual(
    effective.extraResources.map(({ to }) => to),
    ["i18n", "resources", "native-runtime", "demo-seed"],
  );
  assert.equal(
    effective.extraResources.some(({ from }) => from === "resources"),
    false,
  );
});
