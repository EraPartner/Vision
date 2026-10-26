/**
 * Expected rule names come from @commitlint/cli 21.2.4 with
 * config-conventional and defaultIgnores: false, run on the same messages
 * before the dependency was removed (ADR-245).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { lintMessage, stripComments } from "../commitlint.ts";

const rules = (message: string) =>
  lintMessage(message)
    .errors.map((error) => /\[([a-z-]+)\]$/.exec(error)?.[1])
    .sort((left, right) => {
      const [a, b] = [left ?? "", right ?? ""];
      if (a < b) return -1;
      return a > b ? 1 : 0;
    });

const cases: [string, string[]][] = [
  ["feat(frontend): add a chart", []],
  ["fix!: drop the old reader", []],
  ["feat: `Eslint` config", []],
  ["docs: iOS thing", []],
  ["fix: 1st thing", []],
  ["feat: wait...", []],
  ["Feat: x", ["type-case", "type-enum"]],
  ["feat: X", ["subject-case"]],
  ["feat: Élan", ["subject-case"]],
  ["feat: x.", ["subject-full-stop"]],
  ["feat:x", ["subject-empty", "type-empty"]],
  ["wip: x", ["type-enum"]],
  ["Merge branch 'main'", ["subject-empty", "type-empty"]],
  ["Add things.", ["subject-empty", "subject-full-stop", "type-empty"]],
  [" feat: x", ["header-trim", "subject-empty", "type-empty"]],
  ["feat: x ", ["header-trim"]],
  [`feat: ${"a".repeat(95)}`, ["header-max-length"]],
  [`feat: x\n\n${"a".repeat(101)}`, ["body-max-line-length"]],
  [`feat: x\n\nsee https://example.com/${"a".repeat(120)}`, []],
  [`feat: x\n\nBREAKING CHANGE: ${"b".repeat(120)}`, ["body-max-line-length"]],
];

for (const [message, expected] of cases) {
  void test(`lint ${JSON.stringify(message.slice(0, 40))}`, () => {
    assert.deepEqual(rules(message), expected);
  });
}

void test("a body without a leading blank line only warns", () => {
  const result = lintMessage("feat: x\nbody");
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
});

void test("hook input drops comments and everything below the scissors", () => {
  const raw =
    "feat: x\n\nbody\n# Please enter the commit message\n" +
    "# ------------------------ >8 ------------------------\ndiff --git a b\n";
  assert.equal(stripComments(raw), "feat: x\n\nbody");
});
