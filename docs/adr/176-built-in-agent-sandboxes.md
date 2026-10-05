---
title: ADR-176 Built-in Agent Sandboxes
type: adr
status: accepted
date: 2026-10-04
tags: [architecture, security, development, claude-code, codex]
description: Retire the project agent container and use built-in Claude Code and Codex sandboxes.
aliases: [adr-176, built-in agent sandboxes]
---

# ADR-176: Built-in Agent Sandboxes

## Status

Accepted. Supersedes [[docs/adr/077-devcontainer-apple-container-runtime|ADR-077]] for agent execution.

## Context

The operator has retired the shared agent-container tooling and uses the built-in sandboxes in
Claude Code and Codex. Keeping project launchers, provider staging, image pins, and container drift
checks would retain an unused execution boundary and conflicting operating instructions.

## Decision

Remove `.devcontainer/`, its host-isolation test, its Docker Dependabot entry, and the external
canonical checkout and drift steps in continuous integration. Keep project instruction checks,
workflow supply-chain checks, and application validation. Agents follow their provider's active
sandbox permissions and use the existing native source development workflow.

Keep historical architecture records intact. Replace the active container guide with current
agent guidance at the same note path to preserve links. Report reviewed local work and checks to
the user; a separate container publication handoff is no longer a project requirement.

## Consequences

There is no project-owned provider staging, egress proxy, or container-private dependency volume.
The provider and the active session now define the agent execution boundary. This decision does
not claim that built-in sandboxes enforce the retired container's exact controls. Existing runtime
containers, images, and data volumes are outside this repository cleanup and are not deleted.
The product's native runtime, database, and Electron isolation are unchanged.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/guides/devcontainer|Agent Sandbox Guide]]
- [[docs/guides/setup|Setup Guide]]
- [[docs/guides/cicd-pipelines|CI/CD Pipelines]]
