"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  defaultNativePayloadRoot,
  resolveNativePayloadRoot,
} = require("./resolve-native-payload");

test("native smoke defaults to the prepared source payload", () => {
  assert.equal(resolveNativePayloadRoot(undefined), defaultNativePayloadRoot);
});

test("native smoke accepts an absolute packaged payload path", () => {
  const packaged = path.join(
    path.parse(process.cwd()).root,
    "Applications",
    "Vision.app",
  );
  assert.equal(resolveNativePayloadRoot(packaged), path.resolve(packaged));
});

test("native smoke rejects empty and relative payload overrides", () => {
  assert.throws(() => resolveNativePayloadRoot(""), /must be a non-empty path/);
  assert.throws(
    () => resolveNativePayloadRoot("packaging/electron/native-runtime"),
    /must be an absolute path/,
  );
});
