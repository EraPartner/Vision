---
title: "ADR-228: TypeScript navigation MCP server"
type: adr
status: accepted
date: 2026-10-20
tags: [adr, claude-code, agents, typescript, tsserver, mcp, language-server]
description: "Accepted on 2026-10-20. .mcp.json registers vision-typescript, an in-repo stdio MCP server over the repository's own tsserver, giving local and cloud Claude Code sessions symbol search, go-to-definition, cross-package references, hover types and per-file diagnostics. It replaces ADR-227's local-only typescript-lsp plugin and its global typescript-language-server install. mcp-language-server and Serena were trialled and rejected."
aliases: [adr-228, typescript mcp, vision-typescript, tsserver mcp, lsp in cloud]
related_code:
  [
    ".mcp.json",
    ".claude/settings.json",
    "apps/node-backend/scripts/typescript-mcp.ts",
  ]
---

# ADR-228: TypeScript navigation MCP server

## Status

Accepted on 2026-10-20. Supersedes the language-server bullet of
[[docs/adr/227-claude-code-static-analysis-aids|ADR-227]].

## Date

2026-10-20

## Context

ADR-227 enabled the `typescript-lsp` plugin. Claude Code does not start plugin language servers in
cloud sessions, so cloud threads, where most Vision work runs, had no go-to-definition or
find-references, and local sessions needed a global `typescript-language-server` install. Project
MCP servers from `.mcp.json` do load in cloud sessions.

The repository has no root `tsconfig.json`. `tsserver` answers find-references only from the
projects it has loaded, so a server that opens just the file being asked about misses callers in
other workspaces: references to `sumMoney` from `packages/shared-utils` found 1 hit instead of 14.

Trialled in a cloud container on 2026-10-20 and rejected:

- `mcp-language-server` v0.1.1 (Go, last release 2025-05) opened all 2,312 TypeScript files at
  start, grew `tsserver` past 3 GB and did not answer a `definition` call within 7 minutes.
- Serena 2.1.0 (Python, 57 dependencies) found definitions after a 53 s first call, but returned
  only same-file references for `sumMoney`, and writes a `.serena/` project folder into the
  checkout.

## Decision

`.mcp.json` registers `vision-typescript`, a stdio MCP server in
`apps/node-backend/scripts/typescript-mcp.ts`, started with `bun` like `vision-postgres`. It spawns
the repository's own `node_modules/typescript/lib/tsserver.js` (under Node when `node` is on
`PATH`, otherwise Bun) and adds no dependency.

- **Tools.** `find_symbol` (name or fragment, via `navto`), `definition`, `references` and `hover`
  (a repository path, a 1-based line and the identifier on that line, so agents need no column),
  and `diagnostics` (syntax and type errors for one file).
- **Project loading.** At start it opens one anchor file per workspace project
  (`apps/frontend/src/main.tsx`, `apps/node-backend/src/main.ts`, the `packages/shared-utils` and
  `packages/types` entry points) so references span workspaces.
- **Freshness.** Before each call it reloads the anchors and the requested file from disk, so
  results follow edits made with Claude's own file tools.
- The `typescript-lsp` plugin is removed from `.claude/settings.json`; local and cloud sessions use
  the same route.

## Consequences

- Measured in a cloud container: the first call waits about 7 to 11 s for the projects to load;
  later calls take 5 ms (hover) to 0.3 s (166 references to `asAccountId` in 53 files across
  frontend and backend), and `diagnostics` about 0.7 s. `tsserver` uses about 1.2 GB under Node
  and 1.5 to 2.3 GB under Bun.
- Verified in a fresh nested `claude -p` session: `find_symbol`, cross-package `references`,
  `definition` through the backend's `lib/money.ts` re-export, and `diagnostics` reporting an
  introduced TS2322 error, then `No problems.` after the edit was reverted.
- Backend tests (`apps/node-backend/tests`, checked by `tsconfig.tests.json`) belong to no project
  `tsserver` discovers, so `references` does not list them.
- `bun run typecheck` stays authoritative; `diagnostics` checks one file, and the edit hook still
  reports errors after each edit.
- Local sessions no longer need `typescript-language-server`. Interactive sessions ask once before
  starting the project MCP server. Not yet exercised in a local session on the Mac.
- No CI job or CI time is added.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/227-claude-code-static-analysis-aids|ADR-227]]
- [[docs/guides/devcontainer|Agent Sandbox Guide]]
- [[docs/reference/scripts|Scripts Reference]]
