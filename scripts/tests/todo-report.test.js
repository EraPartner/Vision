"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const script = join(__dirname, "..", "todo-report.py");

test("accepts a completed authoritative Findings queue", () => {
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

  const output = execFileSync("python3", [script, "--check", "--file", todo], {
    encoding: "utf8",
  });

  assert.match(output, /OK: 0 open findings/);
});

test("derives state from Tracking metadata rather than title prose", () => {
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

  const output = execFileSync("python3", [script, "--file", todo], {
    encoding: "utf8",
  });

  assert.match(output, /\[verified\].*partial-month/);
  assert.doesNotMatch(output, /\[partial\]/);
});

test("rejects open findings without explicit Tracking metadata", () => {
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
      execFileSync("python3", [script, "--check", "--file", todo], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error) => {
      assert.match(error.stderr, /needs exactly one 'Tracking:' line/);
      return true;
    },
  );
});

test("rejects duplicate, conflicting, or unrecognized Tracking metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "vision-todo-report-"));
  const duplicateTodo = join(directory, "duplicate.md");
  const conflictingTodo = join(directory, "conflicting.md");
  const unrecognizedTodo = join(directory, "unrecognized.md");
  const base = (tracking) =>
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
      execFileSync("python3", [script, "--check", "--file", duplicateTodo], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error) => {
      assert.match(error.stderr, /needs exactly one 'Tracking:' line/);
      return true;
    },
  );
  assert.throws(
    () =>
      execFileSync("python3", [script, "--check", "--file", conflictingTodo], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error) => {
      assert.match(error.stderr, /needs exactly one recognized state marker/);
      return true;
    },
  );
  assert.throws(
    () =>
      execFileSync("python3", [script, "--check", "--file", unrecognizedTodo], {
        encoding: "utf8",
        stdio: "pipe",
      }),
    (error) => {
      assert.match(error.stderr, /needs exactly one recognized state marker/);
      return true;
    },
  );
});
