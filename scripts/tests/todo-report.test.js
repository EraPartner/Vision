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
