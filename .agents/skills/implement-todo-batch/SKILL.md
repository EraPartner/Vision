---
name: implement-todo-batch
description: Select and deliver a coherent batch of current Vision TODO findings as one cloud pull request. Use for backlog iteration, TODO batches, or orchestrated implementation of multiple findings. Do not use for feature ideas, research-only audits, or host-only macOS work.
---

# Implement a Vision TODO batch

Deliver one reviewable batch, then stop. Invocation of this skill does not itself authorize a pull
request, merge, or other external write; use only the publication actions explicitly authorized by
the current user request.

## Recover the current batch

Inspect the task branch, working diff, existing agent results, checks, and pull-request state before
selecting. If unfinished batch work exists, reconcile it against the actual files and continue only
that batch. Do not replace it after an interruption or rate limit, and do not begin a second batch.
Use the current cloud task and its diff as recovery state; do not create a separate checkpoint
schema or depend on chat prose when files provide stronger evidence.

## Verify the merge path before selection

When repository state is available through the connected GitHub integration, verify the delivery
path before spending implementation work:

- the latest required `CI Complete` result on the default branch is successful;
- GitHub native auto-merge is enabled and squash merge is allowed; and
- the active default-branch rules require the branch to be current, require `CI Complete`, and have
  no unmet review, code-quality, or code-scanning condition.

If default-branch CI is red, select a TODO finding only when it directly repairs that failure and
keep it as a one-item batch. Otherwise stop and request a dedicated CI-restoration task. Do not
build an unrelated batch that cannot merge. If remote settings cannot be read, record that
auto-merge is unverified rather than promising it will work.

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
validation surface. Every item needs explicit acceptance evidence and must fit one reviewable pull
request.

Keep the batch to one item when it involves security, financial correctness, persistence, a schema
migration, packaging, visual behavior, significant architecture, or scope that expands during
inspection. Do not combine unrelated cleanup, dependency churn, or opportunistic findings.

Select only work that the current environment can verify. Cloud batches exclude the Vision Demo
app, macOS Electron packaging, Apple Container behavior, hardware credentials, real financial
data, unavailable external configuration, and database-sensitive work when its disposable database
checks cannot run. If no suitable batch exists, stop with evidence and recommend the required local
environment.

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

Git history and the merged pull request are the completion record.

## Publish only when authorized

In cloud, use the platform-managed **Open pull request** action rather than terminal Git
publication. Open a non-draft pull request so it is eligible for native auto-merge. The
pull-request description includes:

- every exact selected heading and the reason for batching them;
- implementation and changed paths per item;
- passed, failed, skipped, and unverified checks;
- review findings and dispositions;
- residual risks; and
- confirmation that no unselected finding was included.

When the user authorized merge, immediately ask the connected integration to enable GitHub native
auto-merge with the squash method for this exact pull request. Read the pull request back and
confirm that auto-merge is actually queued; a request, a green local check, or an agent statement is
not proof.

Keep the pull request mergeable while it is queued:

- monitor the required `CI Complete` check and every ruleset condition;
- diagnose and fix failures introduced by the batch, then update the same pull-request branch;
- use the connected integration to update the branch when the strict ruleset reports it behind;
- re-check auto-merge after every update and re-enable it if GitHub cleared the request; and
- do not absorb a failure that was already present on the default branch unless repairing it was
  the selected one-item batch.

If native auto-merge is unavailable, remain in the task and merge through the connected integration
after all required checks and approvals pass and no blocking review, code-quality, or code-scanning
condition remains. Never bypass protections or fall back to shell credentials or pushes.

If publication is unavailable, leave the reviewed diff ready and identify the single missing
platform action. After merge, verify that `main` contains the implementation and checked headings.
Do not select the next batch.

Finish with exactly one route:

- verified merged: `NEXT_BATCH_SESSION: START_FRESH_CLOUD_TASK`;
- native auto-merge verified queued but not yet merged: `NEXT_BATCH_SESSION: WAIT_FOR_AUTO_MERGE`;
- auto-merge or publication unavailable: `NEXT_BATCH_SESSION: BLOCKED` plus the exact missing
  platform capability or failing gate.
