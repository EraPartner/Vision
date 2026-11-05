---
title: "ADR-266: Insights opens on All time"
type: adr
status: accepted
date: 2026-11-05
tags: [adr, statistics, insights, rolling-window, adr-131]
description: "Insights (the Statistics page) now opens on All time, so the pivot table's year selector and the year-over-year views cover the whole ledger. Last 24 months stays one click away as ?window=24m. Supersedes the default-window part of ADR-131."
aliases: [adr-266, insights default all time, statistics default window]
related_code:
  [
    "apps/frontend/src/pages/StatisticsPage.tsx",
    "apps/frontend/src/hooks/useStatistics.ts",
  ]
---

# ADR-266: Insights opens on All time

## Status

Accepted on 2026-11-05. Supersedes the default-window decision of
[[docs/adr/131-bounded-statistics-window|ADR-131]]; its request contract, cache keys and
historical foreign-exchange rules stay.

## Context

- [[docs/adr/131-bounded-statistics-window|ADR-131]] made Insights open on the latest 24
  calendar months to bound cold PostgreSQL scans. That window spans three calendar years, so the
  category pivot's year selector, the year-over-year chart, the yearly summary and the Flow tab's
  year list offered only three years until the user picked **All time**. The choice lived only
  in the URL and reset on every visit.
- On 2026-11-05 Tor asked to see his entire history in the pivot table and year-over-year
  comparison while keeping the pivot's year selector, and chose to make the whole page default
  to All time over the alternatives (full history for the year views only, or remembering the
  toggle).
- Since [[docs/adr/263-sqlite-replaces-postgresql|ADR-263]] the backend reads one SQLite file
  in-process. The all-time path already existed and is behind the shared five-minute statistics
  cache.

## Decision

- Insights opens on **All time**. The URL without a `window` parameter means All time.
- **Last 24 months** stays in the same two-segment control and is encoded as `?window=24m`.
- A legacy `?window=all` link still opens All time. Any other value falls back to All time.
- `useStatistics(window)` keeps its `"24m"` default for other callers (the tax-year discovery
  hook); only the page default changes.

## Consequences

- The pivot's year selector, year-over-year chart, yearly summary and Flow year list cover the
  whole ledger on first open.
- A cold first open costs a full-history scan instead of a 24-month one. This is not measured;
  revisit if Insights is reported slow on first open.
- Shared links made before this change keep their meaning for All time (`?window=all`). A link
  made before this change to the 24-month default (no parameter) now opens All time.

## Related

- [[docs/adr/131-bounded-statistics-window|ADR-131: Bounded default statistics window]]
- [[docs/features/statistics|Statistics Feature]]
- [[docs/adr/index|All ADRs]]
