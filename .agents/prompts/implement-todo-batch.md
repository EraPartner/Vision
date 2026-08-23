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

Use isolated implementation workers only for disjoint ownership; otherwise implement sequentially.
Integrate the complete batch, run combined validation, obtain an independent read-only review,
address valid findings, and check only the completed TODO boxes without dates or stamps.

This prompt explicitly authorizes the platform-managed **Open pull request** action for this one
batch. It also authorizes the connected GitHub integration to merge that pull request only after
all required checks and approvals pass and no blocking review remains. Never push directly to
`main`, bypass a check, configure Git credentials, use LockBox or `git-agent`, or begin another
batch.

Stop after this batch is merged or after reporting the exact unavailable platform action. The next
batch belongs in a fresh cloud task.
