# Vision: deliver one coherent TODO batch

Use this prompt in a Codex cloud task opened on a clean, published Vision revision. The repository
skill contains the durable workflow; this prompt supplies the goal and publication authorization.
Use **High** reasoning effort for normal batches. Use **xhigh** only when the selected work must be a
single high-risk or architectural item; the extra latency is usually not useful for routine batches.

---

/goal Deliver one coherent batch of current Vision TODO findings as one reviewed pull request.

Use `$implement-todo-batch` at `.agents/skills/implement-todo-batch/SKILL.md` as the canonical
workflow. Follow its recovery, selection, delegation, validation, review, TODO closure, and
publication gates. Deliver one batch and report the applicable `NEXT_BATCH_SESSION` route from the
skill; do not start the next task yourself.

This prompt explicitly authorizes the platform-managed **Open pull request** action for this one
batch, creation of a non-draft PR, and the connected GitHub integration's native squash auto-merge
request for that exact PR. If native auto-merge is unavailable, it also authorizes the integration
to merge that PR after every required check and approval passes and no blocking review,
code-quality, or code-scanning condition remains. Verify the resulting state as the skill requires.
