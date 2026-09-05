"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { evaluateCancellation } = require("../ci-cancellation-policy.js");

const eventHeadSha = "a".repeat(40);
const newerHeadSha = "b".repeat(40);

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
  const qualityGate = workflow.match(
    /  quality-gate:\n([\s\S]*?)\n  # ─+\n  # Build Docker image/,
  )?.[1];
  const ciComplete = workflow.match(/  ci-complete:\n([\s\S]*?)$/)?.[1];
  for (const gate of [qualityGate, ciComplete]) {
    assert.ok(gate, "gate block must be present");
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
  const verifier = workflow.match(
    /  verify-branch-protection:\n([\s\S]*?)\n  # ─+\n  # Compose sync/,
  )?.[1];
  const ciComplete = workflow.match(/  ci-complete:\n([\s\S]*?)$/)?.[1];

  assert.ok(verifier, "branch-protection verifier block must be present");
  assert.match(verifier, /Could not read branch rules[\s\S]*Failing closed/);
  assert.doesNotMatch(
    verifier,
    /Could not read branch rules[\s\S]{0,300}exit 0/,
  );

  assert.ok(ciComplete, "CI Complete block must be present");
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
