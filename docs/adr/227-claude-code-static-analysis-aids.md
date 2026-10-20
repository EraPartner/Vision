---
title: "ADR-227: Claude Code static-analysis aids"
type: adr
status: accepted
date: 2026-10-20
tags: [adr, claude-code, agents, typescript, eslint, dependency-cruiser, mcp, postgresql, ast-grep]
description: "Accepted on 2026-10-20. The repository's .claude/settings.json registers an asynchronous PostToolUse edit hook (owning tsc project, ESLint, dependency-cruiser; wakes Claude only on errors), a cloud-only SessionStart hook that installs dependencies and warms tsc caches, and the typescript-lsp plugin for local sessions. .mcp.json registers a read-only PostgreSQL MCP server for a local database. ast-grep is a dev dependency behind bun run search:ast. No CI job or CI time is added."
aliases: [adr-227, claude code hooks, edit hook, postgres mcp, ast-grep]
related_code:
  [
    ".claude/settings.json",
    ".claude/hooks/check-edit.ts",
    ".claude/hooks/session-start.sh",
    ".mcp.json",
    "apps/node-backend/scripts/postgres-mcp.ts",
    "package.json",
  ]
---

# ADR-227: Claude Code static-analysis aids

## Status

Accepted on 2026-10-20.

## Date

2026-10-20

## Context

Coding agents write most Vision changes. They learned about type, lint and import-boundary errors
only when they ran `bun run typecheck` or `bun run lint` themselves, or from CI. Cloud sessions
start on a fresh clone without `node_modules`, so the first check also paid for the install.
[[docs/adr/225-static-checks-for-agents|ADR-225]] added the checks; this decision feeds them to
Claude Code while it works. Tor's constraint from [[docs/adr/221-proportional-ci|ADR-221]] still
holds: no CI job and no CI time.

## Decision

Everything is committed in the repository, so every cloud thread and Remote Control session on
Tor's Mac gets it from `main`.

- **Edit hook.** `.claude/hooks/check-edit.ts` runs after `Edit`, `MultiEdit` and `Write` on a
  TypeScript or JavaScript file. In parallel it runs the owning `tsc` project (the same mapping as
  the `typecheck*` scripts, incremental, build info under `node_modules/.cache/claude-edit-check`),
  the workspace ESLint config (frontend, backend `src/`) and dependency-cruiser on that file when
  `lint:deps` covers it. It is registered with `asyncRewake`, so the edit returns at once; a clean
  result is silent, and errors wake Claude with at most 40 lines per tool. Generated files,
  locales and build output are skipped.
- **Session-start hook.** `.claude/hooks/session-start.sh` runs only when `CLAUDE_CODE_REMOTE` is
  `true`. It runs `bun install` (about 23 s on a fresh clone, under 1 s when nothing changed) and
  warms the frontend and backend `tsc` caches in the background. The Kysely and OpenAPI types are
  committed (`schema.generated.ts`, `src/types/generated.ts`), so the hook does not regenerate
  them; `db:codegen` needs a migrated database.
- **Language server.** `enabledPlugins` turns on `typescript-lsp@claude-plugins-official`. It
  works in local sessions (Remote Control on the Mac) once `typescript-language-server` is on
  `PATH`. Claude Code does not start plugin language servers in cloud sessions; this was checked
  in a cloud container (no `LSP` tool, also with `ENABLE_LSP_TOOL=1`). The edit hook covers cloud
  sessions instead.
- **Read-only PostgreSQL MCP.** `.mcp.json` registers `vision-postgres`, a small stdio server in
  `apps/node-backend/scripts/postgres-mcp.ts` with one `query` tool. It connects only when
  `VISION_MCP_DATABASE_URL` is set and only to `localhost`, `127.0.0.1` or `::1`; it never reads
  `DATABASE_URL`. It builds the connection from the URL's parts, so query parameters cannot
  redirect it. Each statement runs alone through the extended query protocol (multi-statement
  text is rejected) inside `BEGIN READ ONLY`, followed by `ROLLBACK`; the session also defaults to
  read-only transactions and a 10 s statement timeout. A read-only role in the URL is the hard
  guarantee. A third-party server was not used: `@modelcontextprotocol/server-postgres` is archived
  and its read-only transaction could be escaped with stacked statements, and `postgres-mcp`
  0.3.0 did not resolve (it pins a `pglast` version the index no longer serves).
- **ast-grep.** `@ast-grep/cli` is a pinned root dev dependency. `bun run search:ast` runs
  `ast-grep run` for structural searches that text search gets wrong, such as every call of a
  function with any arguments or every `||` fallback on a numeric field.

## Consequences

- Claude sees type, lint and boundary errors seconds after the edit that caused them, without
  waiting for a manual check. Measured in a cloud container: frontend file about 10 s warm (type-
  aware ESLint about 6 s of it), 38 s on a cold cache; backend file about 4 s warm, 25 s cold; a
  non-code file 0.02 s. The edit itself is not delayed.
- A wake reports every error in the owning `tsc` project, not only the edited file. On a clean
  `main` that equals the errors the edit introduced.
- Bun does not run `@ast-grep/cli`'s postinstall script, so ast-grep prints a warning and resolves
  its platform binary at run time. Results are unaffected.
- Local sessions need `typescript-language-server` installed once; the plugin does not install it.
- Interactive sessions ask once before starting the project MCP server. Without
  `VISION_MCP_DATABASE_URL` the server starts and every query returns an explanatory error.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/225-static-checks-for-agents|ADR-225]]
- [[docs/adr/221-proportional-ci|ADR-221]]
- [[docs/guides/devcontainer|Agent Sandbox Guide]]
- [[docs/reference/scripts|Scripts Reference]]
