# Vision: deliver one coherent TODO batch

Deliver one coherent batch of current Vision TODO findings. Read
`.agents/skills/implement-todo-batch/SKILL.md` in full and follow its recovery, selection,
delegation, validation, independent review, TODO closure, and publication gates. If the client
does not discover skills, load that file explicitly.

Preserve the user's selected model and reasoning effort. Use the available tools to produce the
same evidence and checks. If a required tool is unavailable, report the gap and follow the skill's
recovery rules; do not claim the corresponding gate passed.

Deliver one batch and report the applicable `NEXT_BATCH_SESSION` route from the skill. Do not
start another batch yourself. This prompt does not authorize publication or merge. In a local
editing session, leave the reviewed worktree diff for the LockBox `git-agent`.
