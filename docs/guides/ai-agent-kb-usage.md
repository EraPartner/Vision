---
title: AI Agent KB Usage Guide
type: guide
status: active
date: 2026-08-17
tags: [guide, ai-agent, obsidian, usage, documentation, model-agnostic]
description: Model-agnostic workflow for coding agents to find, evaluate, and update the Vision knowledge base.
aliases: [ai agent guide, agent instructions, how to use kb]
---

# AI Agent KB Usage Guide

> [!abstract] Purpose
> Give any coding agent the same repository-first workflow for reading and maintaining the Vision
> knowledge base.

## Before implementation

1. Read [[AGENTS.md|the repository guidance]] and any closer `AGENTS.md` file.
2. Search `docs/` for the feature, endpoint, schema, integration, workflow, and code paths in scope.
3. Read relevant accepted ADRs. Treat them as historical decisions; never rewrite them.
4. Compare documentation intent with current code behavior and call out conflicts.

Use available repository search and file tools. `rg` and `rg --files` are the portable defaults.
Obsidian-aware tools may be used when available, but the workflow must not depend on a specific
model, plugin, or host application.

## After implementation

Wait until the implementation diff is stable, then use the decision gate in
[[docs/guides/kb-maintenance|KB Maintenance Guide]] before final verification and commit.

- Update docs when behavior, contracts, architecture, configuration, security, integrations,
  packaging, operations, public interfaces, or documented paths changed.
- Skip docs-neutral tests, formatting, generated outputs, and behavior-preserving internal
  refactors.
- When no update is required, record the reason in the completion report.

Use the `update-vision-docs` skill for changes that may affect a documented surface.

## Editing Obsidian Markdown

- Preserve YAML frontmatter, wikilinks, embeds, callouts, and Dataview queries.
- Update the date of every changed content page.
- Use `[[path/to/note|label]]` for vault links and `[[path/to/code.js]]` for code links.
- Link new or heavily changed notes from an index and at least one related note.
- Prefer updating an existing canonical page over creating a duplicate.

## Completion

Report documents changed, diagram or flow-visualizer impact, graph and frontmatter checks,
validation, skipped checks, and remaining gaps. Confirm documentation claims against code and
tests; never present planned behavior as implemented.

## Related

- [[docs/index|Vision Knowledge Base]]
- [[docs/guides/kb-maintenance|KB Maintenance Guide]]
- [[docs/guides/contributing|Contributing Guide]]
- [[docs/adr/index|Architecture Decision Records]]
