---
title: ADR-120 Cash-Flow Cache Date Keys
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags: [adr, database, postgresql, cash-flow, forecast, cache, dates]
description: Store forecast month and day keys as PostgreSQL DATE values while retaining the live logical user cache partition.
aliases: [adr-120, cashflow-date-keys]
---

# ADR-120: Cash-Flow Cache Date Keys

## Status

Accepted

## Context

The three cash-flow forecast persistence tables stored month or day keys as unrestricted `TEXT`.
Ordering worked only while every writer preserved one exact lexical format. The same tables carry a
`user_id` column even though Vision currently has one interactive user.

## Decision

Migration 0093 converts the month keys to the first day of their month and the rolling key to a
PostgreSQL `DATE`. Repository boundaries continue to accept and return the established `YYYY-MM`
and `YYYY-MM-DD` strings, using explicit SQL casts and `to_char` projections.

Keep `user_id`. It is not dead: repositories partition every cache operation by it, and the nightly
pre-warm job enumerates distinct values from forecast accuracy history. It is a logical cache
namespace, not a claim that the rest of the schema is multi-tenant.

Malformed legacy date strings are deleted before conversion. These rows cannot be interpreted and
the forecast cache/history is regenerable. Downgrade restores the former string shapes but cannot
restore discarded malformed rows.

## Consequences

- PostgreSQL validates date keys and can compare and range-filter them as dates.
- API and service string contracts remain unchanged.
- Cache uniqueness remains partitioned by logical user id.
- The migration requires disposable PostgreSQL upgrade/downgrade verification before release; it
  was not applied to user data in this desktop session.

## Related

- [[alembic/versions/0093_cashflow_cache_date_types.py|Migration 0093]]
- [[docs/features/cash-flow-forecast|Cash Flow Forecast]]
- [[docs/reference/data-model|Data Model]]
