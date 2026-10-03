---
name: implement-todo-batch
description: Select and deliver a coherent batch of current Vision TODO findings as one reviewed local diff. Use for backlog iteration, TODO batches, or orchestrated implementation of multiple findings. Do not use for feature ideas, research-only audits, or host-only macOS work.
---

# Implement a Vision TODO batch

Deliver one reviewable batch, then stop. Invocation of this skill does not itself authorize a pull
request, merge, or other external write; use only the publication actions explicitly authorized by
the current user request.

## Recover the current batch

Inspect the task branch, working diff, existing agent results, checks, and pull-request state before
selecting. If unfinished batch work exists, reconcile it against the actual files and continue only
that batch. Do not replace it after an interruption or rate limit, and do not begin a second batch.
Use the current task and its diff as recovery state; do not create a separate checkpoint
schema or depend on chat prose when files provide stronger evidence.

## Triage with read-only scouts

Read `TODO.md`'s status rules, usage guidance, binding constraints, and `## Findings`. Revalidate
TODO prose against current code.

When delegation is available, assign up to three read-only scouts distinct domains or subsystems.
Each scout returns at most three candidates with:

- the exact unchecked heading and current remaining scope;
- evidence that the finding is still present;
- impact and size;
- likely files and tests;
- environment requirements; and
- overlap with other candidates.

Scouts reject completed, stale, refuted, research-only, feature-work, external-state, and unclear
product-decision entries. They do not edit files. The main agent waits for their summaries and owns
the final selection.

## Form one coherent batch

Normally select two to four small or medium findings that share a subsystem, workflow, or
validation surface. Every item needs explicit acceptance evidence and must fit one reviewable diff.

Keep the batch to one item when it involves security, financial correctness, persistence, a schema
migration, packaging, visual behavior, significant architecture, or scope that expands during
inspection. Do not combine unrelated cleanup, dependency churn, or opportunistic findings.

Select only work that the current environment can verify. Use synthetic data and disposable
databases. Defer work that requires unavailable host tools or external configuration. If no suitable
batch exists, stop with evidence and state the environment needed.

State the fixed batch, why its items belong together, acceptance criteria, expected ownership, and
validation plan before editing. Never add another item after selection.

## Implement without write conflicts

Use worker subagents only when the platform provides isolated worktrees or branches and ownership
is disjoint. Give each worker its exact finding, acceptance criteria, owned files or module,
relevant guidance, and required tests. Tell workers they are not alone in the codebase, must
preserve others' work, and must not edit `TODO.md` or another worker's files.

If workers share one checkout, implementation overlaps, or isolation is uncertain, keep writes in
the main agent and implement sequentially. Parallelize read-heavy exploration, test execution, log
analysis, and review instead.

For every item:

- inspect callers, contracts, documentation, and existing tests before editing;
- implement the smallest complete fix;
- add focused regression evidence when practical;
- avoid adjacent refactors and dependency changes; and
- record changed paths, checks, assumptions, and residual risk for integration.

## Integrate and validate the batch

Review the combined diff against every selected heading. Resolve interactions deliberately; do not
mechanically accept worker output. Check for duplicate fixes, inconsistent APIs, scope expansion,
missing documentation, and regression gaps.

Run targeted evidence for every item plus combined validation proportional to the highest-risk
change. Separate passed, failed, skipped, blocked, and unverified checks. An unavailable service is
not an implementation failure, but it cannot satisfy required acceptance evidence.

After the diff is stable, evaluate documentation impact through `update-vision-docs`. Then use one
independent read-only reviewer for the full batch when delegation is available. Give it the exact
headings, acceptance criteria, and combined diff. Ask it to audit correctness, scope, interactions,
tests, documentation, security implications, and missing validation. Address valid findings and
record dispositions; the main agent retains final responsibility.

## Close only completed TODO entries

After implementation and validation, change only the selected completed headings from `- [ ]` to
`- [x]`. Do not add dates, commit SHAs, pull-request numbers, or other stamps. Keep an item open and
describe its remaining scope when any named sub-case is incomplete.

Run `bun run todo:check` after updating the selected headings and resolve any batch-introduced
queue validation failure before reporting completion. Preserve unrelated queue edits.

The reviewed diff and validation results are the local completion record.

## Local publication handoff

In a local editing session, leave the reviewed worktree diff for the LockBox `git-agent`.
Do not stage, commit, sign, push, or configure Git credentials here. The handoff includes:

- every exact selected heading and the reason for batching them;
- implementation and changed paths per item;
- passed, failed, skipped, and unverified checks;
- review findings and dispositions;
- residual risks; and
- confirmation that no unselected finding was included.

Finish with exactly one route:

- reviewed implementation ready: `NEXT_BATCH_SESSION: HANDOFF_TO_GIT_AGENT`;
- a concrete implementation, selection, environment, setup, or validation blocker:
  `NEXT_BATCH_SESSION: BLOCKED` plus the exact blocker.

Do not select the next batch in this session.
