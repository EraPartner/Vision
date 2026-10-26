import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import test from "node:test";

const checker = path.resolve(
  import.meta.dirname,
  "../check-test-only-exports.ts",
);

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-test-exports-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "tests"));
  return root;
}

function write(root: string, relativePath: string, contents: string): void {
  fs.writeFileSync(path.join(root, relativePath), contents);
}

function check(root: string): SpawnSyncReturns<string> {
  return spawnSync("bun", ["--no-env-file", checker, "--backend-root", root], {
    encoding: "utf8",
  });
}

void test("rejects an unmarked named export imported only by a test", () => {
  const root = fixture();
  write(root, "src/helper.js", "export function seam() {}\n");
  write(
    root,
    "tests/helper.test.js",
    "import { seam } from '../src/helper.js';\nvoid seam;\n",
  );
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /seam -> __seam/);
});

void test("ignores type-only re-exports used only by typed tests", () => {
  const root = fixture();
  write(
    root,
    "src/helper.ts",
    "interface Row { id: string }\ntype Alias = Row;\nexport type { Row };\nexport { type Alias };\n",
  );
  write(
    root,
    "tests/helper.test.ts",
    "import type { Row, Alias } from '../src/helper.ts';\nconst row: Row | Alias = { id: '1' };\nvoid row;\n",
  );
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

void test("recognizes dynamic test imports and accepts the __ marker", () => {
  const root = fixture();
  write(
    root,
    "src/helper.js",
    "function seam() {}\nexport { seam as __seam };\n",
  );
  write(
    root,
    "tests/helper.test.js",
    "const { __seam } = await import('../src/helper.js');\nvoid __seam;\n",
  );
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

void test("treats a production namespace import as a runtime surface", () => {
  const root = fixture();
  write(root, "src/helper.js", "export function seam() {}\n");
  write(
    root,
    "src/main.ts",
    "import * as helper from './helper.js';\nexport default helper;\n",
  );
  write(
    root,
    "tests/helper.test.js",
    "import { seam } from '../src/helper.js';\nvoid seam;\n",
  );
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
});

void test("still marks the named export when its binding is in a default object", () => {
  const root = fixture();
  write(
    root,
    "src/helper.js",
    "export function seam() {}\nexport default { seam };\n",
  );
  write(
    root,
    "tests/helper.test.js",
    "import { seam } from '../src/helper.js';\nvoid seam;\n",
  );
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /seam -> __seam/);
});
