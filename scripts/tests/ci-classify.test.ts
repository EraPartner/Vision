import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classify, classifyRange, type Git } from "../ci-classify.ts";

function scriptedGit(outputs: string[]): { git: Git; calls: string[][] } {
  const calls: string[][] = [];
  const git: Git = (...args) => {
    calls.push(args);
    const next = outputs.shift();
    if (next === undefined) throw new Error("unexpected git call");
    return next;
  };
  return { git, calls };
}

test("documentation and instruction Markdown may skip the application pipeline", () => {
  assert.equal(
    classify([
      "docs/guide.md",
      "AGENTS.md",
      ".agents/skills/example/SKILL.md",
      ".codex/prompts/example.md",
    ]),
    false,
  );
});

test("executable, configuration and nested Markdown changes run the full pipeline", () => {
  for (const changed of [
    ".agents/skills/example/run.sh",
    ".codex/agents/reviewer.toml",
    ".codex/scripts/example.sh",
    "apps/frontend/README.md",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(
      classify([".agents/roles/reviewer.md", changed]),
      true,
      changed,
    );
  }
});

test("empty, unresolvable and special-mode diffs fail closed", () => {
  assert.equal(classify([]), true);
  assert.equal(
    classify([".agents/role.md"], new Set([".agents/role.md"])),
    true,
  );
  assert.equal(classifyRange("", "head"), true);
  const failing: Git = () => {
    throw new Error("git failed");
  };
  assert.equal(classifyRange("base", "head", failing), true);
});

test("the agent check cannot be silently skipped by the quality gate", () => {
  const workflow = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", ".github/workflows/ci.yml"),
    "utf8",
  );
  const quality =
    workflow.split("  quality-gate:")[1]?.split("  build-image:")[0] ?? "";
  assert.ok(quality.includes("      - agent-tooling"));
  assert.ok(
    quality.includes("AGENT_TOOLING_RESULT: ${{ needs.agent-tooling.result }}"),
  );
  assert.ok(quality.includes('case "$AGENT_TOOLING_RESULT" in'));
  assert.ok(quality.includes("success|cancelled)"));
  assert.ok(quality.includes("bun scripts/ci-cancellation-policy.ts"));
});

test("NUL delimiters, file modes and disabled rename detection are honoured", () => {
  // A renamed executable must still be included through its old path.
  const renamed = scriptedGit([
    "",
    "",
    "old.sh\0.agents/new.md\0",
    "100755 blob abc\told.sh\0",
    "100644 blob def\t.agents/new.md\0",
  ]);
  assert.equal(classifyRange("base", "head", renamed.git), true);
  assert.deepEqual(renamed.calls[2], [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "base",
    "head",
  ]);
  const newline = scriptedGit([
    "",
    "",
    ".agents/name\nwith newline.md\0",
    "",
    "100644 blob abc\t.agents/name\nwith newline.md\0",
  ]);
  assert.equal(classifyRange("base", "head", newline.git), false);
});
