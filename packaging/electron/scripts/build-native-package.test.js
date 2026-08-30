"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  packageConfig,
  packageResources,
  parseArgs,
} = require("./build-native-package");

test("native package builder accepts only the isolated directory mode flag", () => {
  assert.deepEqual(parseArgs([]), { directoryOnly: false });
  assert.deepEqual(parseArgs(["--dir"]), { directoryOnly: true });
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
