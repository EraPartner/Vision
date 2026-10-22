/** Adversarial checks for the workflow admission policy. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkInstallPolicy,
  checkLockfile,
  checkRepository,
  checkWorkflow,
  discoverActions,
} from "../check-workflow-supply-chain.ts";

const sha = "a".repeat(40);

test("a checkout without the credential policy fails", () => {
  const workflow = `steps:\n  - uses: actions/checkout@${sha}\n`;
  assert.match(checkWorkflow(workflow, "x").join(" "), /persisted credentials/);
});

test("a mutable action ref fails", () => {
  assert.match(
    checkWorkflow("- uses: actions/checkout@v4", "x").join(" "),
    /full SHA/,
  );
});

test("a dynamic tool download fails", () => {
  assert.match(checkWorkflow("run: bunx tsc", "x").join(" "), /bunx/);
});

test("an external checkout requires an immutable ref", () => {
  const workflow =
    `steps:\n  - uses: actions/checkout@${sha}\n    with:\n      repository: example/shared-tooling\n` +
    "      ref: main\n      persist-credentials: false\n";
  assert.match(checkWorkflow(workflow, "x").join(" "), /full SHA ref/);
});

test("a pinned checkout without credentials passes", () => {
  const workflow = `steps:\n  - uses: actions/checkout@${sha}\n    with:\n      persist-credentials: false\n`;
  assert.deepEqual(checkWorkflow(workflow, "x"), []);
});

test("checkout env cannot pose as a with input", () => {
  const workflow = `steps:\n  - uses: actions/checkout@${sha}\n    env:\n      persist-credentials: false\n`;
  assert.match(checkWorkflow(workflow, "x").join(" "), /persisted credentials/);
});

test("discovers .yaml alternates", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "vision-workflow-policy-"),
  );
  fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, ".github/actions/example"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github/workflows/check.yaml"),
    "name: Check\n",
  );
  fs.writeFileSync(
    path.join(root, ".github/actions/example/action.yaml"),
    "name: Example\n",
  );
  assert.deepEqual(
    new Set(discoverActions(root).map((file) => path.basename(file))),
    new Set(["check.yaml", "action.yaml"]),
  );
});

test("the repository's own workflows satisfy the policy", () => {
  assert.deepEqual(
    checkRepository(path.join(import.meta.dirname, "..", "..")),
    [],
  );
});

const integrity = `sha512-${"A".repeat(86)}==`;
const lock = (packages: string) =>
  `{\n  "lockfileVersion": 1,\n  "packages": {\n${packages}\n  },\n}\n`;

test("registry, workspace and allowlisted tarball entries pass", () => {
  const text = lock(
    `    "zod": ["zod@4.6.7", "", {}, "${integrity}"],\n` +
      `    "@vision/types": ["@vision/types@workspace:packages/types"],\n` +
      `    "xlsx": ["xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz", {}, "${integrity}"],`,
  );
  assert.deepEqual(checkLockfile(text, "bun.lock"), []);
});

test("git, other tarball and custom-registry entries fail", () => {
  const text = lock(
    `    "a": ["a@github:evil/a#abc", {}, "${integrity}"],\n` +
      `    "b": ["b@https://example.com/b.tgz", {}, "${integrity}"],\n` +
      `    "c": ["c@1.0.0", "https://registry.example.com/", {}, "${integrity}"],`,
  );
  const errors = checkLockfile(text, "bun.lock");
  assert.equal(errors.length, 3);
  assert.match(errors.join(" "), /outside the npm registry/);
});

test("a registry entry without sha512 integrity fails", () => {
  const text = lock(`    "zod": ["zod@4.6.7", "", {}, "sha1-abc"],`);
  assert.match(checkLockfile(text, "bun.lock").join(" "), /sha512/);
});

test("install policy needs empty trustedDependencies and a 7-day release age", () => {
  const bunfig = "[install]\nminimumReleaseAge = 604800\n";
  assert.deepEqual(
    checkInstallPolicy('{"trustedDependencies": []}', bunfig, "."),
    [],
  );
  assert.match(
    checkInstallPolicy("{}", bunfig, ".").join(" "),
    /trustedDependencies/,
  );
  assert.match(
    checkInstallPolicy('{"trustedDependencies": ["esbuild"]}', bunfig, ".").join(
      " ",
    ),
    /trustedDependencies/,
  );
  assert.match(
    checkInstallPolicy(
      '{"trustedDependencies": []}',
      "[install]\nminimumReleaseAge = 3600\n",
      ".",
    ).join(" "),
    /minimumReleaseAge/,
  );
  assert.match(
    checkInstallPolicy('{"trustedDependencies": []}', undefined, ".").join(" "),
    /minimumReleaseAge/,
  );
});
