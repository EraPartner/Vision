---
title: ADR-125 Provisional Latest Portfolio Snapshot
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags: [adr, portfolio, performance, snapshots, spike-sanitization]
description: Keep the newest portfolio snapshot raw until a later point can confirm a spike, and expose its provisional state to clients.
aliases: [adr-125, provisional-latest-portfolio-snapshot]
---

# ADR-125: Provisional Latest Portfolio Snapshot

## Status

Accepted

## Context

Portfolio snapshot sanitization can identify an isolated price spike only when both an earlier and
a later point exist. Smoothing the newest point without that evidence could replace a genuine
market move or cash event with an invented value. The existing sanitizer therefore leaves both
endpoints unchanged, but the API and Performance page did not explain that the newest chart point
could be stabilized after the next snapshot is built.

## Decision

The latest portfolio snapshot remains raw. The performance response adds `is_provisional` to every
returned snapshot and sets it only on the newest point. The Performance page visibly explains that
the latest chart point is provisional and remains unsmoothed until a later point supplies the
right-hand neighbour needed by the spike detector.

Older interior points continue to use the existing decomposition-aware sanitizer. The live
portfolio headline remains a separate current-value calculation and is not labelled provisional.

## Consequences

- A genuine latest-day move is never overwritten without two-sided evidence.
- Clients can distinguish stable historical points from the raw endpoint.
- The newest historical point may change after the next snapshot run if it is confirmed as an
  isolated spike.
- Period filtering does not change the rule because it removes only older points; the last returned
  point remains the latest stored point.

## Related

- [[docs/reference/algorithms#spike-sanitization|Spike Sanitization]]
- [[docs/api/info#GET /api/info/portfolio-performance|Portfolio Performance API]]
- [[docs/features/portfolio|Portfolio]]
