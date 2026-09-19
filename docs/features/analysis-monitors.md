---
title: Analysis Monitors
type: feature
status: active
date: 2026-09-19
tags: [feature, analysis, monitoring, research, dossiers, notifications]
description: Local scheduled checks for saved-analysis thresholds and dossier evidence changes, with durable observations and an in-app inbox.
aliases: [saved analysis conditions, evidence change monitors]
---

# Analysis Monitors

At `/analysis/monitors`, a user can create a rule for an exact numeric boundary in a saved
analysis or for changes to a research dossier's evidence set. The rule has an interval from 15
minutes to seven days and a notification cooldown from zero to seven days. Its next due time,
last status, observations, and unread inbox count survive a restart. A user can pause a rule,
edit its condition, check it now, read its history, mark a notification read, or delete it.

The first valid check records a baseline and sends no alert. A numeric rule alerts only when its
result moves from not meeting the boundary to meeting it. `above` and `below` are strict; equality
does not meet either condition. An evidence rule alerts when the evidence content changes; merely
reordering entries does not count. The scheduler deduplicates each episode and applies the
configured cooldown. A condition edit or saved-analysis definition version change starts a new
baseline rather than comparing unlike results.

Only a completed, current-version, single-row, finite numeric saved-analysis result can drive a
threshold alert. Partial, stale, or failed checks appear in the observation history and cannot
trigger one. The observation records the exact analysis run, result-window metadata, reason, and
`coverage: unknown`: Vision does not claim verified upstream source coverage. An evidence change
means the saved dossier evidence set changed, not that any source was rechecked or a claim was
fact-checked. If a target is deleted, its rule and past observations remain visible with a saved
target label; future checks fail visibly until the rule is deleted.

All checks and notifications stay in the local backend and PostgreSQL database. No monitor check
contacts an AI model, market-data provider, or public web service, and no operating-system push
notification is sent. The inbox is an in-app view only. The three monitor tables are included in
normal `.visionbak` backups. Deleting a rule also deletes its observations and inbox entries.

## Related

- [[docs/features/index|Features]]
- [[docs/api/analysis-monitors|Analysis Monitors API]]
- [[docs/adr/154-local-analysis-monitors|ADR-154]]
- [[docs/features/analysis-workspace|Analysis Workspace]]
- [[docs/features/research-dossiers|Research Dossiers]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
