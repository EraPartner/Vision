import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { appRoot } from "../paths";
import {
  defaultNativePayloadRoot,
  resolveNativePayloadRoot,
} from "./resolve-native-payload";

test("native smoke defaults to the prepared source payload", () => {
  assert.equal(resolveNativePayloadRoot(undefined), defaultNativePayloadRoot);
  assert.equal(defaultNativePayloadRoot, path.join(appRoot, "native-runtime"));
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
