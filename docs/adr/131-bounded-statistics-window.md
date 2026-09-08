---
title: ADR-131 Bounded default statistics window
type: adr
status: accepted
date: 2026-09-07
tags: [adr, statistics, performance, api, rolling-window]
description: Uses a rolling 24-calendar-month default for Statistics while retaining an explicit all-time mode and exact historical foreign-exchange conversion.
aliases: [statistics date window, rolling statistics window]
---

# ADR-131: Bounded default statistics window

## Status

Accepted

## Date

2026-09-07

## Context

Opening Statistics issued cold all-time pivot scans. Query cost therefore grew with the complete
transaction history even when the first view focused on recent trends. A silent server-side cap
would improve latency but hide data and make chart meaning unclear.

## Decision

Statistics defaults to the latest 24 calendar months, including the current partial month. The
page shows the active range and offers an explicit **All time** option. The default URL has no
window parameter; `?window=all` selects complete history.

The frontend sends one inclusive range to monthly summary, category pivot, recipient insights,
and recipient-by-year. The backend applies those bounds before aggregation. All-time monthly
summary uses `all_time=true`; other all-time calls omit bounds. Every path keeps historical
foreign-exchange conversion at the transaction date.

## Consequences

- Cold Statistics requests have bounded transaction scans by default.
- Users can still inspect the full ledger and can see when that more expensive mode is active.
- Filtered and unfiltered graph payloads share the same selected range.
- Date bounds are part of response-cache and React Query keys, preventing cross-window reuse.
- The 24-month choice is a product default, not data retention; no records are deleted.

## Related

- [[docs/features/statistics|Statistics Feature]]
- [[docs/api/aggregations|Aggregations API]]
- [[docs/adr/index|All ADRs]]
