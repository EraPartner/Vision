import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { evaluateCancellation } from "../ci-cancellation-policy.ts";

const eventHeadSha = "a".repeat(40);
const newerHeadSha = "b".repeat(40);

function workflowJob(workflow: string, name: string): string {
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

function readCiWorkflow(): string {
  return fs.readFileSync(
    path.join(import.meta.dirname, "../../.github/workflows/ci.yml"),
    "utf8",
  );
}

test("CI Complete calls the shared policy with read-only PR access", () => {
  const ciComplete = workflowJob(readCiWorkflow(), "ci-complete");
  assert.match(ciComplete, /pull-requests: read/);
  assert.match(ciComplete, /bun scripts\/ci-cancellation-policy\.ts/);
  assert.match(ciComplete, /EVENT_PR_HEAD_SHA:/);
  assert.match(ciComplete, /PR_NUMBER:/);
});

test("CI Complete requires the fail-closed branch-protection verifier", () => {
  const workflow = readCiWorkflow();
  const repoChecks = workflowJob(workflow, "repo-checks");
  const ciComplete = workflowJob(workflow, "ci-complete");

  assert.match(repoChecks, /Could not read branch rules[\s\S]*Failing closed/);
  assert.doesNotMatch(
    repoChecks,
    /Could not read branch rules[\s\S]{0,300}exit 0/,
  );
  assert.match(
    ciComplete,
    /REPO_CHECKS_RESULT: \$\{\{ needs\.repo-checks\.result \}\}/,
  );
  assert.match(ciComplete, /require repo-checks "\$REPO_CHECKS_RESULT"/);
});

test("CI Complete requires every code tier, native production checks included", () => {
  const workflow = readCiWorkflow();
  const ciComplete = workflowJob(workflow, "ci-complete");
  for (const [job, variable] of [
    ["lint", "LINT_RESULT"],
    ["typecheck", "TYPECHECK_RESULT"],
    ["test-frontend", "TEST_FRONTEND_RESULT"],
    ["test-backend", "TEST_BACKEND_RESULT"],
  ] as const) {
    assert.match(
      ciComplete,
      new RegExp(`${variable}: \\$\\{\\{ needs\\.${job}\\.result \\}\\}`),
    );
    assert.match(ciComplete, new RegExp(`require ${job} "\\$${variable}"`));
  }
  const backend = workflowJob(workflow, "test-backend");
  assert.match(backend, /with-native-stack\.sh curl -fsS http:\/\/127\.0\.0\.1:3002\/health/);
  assert.match(backend, /with-native-stack\.sh bun run vitest run src\/test\/live-contracts/);
});

test("PR-only checks never stop jobs from running on pushes", () => {
  const workflow = readCiWorkflow();
  // A job-level condition on the event (or a needs edge to such a job) would
  // skip on a push to main, and CI Complete then fails on its required result.
  // Dependency Review is PR-only, so it is a step-level condition instead.
  assert.match(
    workflowJob(workflow, "repo-checks"),
    /if: github\.event_name == 'pull_request'\n        uses: actions\/dependency-review-action@/,
  );
  const jobs = workflow.slice(workflow.indexOf("\njobs:\n"));
  const names = [...jobs.matchAll(/\n  ([a-z][a-z0-9-]*):\n/g)].map(
    (match) => match[1] ?? "",
  );
  for (const name of names) {
    assert.doesNotMatch(
      workflowJob(workflow, name),
      /\n    if: [^\n]*event_name/,
      `${name} must not be gated on the event at job level`,
    );
  }
  assert.match(workflowJob(workflow, "ci-complete"), /\n    if: always\(\)\n/);
});
