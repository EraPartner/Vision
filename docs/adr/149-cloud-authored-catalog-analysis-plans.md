---
title: ADR-149 - Cloud-authored catalog analysis plans
type: adr
status: Accepted
date: 2026-09-14
tags: [adr, ai, analysis, privacy, security, openai, catalog]
description: Allow a cloud planner to propose identifier-only analysis plans while local validation, scope injection, execution, and result synthesis remain inside Vision.
aliases: [cloud analysis plans, identifier-only cloud planner]
---

# ADR-149: Cloud-authored catalog analysis plans

## Status

Accepted

## Date

2026-09-14

## Context

The optional OpenAI investigation planner could order locally authored tool steps, but it could not
request a new analysis over Vision's approved datasets. Sending SQL, relation names, account IDs,
investment IDs, or result rows to the planner would cross the established disclosure boundary.

## Decision

The planning payload publishes only versioned dataset, field, measure, join, operator, and type
identifiers. It never publishes database relations or private scope identifiers. The provider may
return at most three strict `CloudAnalysisPlan` objects and cannot return SQL or callbacks.

Vision parses each object with a closed schema, checks the catalog version and requested workspace,
and compiles it through the same allowlisted analysis catalog as the manual workspace. Trusted
account, investment, and date restrictions are injected locally as parameter values. The dedicated
read-only analysis executor runs the query. Rows and formula results are stored as private local
step output and are available only to local synthesis. A planning grant never authorizes result
disclosure or cloud synthesis.

Malformed, stale, over-budget, out-of-workspace, unknown-identifier, or SQL-bearing output is
discarded and the deterministic local plan remains usable.

## Consequences

- Cloud planning becomes more useful without expanding the disclosed payload to private data.
- The local catalog and executor remain the authority for relations, SQL, limits, and scope.
- Provider-generated plans may fail closed when the catalog changes; they are not translated by
  guessing.
- Private analysis results can be processed by the configured local model, but never returned to
  the cloud planner.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/security/ai-data-access|AI Data Access Policy]]
- [[docs/features/analysis-workspace|Analysis Workspace]]
- [[docs/adr/144-isolated-manual-analysis-workspace|ADR-144]]
- [[docs/adr/145-bounded-ai-research-orchestration|ADR-145]]
