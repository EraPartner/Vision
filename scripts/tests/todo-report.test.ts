import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(import.meta.dirname, "..", "todo-report.ts");

/** execFileSync failures carry the child's captured stderr. */
function stderrOf(error: unknown): string {
  assert.ok(
    typeof error === "object" && error !== null && "stderr" in error,
    "expected a failed child process",
  );
  return String(error.stderr);
}

void test("accepts a completed authoritative Findings queue", () => {
  const directory = mkdtempSync(join(tmpdir(), "vision-todo-report-"));
  const todo = join(directory, "TODO.md");
  writeFileSync(
    todo,
    [
      "# TODO",
      "",
      "## Findings",
      "",
      "- [x] **Completed finding** 🔽",
      "  - ↪ _from: Regression fixture_",
      "",
    ].join("\n"),
  );

  const output = execFileSync(process.execPath, [script, "--check", "--file", todo], {
    encoding: "utf8",
  });

  assert.match(output, /OK: 0 open findings/);
});

void test("derives state from Tracking metadata rather than title prose", () => {
  const directory = mkdtempSync(join(tmpdir(), "vision-todo-report-"));
  const todo = join(directory, "TODO.md");
  writeFileSync(
    todo,
    [
      "# TODO",
      "",
      "## Findings",
      "",
      "- [ ] **Label partial-month comparisons clearly** 🔽",
      "  - Tracking: 🔎 verified-present 2026-09-05 (a partial index remains)",
      "  - ↪ _from: Regression fixture_",
      "",
    ].join("\n"),
  );

  const output = execFileSync(process.execPath, [script, "--file", todo], {
    encoding: "utf8",
  });

  assert.match(output, /\[verified\].*partial-month/);
  assert.doesNotMatch(output, /\[partial\]/);
});

void test("rejects open findings without explicit Tracking metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "vision-todo-report-"));
  const todo = join(directory, "TODO.md");
  writeFileSync(
    todo,
    [
      "# TODO",
      "",
      "## Findings",
      "",
      "- [ ] **Untracked finding** 🔽",
      "  - ↪ _from: Regression fixture_",
      "",
    ].join("\n"),
  );

  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "--check", "--file", todo], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error: unknown) => {
      assert.match(stderrOf(error), /needs exactly one 'Tracking:' line/);
      return true;
    },
  );
});

void test("rejects duplicate, conflicting, or unrecognized Tracking metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "vision-todo-report-"));
  const duplicateTodo = join(directory, "duplicate.md");
  const conflictingTodo = join(directory, "conflicting.md");
  const unrecognizedTodo = join(directory, "unrecognized.md");
  const base = (tracking: string[]): string =>
    [
      "# TODO",
      "",
      "## Findings",
      "",
      "- [ ] **Tracked finding** 🔽",
      ...tracking,
      "  - ↪ _from: Regression fixture_",
      "",
    ].join("\n");
  writeFileSync(
    duplicateTodo,
    base([
      "  - Tracking: 🔎 verified-present 2026-09-05",
      "  - Tracking: 🔎 runtime-unverified 2026-09-05",
    ]),
  );
  writeFileSync(
    conflictingTodo,
    base([
      "  - Tracking: 🔎 verified-present 2026-09-05; 🔎 decision-needed 2026-09-05",
    ]),
  );
  writeFileSync(unrecognizedTodo, base(["  - Tracking: waiting for someday"]));

  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "--check", "--file", duplicateTodo], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error: unknown) => {
      assert.match(stderrOf(error), /needs exactly one 'Tracking:' line/);
      return true;
    },
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "--check", "--file", conflictingTodo], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error: unknown) => {
      assert.match(
        stderrOf(error),
        /needs exactly one recognized state marker/,
      );
      return true;
    },
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "--check", "--file", unrecognizedTodo], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error: unknown) => {
      assert.match(
        stderrOf(error),
        /needs exactly one recognized state marker/,
      );
      return true;
    },
  );
});
