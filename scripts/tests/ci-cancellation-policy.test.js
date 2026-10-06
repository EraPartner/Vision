"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { evaluateCancellation } = require("../ci-cancellation-policy.js");

const eventHeadSha = "a".repeat(40);
const newerHeadSha = "b".repeat(40);

function workflowJob(workflow, name) {
  const block = workflow.match(
    new RegExp(
      `(?:^|\\n)  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`,
    ),
  )?.[1];
  assert.ok(block, `${name} job block must be present`);
  return block;
}

test("passes without consulting GitHub when no dependency was cancelled", () => {
  let called = false;
  const verdict = evaluateCancellation({
    eventName: "pull_request",
    results: '["success","skipped"]',
    eventHeadSha,
    loadLiveHead: () => {
      called = true;
      return newerHeadSha;
    },
  });
  assert.equal(verdict.tolerated, false);
  assert.equal(called, false);
});

test("fails before cancellation tolerance when any dependency failed", () => {
  assert.throws(
    () =>
      evaluateCancellation({
        eventName: "pull_request",
        results: '["failure","cancelled"]',
        eventHeadSha,
        loadLiveHead: () => newerHeadSha,
      }),
    /dependency failed/,
  );
});

test("rejects cancellation on push runs", () => {
  assert.throws(
    () =>
      evaluateCancellation({
        eventName: "push",
        results: '["cancelled"]',
        eventHeadSha,
        loadLiveHead: () => newerHeadSha,
      }),
    /not routine for 'push'/,
  );
});

test("tolerates a cancelled PR run only after its live head changed", () => {
  const verdict = evaluateCancellation({
    eventName: "pull_request",
    results: '["success","cancelled"]',
    eventHeadSha,
    loadLiveHead: () => newerHeadSha,
  });
  assert.equal(verdict.tolerated, true);
  assert.match(verdict.reason, /superseded/);
});

test("rejects cancellation on the current live PR head", () => {
  assert.throws(
    () =>
      evaluateCancellation({
        eventName: "pull_request",
        results: '["cancelled"]',
        eventHeadSha,
        loadLiveHead: () => eventHeadSha,
      }),
    /current PR head/,
  );
});

test("fails closed when the live-head API lookup fails", () => {
  assert.throws(
    () =>
      evaluateCancellation({
        eventName: "pull_request",
        results: '["cancelled"]',
        eventHeadSha,
        loadLiveHead: () => {
          throw new Error("API unavailable");
        },
      }),
    /Unable to read.*API unavailable/,
  );
});

test("fails closed when cancellation event identity is incomplete", () => {
  assert.throws(
    () =>
      evaluateCancellation({
        eventName: "pull_request",
        results: '["cancelled"]',
        eventHeadSha: "",
        loadLiveHead: () => newerHeadSha,
      }),
    /event head SHA is missing/,
  );
});

test("both workflow aggregation gates call the shared policy with read-only PR access", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../../.github/workflows/ci.yml"),
    "utf8",
  );
  const qualityGate = workflowJob(workflow, "quality-gate");
  const ciComplete = workflowJob(workflow, "ci-complete");
  for (const gate of [qualityGate, ciComplete]) {
    assert.match(gate, /pull-requests: read/);
    assert.match(gate, /node scripts\/ci-cancellation-policy\.js/);
    assert.match(gate, /EVENT_PR_HEAD_SHA:/);
    assert.match(gate, /PR_NUMBER:/);
  }
});

test("CI Complete requires the fail-closed branch-protection verifier", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../../.github/workflows/ci.yml"),
    "utf8",
  );
  const verifier = workflowJob(workflow, "verify-branch-protection");
  const ciComplete = workflowJob(workflow, "ci-complete");

  assert.match(verifier, /Could not read branch rules[\s\S]*Failing closed/);
  assert.doesNotMatch(
    verifier,
    /Could not read branch rules[\s\S]{0,300}exit 0/,
  );

  assert.match(ciComplete, /verify-branch-protection/);
  assert.match(
    ciComplete,
    /BRANCH_PROTECTION_RESULT: \$\{\{ needs\.verify-branch-protection\.result \}\}/,
  );
  assert.match(
    ciComplete,
    /require verify-branch-protection "\$BRANCH_PROTECTION_RESULT"/,
  );
});

test("CI Complete requires native production and filesystem security gates", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../../.github/workflows/ci.yml"),
    "utf8",
  );
  const ciComplete = workflowJob(workflow, "ci-complete");

  assert.match(
    ciComplete,
    /NATIVE_RUNTIME_RESULT: \$\{\{ needs\.native-runtime-verify\.result \}\}/,
  );
  assert.match(
    ciComplete,
    /require native-runtime-verify "\$NATIVE_RUNTIME_RESULT"/,
  );
  assert.match(ciComplete, /require trivy-scan "\$TRIVY_SCAN_RESULT"/);
});

test("jobs downstream of the PR-only Dependency Review still run on pushes", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../../.github/workflows/ci.yml"),
    "utf8",
  );
  // A job condition without a status function gets an implicit success(),
  // which is false once any transitive dependency was skipped. Dependency
  // Review is skipped outside pull requests, so such a job never runs on a
  // push to main, and CI Complete then fails on its required result.
  assert.match(
    workflowJob(workflow, "dependency-review"),
    /\n    if: github\.event_name == 'pull_request'\n/,
  );
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  const names = [...jobs.matchAll(/\n  ([a-z][a-z0-9-]*):\n/g)].map(
    (match) => match[1],
  );
  const needsOf = (name) =>
    workflowJob(workflow, name)
      .match(/\n    needs:([\s\S]*?)(?=\n    [a-z-]+:)/)?.[1]
      ?.match(/[a-z][a-z0-9-]*/g) ?? [];
  const conditionOf = (name) =>
    workflowJob(workflow, name).match(/\n    if: (.+)/)?.[1] ?? "";

  const downstream = new Set(["dependency-review"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const name of names) {
      if (
        !downstream.has(name) &&
        needsOf(name).some((need) => downstream.has(need))
      ) {
        downstream.add(name);
        grew = true;
      }
    }
  }
  downstream.delete("dependency-review");

  const gated = [
    "trivy-scan",
    "native-runtime-verify",
    "test-live-api-contracts",
  ];
  for (const name of [...gated, "quality-gate", "ci-complete"]) {
    assert.ok(downstream.has(name), `${name} must depend on dependency-review`);
  }
  for (const name of downstream) {
    assert.match(
      conditionOf(name),
      /always\(\)|!cancelled\(\)/,
      `${name} needs an explicit status function in its if: condition`,
    );
  }
  for (const name of gated) {
    assert.match(
      conditionOf(name),
      /^\$\{\{ !cancelled\(\) && needs\.quality-gate\.result == 'success' && /,
      `${name} must still wait for a passing Quality Gate`,
    );
  }
});
