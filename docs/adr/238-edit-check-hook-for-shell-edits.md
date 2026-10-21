---
title: "ADR-238: Edit-check hook for shell edits"
type: adr
status: accepted
date: 2026-10-21
tags: [adr, claude-code, agents, hooks, typescript, eslint, dependency-cruiser, adr-227]
description: "Accepted on 2026-10-21. The Claude Code edit-check hook from ADR-227 also runs after Bash calls. A PreToolUse hook records each Bash call's start time; after the call, the hook checks the TypeScript and JavaScript files git reports as modified or untracked whose mtime is at or after that start. Calls that touch more than 25 such files are skipped. AGENTS.md asks agents to make code changes with Edit or Write. No CI job or CI time is added."
aliases: [adr-238, bash edit hook, shell edit checks]
related_code:
  [".claude/settings.json", ".claude/hooks/check-edit.ts", "AGENTS.md"]
---

# ADR-238: Edit-check hook for shell edits

## Status

Accepted on 2026-10-21. Amends [[docs/adr/227-claude-code-static-analysis-aids|ADR-227]].

## Date

2026-10-21

## Context

The edit-check hook from ADR-227 runs the owning `tsc` project, ESLint and dependency-cruiser
after `Edit`, `MultiEdit` and `Write`, because those tools name the file they changed. Agents
also change code with `sed -i`, heredocs, scripts and formatters through `Bash`. Those edits got
no checks, so a type error from a `sed` substitution surfaced only when the agent ran
`bun run typecheck` itself or in CI. Tor's constraint from
[[docs/adr/221-proportional-ci|ADR-221]] still holds: no CI job and no CI time.

## Decision

- **Start mark.** A synchronous `PreToolUse` hook on `Bash` runs `.claude/hooks/check-edit.ts`,
  which writes the call's start time to `node_modules/.cache/claude-edit-check/bash-start/`,
  keyed by `tool_use_id`. Marks older than six hours are removed.
- **Changed files.** `PostToolUse` and `PostToolUseFailure` on `Bash` run the same script with
  `asyncRewake`. It reads and deletes the mark, lists modified, added and untracked files with
  `git status --porcelain -z --untracked-files=all`, and keeps the TypeScript and JavaScript files
  whose mtime is at or after the start. Files that were already dirty but not touched by the call
  are not rechecked. The skip list from ADR-227 (generated files, locales, build output) applies.
- **Same checks, batched.** The files run through the ADR-227 mapping: one `tsc` run per owning
  project, one ESLint run per workspace with all its files, one dependency-cruiser run with all
  covered files.
- **Bulk changes skipped.** A call that changes more than 25 checkable files (a checkout, rebase or
  generator run) is not checked; it would take minutes and the agent runs the full checks after
  such steps anyway.
- **AGENTS.md rule.** Agents make code changes with `Edit` or `Write`. The hook reports those by
  file name; the shell path is a safety net for the edits that still go through `Bash`.

Git diff alone was rejected: without a start mark, every `Bash` call, including `ls`, would
recheck every dirty file and repeat old reports.

## Consequences

- A type, lint or boundary error from a shell edit wakes Claude like one from `Edit`. Verified in
  a cloud container on 2026-10-21 with a headless Claude Code run of this settings file: a
  `sed -i` that inserted `const nestedSedProbe: number = "nested";` into
  `apps/node-backend/src/main.ts` produced the report
  `main.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.` The
  `PostToolUseFailure` path was checked only by feeding the script its hook input.
- Every `Bash` call pays the start mark, measured at 23 to 28 ms, plus a background `git status`
  of about 50 ms when nothing changed. A backend edit takes about 7 s warm and 28 s cold to check;
  a frontend file about 37 s cold. The command itself is not delayed beyond the start mark.
- A `Bash` call that runs alongside an `Edit` of the same file can check that file twice.
- Deleted files are not checked in place; the next check of their project reports broken imports.
- Hooks load when a session starts, so sessions already running keep the ADR-227 behaviour.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/227-claude-code-static-analysis-aids|ADR-227]]
- [[docs/adr/221-proportional-ci|ADR-221]]
- [[docs/guides/devcontainer|Agent Sandbox Guide]]
