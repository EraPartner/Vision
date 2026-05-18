---
title: ADR-009 - Timezone Policy
type: adr
status: Accepted
date: 2026-04-16
tags: [adr, backend, dates, timezone, refactor]
description: Store UTC in DB, compute in configured local timezone, single conversion boundary
aliases: [adr-009, timezone-policy, tz-policy]
---

# ADR-009: Timezone Policy

## Status
Accepted

## Date
2026-04-16

## Context

Non-portfolio business math (transaction dates, planned payment execution, recurrence expansion, loan schedule generation, monthly/quarterly aggregations, cashflow comparison) mixes two timezones in an ad-hoc way:

1. **Database** stores timestamps as `TIMESTAMPTZ` or date-only `DATE` (for planned_date, loan_payment_day). Values are written as UTC when they come from `NOW()` or client ISO strings, but also as local-zone strings in some import paths.
2. **Services** compute month boundaries, "due soon" windows, and recurrence next-dates using a mix of `new Date()` (host-local), `Date.UTC(...)` (hardcoded UTC), and `YYYY-MM-DD` string math that silently inherits whichever zone the Node process happens to run in.
3. **Frontend** renders dates using the browser zone, so "April 30" displayed client-side can differ from "April 30" used by the server to bucket into month-end aggregates.

Symptoms observed:
- Recurrence `addMonthsAtDay(Jan 31, 1)` produces Feb 28 or Feb 29 depending on whether the input was parsed as UTC or local.
- Planned payments dated `2026-03-01` execute one day early when the server runs in `UTC` and the user is in `Europe/Brussels` during DST spring-forward.
- Monthly aggregates count a `23:30 UTC` transaction on the 31st into the next month when rebucketed as `Europe/Brussels`.

The refactor in [[docs/adr/index|ADR index]] (Phase 2 dashboard + Phase 3 planned) removes client-side re-aggregation. Every aggregate becomes a single Postgres view or trigger-maintained table. Those Postgres objects need a deterministic notion of "what month is this transaction in" that matches the user's expectation.

## Decision

1. **Storage**: all timestamp columns remain `TIMESTAMPTZ` storing UTC. Date-only columns (`planned_date`, `loan_start_date`, `loan_first_payment_date`, `loan_payment_day`) remain `DATE` with no zone semantics.
2. **Application zone**: a new env var `APP_TIMEZONE` (default `Europe/Brussels`) is the single source of truth for all business math. Read once at startup; exported from a new `lib/timezone.js` module.
3. **Boundary helpers**: exactly two helpers mediate conversion at the edges:
   - `toAppTz(utcDate): { year, month, day, hour, minute, second }` — convert UTC `Date` to zoned components.
   - `toUtc(zonedComponents): Date` — convert zoned wall-clock components to a UTC `Date`.
   Helpers wrap `Intl.DateTimeFormat` with `timeZone: APP_TIMEZONE`; no custom offset math.
4. **SQL aggregations**: every `date_trunc`, `EXTRACT(month FROM ...)`, and month-bucket `GROUP BY` in materialized views and queries runs in `APP_TIMEZONE`:
   ```sql
   date_trunc('month', t.date AT TIME ZONE 'Europe/Brussels')
   ```
   The literal `'Europe/Brussels'` is substituted at migration time from `APP_TIMEZONE`; value is documented in each MV definition.
5. **Date-only fields** are never converted. `planned_date = '2026-03-01'` means "March 1 in user's zone" with no UTC round-trip.
6. **Recurrence + loan math**: `addMonthsAtDay`, `nextRecurrenceDate`, `generateLoanSchedule` all operate on zoned components (`{year, month, day}`) via the boundary helpers. No raw `Date` arithmetic inside calc modules.
7. **Frontend** continues to render in the user's browser zone for *display*. Any client-side date that participates in business logic (e.g. "is this planned payment due this week?") is computed server-side and returned as either a pre-rendered string or a pair `{ utc, zoned }`. The client never re-buckets into months.
8. **Environment validation**: `lib/timezone.js` throws at startup if `APP_TIMEZONE` is not a valid IANA zone per `Intl.DateTimeFormat.resolvedOptions()`.

## Consequences

### Positive
- One mental model: DB = UTC, business math = `APP_TIMEZONE`, display = browser zone with server-provided values for anything that affects bucketing.
- Month-boundary, leap-day, and DST bugs localized to one module (`lib/timezone.js`) with golden-fixture coverage.
- Materialized views can be deterministically regenerated; MV output matches the per-request aggregation endpoint byte-for-byte because both use the same SQL timezone literal.
- Planned/recurrence/loan calcs become pure functions over zoned components, trivially testable without mocking `Date`.

### Negative
- All existing aggregation SQL must be audited and rewritten to wrap `t.date` in `AT TIME ZONE`. Done as part of Phase 1 migration; MV unique indexes prevent silent regressions.
- Deployers in a different zone must set `APP_TIMEZONE` explicitly. Default keeps current single-user Belgian deployment working unchanged.
- Any historical aggregate cached before this ADR may shift by one day at month boundaries. Addressed by a one-time MV rebuild in the Phase 1 migration; no user-visible data loss.

### Migration
- Phase 0: add `lib/timezone.js`, add `APP_TIMEZONE` to `.env.local.example`, add boundary helpers + unit tests. No call-sites migrated yet.
- Phase 1: MV definitions updated to use `AT TIME ZONE`; one-time rebuild during migration.
- Phase 3: recurrence + loan calcs migrate to zoned-component math.
- Phase 8: property test `forAllZones(zone => bucketMonth(tx) === expected)` confirms no drift.

### Rollback
Env var `APP_TIMEZONE=UTC` restores pre-ADR UTC-everywhere behavior. MV definitions are additive; reverting the migration drops the `AT TIME ZONE` wrapping and rebuilds with UTC semantics.

## Related
- [[docs/adr/008-performance-page-server-computed-response]]
- Phase 0 of the non-portfolio refactor plan
- `lib/timezone.js` (created in this ADR)
- `services/calculations/recurrence.js`, `services/calculations/loanSchedule.js` (migrated in Phase 3)
