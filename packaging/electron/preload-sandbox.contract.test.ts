import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The renderer runs with sandbox: true, where the preload's require() resolves
// only "electron". This reads the compiled preload that sits next to this test
// in out/ and fails if a value import slipped in where a type import belongs.
void test("the compiled sandboxed preload requires only electron", () => {
  const compiled = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
  const required = [...compiled.matchAll(/\brequire\s*\(([^)]*)\)/g)].map(
    (match) => match[1]?.trim(),
  );
  assert.deepEqual(required, ['"electron"']);
  assert.doesNotMatch(compiled, /\bimport\s*\(/);
});
