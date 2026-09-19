---
title: ADR-154 - Deterministic Local Analysis Monitors
type: adr
status: Accepted
date: 2026-09-19
tags: [adr, analysis, monitoring, research, privacy, persistence]
description: Persist local threshold and dossier-evidence checks with durable observations, deduplicated episodes, cooldowns, and an in-app inbox.
aliases: [local analysis monitoring, durable monitor observations]
---

# ADR-154: Deterministic Local Analysis Monitors

## Context

Saved analyses can be rerun and dossiers keep evidence, but neither records when a condition or
evidence set changes. A background check must not turn private financial data into an implicit
AI or web request. A transient browser timer also cannot preserve failures, missed checks, or
notification state across app restarts.

## Decision

Migration 0116 adds `analysis_monitors`, `analysis_monitor_observations`, and
`analysis_monitor_notifications`. A monitor targets one saved analysis numeric result field with
an exact decimal `above` or `below` boundary, or one dossier's evidence set. The target's label
and historical ID remain when its live foreign key is cleared by deletion. Rule and history lists
are paged. Deleting a rule cascades to its observations and inbox entries.

The backend persists the next due time and claims a short lease before checking. A bounded
one-minute scheduler tick handles at most four due rules in sequence; startup catches up overdue
rules. Manual checks use the same service and return a conflict for a busy or disabled rule. The
first valid observation establishes a baseline without an alert. A changed analysis definition
or edited numeric condition starts a new baseline. Saved-analysis checks require their own newly
created run to be `completed`, current-version, one row, finite numeric, and not a truncated
window or formula error. Incomplete, stale, or failed checks are persisted and visible but never
prove a threshold crossing. The runtime cannot prove all upstream source coverage, so the
observation says coverage is `unknown` instead of claiming completeness beyond its result window.

A dossier check compares a canonical hash of its evidence entries, ignoring array order. It does
not revalidate cited sources. A threshold not-met to met transition, or an evidence-set change,
creates at most one notification per episode. A cooldown delays another notification; subsequent
checks can deliver the pending episode after the cooldown. Inbox read state, deduplication, and history live in
PostgreSQL, not browser storage.

These checks are local and deterministic. They do not call a model, external provider, or web
source, and they do not use native operating-system notifications. All three tables are in normal
`.visionbak` backup coverage. Downgrade is guarded while monitor or notification data exists.

## Consequences

- A monitor reports what its saved analysis or dossier contained at a check time. It is not a
  real-time guarantee and cannot establish source-data completeness that the analysis runtime
  does not attest.
- Background runs can add local database load. The bounded scheduler and leases limit concurrent
  work, but an expensive saved analysis may still fail and leave a visible observation.
- Deleting a target leaves a failed rule and its history for review. Deleting the rule itself
  removes its history and inbox entries.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/analysis-monitors|Analysis Monitors]]
- [[docs/api/analysis-monitors|Analysis Monitors API]]
- [[docs/adr/144-isolated-manual-analysis-workspace|ADR-144]]
- [[docs/adr/153-persistent-research-dossiers|ADR-153]]
- [[docs/reference/data-model|Data Model]]
