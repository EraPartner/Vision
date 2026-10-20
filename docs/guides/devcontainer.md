---
title: Agent Sandbox Guide
type: guide
status: active
date: 2026-10-20
updated: 2026-10-20
tags: [guide, security, claude-code, codex, development]
description: Use built-in Claude Code and Codex sandboxes with Vision's native development workflow.
aliases: [devcontainer-guide, devcontainer, dev-container, claude-code-container, agent-sandbox]
---

# Agent Sandbox Guide

Claude Code and Codex use their built-in sandboxes. The project no longer supplies an agent
container, a provider launcher, a network proxy, or container configuration synchronization.
The existing note path remains so links from earlier architecture records still resolve.

## Agent execution

Launch the selected provider normally in the repository. Follow the active session's filesystem,
network, and approval permissions. Do not bypass those restrictions or copy provider credentials
into another execution environment. Project instructions and skills remain in `AGENTS.md`,
`CLAUDE.md`, `.agents/`, `.claude/`, and `.codex/`.

Built-in sandbox behavior is controlled by the provider and the current session. The repository
no longer supplies the former container's egress hostname allowlist or private dependency volumes.
Do not assume those controls are still enforced.

## Claude Code tooling

`.claude/settings.json` and `.mcp.json` give every Claude Code session the same static-analysis
aids ([[docs/adr/227-claude-code-static-analysis-aids|ADR-227]]):

- After each edit of a TypeScript or JavaScript file, a background hook runs the owning `tsc`
  project, ESLint and dependency-cruiser and wakes Claude only when they report errors.
- Cloud sessions run `bun install` at start and warm the `tsc` caches.
- The `vision-typescript` MCP server gives local and cloud sessions TypeScript navigation:
  `find_symbol`, `definition`, `references`, `hover` and `diagnostics`, across the frontend,
  backend and shared packages. It runs the repository's own `tsserver`, so nothing is installed
  globally ([[docs/adr/228-typescript-navigation-mcp|ADR-228]]).
- The `vision-postgres` MCP server answers read-only SQL against a local migrated database. Set
  `VISION_MCP_DATABASE_URL` to a loopback URL, preferably with a read-only role, before starting
  Claude Code. Never point it at the real Vision database.
- `bun run search:ast -l ts -p '<pattern>' <path>` runs ast-grep for structural searches.

## Development and verification

Use the native source workflow in [[docs/guides/setup|Setup Guide]]. Run checks from the repository
with the installed toolchain. If sandbox permissions prevent a required check, report that exact
limit instead of treating the check as passed. Browser review uses the isolated native Vision Demo
application and synthetic data, as required by `AGENTS.md`.

No agent container build, rebuild, login, or configuration sync is needed. This cleanup removes
repository tooling; it does not delete existing runtime containers, images, or data volumes.

## Related

- [[docs/guides/index|Guides Index]]
- [[docs/guides/setup|Setup Guide]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
- [[docs/adr/176-built-in-agent-sandboxes|ADR-176: Built-in agent sandboxes]]
