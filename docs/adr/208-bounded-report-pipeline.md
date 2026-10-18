---
title: "ADR-208: Bound the complete PDF report pipeline"
type: adr
status: accepted
date: 2026-10-11
tags: [adr, architecture, reports, performance]
description: Admit PDF report work before database reads and HTML allocation, with a finite queue and disconnect cancellation.
---

# ADR-208: Bound the complete PDF report pipeline

## Status

Accepted.

## Context

A semaphore around Chromium rendering does not bound database aggregation or accumulated HTML
for requests waiting to render. Concurrent export demand can therefore grow memory use before the
existing page limit applies.

## Decision

`services/reports/reportConcurrency.ts` admits two active report jobs and eight queued requests.
Admission precedes source fetching, HTML creation and PDF rendering. Overflow returns HTTP 503
using the normal error envelope. The route observes response closure: cancelled queued requests
are removed, and active requests check cancellation before PDF rendering. Running source work
retains its slot until it settles; cancellation does not falsely release capacity while that work
continues. Every completion or failure releases its slot in `finally`.

Fetch only sources required by selected sections. Keep the binary PDF response buffered and retain
the renderer's own page limit. Do not add a short client timeout that could reject a valid queued
report while leaving server work alive.

## Consequences

Concurrent demand is bounded; callers above capacity must retry. A slow active query still delays
its slot because this change does not add PostgreSQL query cancellation. The bounds do not imply
a measured single-report speedup. Financial source failures abort the report rather than rendering
missing values as zero. Report periods and exclusion semantics are documented in the API contract.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/api/reports|Reports API]]
- [[docs/features/pdf-report-export|PDF export feature]]
