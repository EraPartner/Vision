---
title: Agent Sandbox Guide
type: guide
status: active
date: 2026-10-04
updated: 2026-10-04
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
