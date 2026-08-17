---
title: KB Maintenance Guide
type: guide
status: active
date: 2026-08-17
tags: [guide, maintenance, kb-sync, documentation, workflow]
description: Decide when implementation changes require Vision knowledge-base updates and synchronize affected docs before commit.
aliases: [kb maintenance, update docs, sync docs, documentation workflow]
---

# KB Maintenance Guide

> [!abstract] Purpose
> Keep the knowledge base accurate without creating documentation churn for changes that do not
> alter documented facts.

## Timing

1. **Before implementation:** find the relevant feature, contract, architecture decision, and code
   convention documents.
2. **After the implementation diff is stable:** evaluate documentation impact against the actual
   code change.
3. **Before final verification and commit:** update every affected document, diagram, index, and
   generated contract surface in the same change.
4. **At completion:** report which docs changed. If none changed, record the reason.

## Decision table

| Update required | Usually no update required |
|---|---|
| User-visible behavior or workflow changed | Tests or fixtures only |
| API contract or rate limit changed | Formatting, comments, or lint-only edits |
| Schema, environment, configuration, security, packaging, or operations changed | Generated-output refresh with unchanged source behavior |
| Architecture, ownership, dependency, integration, or end-to-end flow changed | Internal refactor preserving behavior, contracts, architecture, and documented paths |
| Documented interface, component role, or code location changed | Dependency update with no documented compatibility, security, or build effect |
| Existing docs are inaccurate or describe a removed limitation | Bug fix restoring behavior that docs already describe accurately |

When uncertain, search the vault for changed symbols, paths, endpoints, configuration keys, and
workflow names. Do not create a placeholder document solely to prove that documentation was
considered.

## Routing

| Change | Synchronize |
|---|---|
| API | `openapi.yaml`, route page under `docs/api/`, endpoint matrix, generated types |
| Behavior | Relevant feature, integration, guide, security, performance, testing, or troubleshooting page |
| Schema | Data-model reference, migration documentation, diagrams, and a new ADR when warranted |
| Environment or configuration | Environment reference and affected setup, deployment, or troubleshooting guide |
| Component, hook, service, or repository | Existing docs only when interface, role, ownership, relationship, or location changed |
| Architecture or end-to-end flow | Relevant PlantUML and `docs/flow-visualizer.html` |
| New document | Relevant index or map-of-content note plus reciprocal related links |

Do not rewrite accepted Architecture Decision Records (ADRs). Add a new ADR that supersedes the
old decision.

## Diagram threshold

Update diagrams only for structural changes: added, removed, renamed, or moved components; changed
ownership; changed load-bearing dependencies; or changed workflow hops and payloads. A logic edit
inside an existing component does not by itself require a diagram update.

## Completion checklist

- [ ] Documentation impact was evaluated after implementation.
- [ ] Updated claims match code and tests rather than intended future behavior.
- [ ] Changed notes have current frontmatter dates and valid wikilinks.
- [ ] New or heavily changed notes have index and reciprocal related links.
- [ ] API, diagram, and flow-visualizer surfaces were synchronized when applicable.
- [ ] Validation and any skipped checks are reported.
- [ ] If no docs changed, the completion report gives a specific reason.

## Session notes

Create a session note only for durable context not captured better in an ADR, feature, reference,
or guide. Examples include multi-stage investigations, cross-module deliveries, and operational
findings needed for future work. Skip session notes for routine fixes, review-only work, internal
refactors, formatting, generated-output refreshes, and documentation-only maintenance unless the
user asks for one.

## Related

- [[AGENTS.md|Repository agent guidance]]
- [[docs/guides/ai-agent-kb-usage|AI Agent KB Usage Guide]]
- [[docs/guides/contributing|Contributing Guide]]
