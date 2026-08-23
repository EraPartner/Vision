# Vision: deliver one coherent TODO batch

Use this prompt in a Codex cloud task opened on a clean, published Vision revision. The repository
skill contains the durable workflow; this prompt supplies the goal and publication authorization.
Use **High** reasoning effort for normal batches. Use **xhigh** only when the selected work must be a
single high-risk or architectural item; the extra latency is usually not useful for routine batches.

---

/goal Deliver one coherent batch of current Vision TODO findings as one reviewed pull request.

Use `$implement-todo-batch`. Recover an existing batch in this task if present; otherwise use
parallel read-only scouts to select two to four compatible, cloud-verifiable findings from
`TODO.md`'s `## Findings`. Keep a high-risk or unexpectedly large item alone.

Before selection, verify through the connected GitHub integration that the latest required
`CI Complete` result on `main` is green and that native squash auto-merge is permitted by the active
repository rules. If baseline CI is red, take only a finding that directly repairs it as a one-item
batch; otherwise stop with the failing gate instead of creating an unrelated unmergeable PR.

Use isolated implementation workers only for disjoint ownership; otherwise implement sequentially.
Integrate the complete batch, run combined validation, obtain an independent read-only review,
address valid findings, and check only the completed TODO boxes without dates or stamps.

This prompt explicitly authorizes the platform-managed **Open pull request** action for this one
batch, creation of a non-draft PR, and the connected GitHub integration's native squash auto-merge
request for that exact PR. Read the PR back and confirm auto-merge is queued. Keep the branch current
and repair failures introduced by the batch until `CI Complete` and every review, code-quality, and
code-scanning rule pass. Re-enable auto-merge if an update clears it. If native auto-merge is not
available, the integration may merge only after every gate passes. Never push directly to `main`,
bypass a check, configure Git credentials, use LockBox or `git-agent`, or begin another batch.

After a verified merge, report `NEXT_BATCH_SESSION: START_FRESH_CLOUD_TASK`; do not create or begin
that next task yourself. If auto-merge is queued but not finished, report
`NEXT_BATCH_SESSION: WAIT_FOR_AUTO_MERGE`; do not start the next batch until `main` contains this
merge. If queuing or publication is unavailable, report `NEXT_BATCH_SESSION: BLOCKED` and the exact
blocker.
