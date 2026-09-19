---
title: Analysis Monitors API
type: endpoint
status: active
date: 2026-09-19
tags: [api, analysis, monitoring, research, notifications]
description: Eight additive operations for local monitor rules, durable observations, and the in-app notification inbox.
path: /api/analysis/monitors
methods: [GET, POST, PATCH, DELETE]
aliases: [monitor API, saved analysis monitoring endpoints]
---

# Analysis Monitors API

These eight operations are additive and use the standard `{ok:true,data:...}` envelope, except
`DELETE` which returns empty `204`. The group uses the aggregation rate limiter. Invalid bodies,
UUIDs, or pagination return `400`; missing rules or targets return `404`. Lists default to 50
items, allow at most 200, and accept `offset` from 0 through 1,000,000.

| Method   | Path                                            | Purpose                                                             |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `GET`    | `/api/analysis/monitors`                        | Paged rules with latest observation and total count                 |
| `POST`   | `/api/analysis/monitors`                        | Create an analysis-threshold or dossier-evidence rule (`201`)       |
| `PATCH`  | `/api/analysis/monitors/:id`                    | Edit title, enabled state, interval, cooldown, or numeric condition |
| `DELETE` | `/api/analysis/monitors/:id`                    | Delete rule, history, and inbox entries (`204`)                     |
| `POST`   | `/api/analysis/monitors/:id/check`              | Run a check now and return its new observation                      |
| `GET`    | `/api/analysis/monitors/:id/observations`       | Paged observation history, newest first                             |
| `GET`    | `/api/analysis/monitors/notifications`          | Paged inbox with total and `unreadCount`                            |
| `POST`   | `/api/analysis/monitors/notifications/:id/read` | Mark one inbox entry read                                           |

An analysis-threshold create body has `kind:"analysis-threshold"`, `title`, `savedAnalysisId`,
`fieldId`, `operator:"above"|"below"`, and `threshold` as an exact decimal **string**, not a JSON
number. The field must be a declared numeric result column of a non-frozen saved analysis. A
dossier-evidence create body has `kind:"dossier-evidence"`, `title`, and `dossierId`. Both accept
optional integer `intervalMinutes` (15–10080, default 1440) and `cooldownMinutes` (0–10080,
default 1440). Unknown body keys are rejected. Targets cannot be changed by `PATCH`; numeric
condition fields apply only to threshold rules. Edits or manual checks return `409 MONITOR_BUSY`
while a rule has an active lease; a disabled rule cannot be checked manually.
`PATCH` is partial: omitted fields retain their existing values.

Rule responses include the current live target ID or `null`, `historicalTargetId`, `targetLabel`,
`targetAvailable`, due/check times, last status, and latest observation. Observations have
`status` of `baseline`, `unchanged`, `triggered`, `cooldown-pending`, `partial`, `stale`, or `failed`;
reason code and text; previous/current numeric values or dossier versions; and, for analysis,
the exact run ID, run status, definition version, and result window. The `coverage` object reports
`unknown` because source coverage is not independently verified. Failures are response data, not
silently suppressed; a successful `check` request can therefore return a `failed` observation.
`readAt` and `unreadCount` are server-owned. A first valid check is a baseline with no inbox entry.

The API does not call AI or web providers. It adds no breaking change to existing analysis or
dossier operations.

## Related

- [[docs/api/index|API Documentation]]
- [[docs/features/analysis-monitors|Analysis Monitors]]
- [[docs/adr/154-local-analysis-monitors|ADR-154]]
- [[docs/api/analysis|Analysis API]]
- [[docs/api/research-dossiers|Research Dossiers API]]
