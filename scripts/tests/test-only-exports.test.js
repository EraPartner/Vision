const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const checker = path.resolve(__dirname, "../check-test-only-exports.js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vision-test-exports-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "tests"));
  return root;
}

function write(root, relativePath, contents) {
  fs.writeFileSync(path.join(root, relativePath), contents);
}

function check(root) {
  return spawnSync(process.execPath, [checker, "--backend-root", root], {
    encoding: "utf8",
  });
}

test("rejects an unmarked named export imported only by a test", () => {
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

test("recognizes dynamic test imports and accepts the __ marker", () => {
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

test("treats a production namespace import as a runtime surface", () => {
  const root = fixture();
  write(root, "src/helper.js", "export function seam() {}\n");
  write(
    root,
    "src/main.js",
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

test("still marks the named export when its binding is in a default object", () => {
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
