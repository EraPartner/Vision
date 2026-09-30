---
title: "ADR-174: Single-instance daily job catch-up"
type: adr
status: accepted
date: 2026-09-30
tags: [adr, scheduling, backend]
description: One backend process per database coalesces overdue daily forecast and holding-gap jobs using persisted successful-completion timestamps.
---

# ADR-174: Single-instance daily job catch-up

## Context

Process-local 24-hour intervals restart at each launch. Frequent restarts can indefinitely
postpone daily forecast cache and holding-gap work. The supported deployment contract is one
backend instance per shared database, as selected by the operator for this change.

## Decision

The forecast cache refresh and holding-gap refresh use `startup/dailyJobs.js`. Each job stores
its last successful completion time in `user_settings` under `daily_job_cashflow_forecast` or
`daily_job_holding_gaps`. A missing, invalid or future timestamp is due. A job becomes due 24 hours
after successful completion; no fixed wall-clock time is promised.

Startup and one-minute timer checks share one in-flight guard and checkpoint. Overdue work runs
once after startup dependencies settle, coalescing any number of missed days. Jobs do not replay
one run per missed date. Timer callbacks also await the initial portfolio warmup chain.

Offline, partial, failed, or checkpoint-write-failed work does not record completion. It retries
after an hour while the process stays up. A restart can retry it immediately. A failed checkpoint
read prevents work until the next retry. Forecast completion awaits successful cache persistence
for every active user. Holding-gap completion includes snapshot persistence even when a retry
finds no newly inserted quotes, because a prior run may have saved quotes before failing snapshots.

Startup warmup remains best-effort: dependencies settle after logging failures. A subsequent job
must still succeed before its checkpoint advances. The 12-hour FX and hourly quote refreshes retain
their existing startup work and process-relative intervals. Import retention runs once on startup.
Analysis monitors retain their separate existing scheduler.

## Consequences

Multiple backend instances sharing the same database are unsupported by this daily scheduler.
Its guard does not provide distributed exclusion. There is no exactly-once guarantee: a crash
between work persistence and checkpoint persistence can repeat derived work. The jobs are
idempotent refreshes. Database restore or deliberate checkpoint deletion can also make jobs due.

Persisting a checkpoint avoids repeated successful daily work on normal restarts. Retry and
snapshot recomputation can add database and provider load; the one-hour retry bounds this cost.
No new table or migration is required.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/architecture/backend-architecture|Backend Architecture]]
- [[docs/features/cash-flow-forecast|Cash Flow Forecast]]
- [[docs/features/net-worth|Net Worth]]
