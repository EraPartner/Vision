---
title: "ADR-237: Cross-site guard for every method"
type: adr
status: accepted
date: 2026-10-21
tags: [adr, security, csrf, sec-fetch-site, loopback, adr-063, adr-233]
description: "Accepted on 2026-10-21. The /api cross-site guard now rejects cross-site and same-site requests of every method, GET, HEAD and OPTIONS included, because a cross-site GET still executes expensive aggregations, outbound provider calls and timing-visible lookups. /health probes and top-level SPA navigations stay outside the guard."
aliases: [adr-237, csrf for get, cross-site get guard]
related_code:
  [
    "apps/node-backend/src/middleware/csrfGuard.ts",
    "apps/node-backend/src/main.ts",
    "apps/node-backend/tests/csrfGuard.test.ts",
    "apps/node-backend/tests/routes/transactions.test.ts",
  ]
---

# ADR-237: Cross-site guard for every method

## Status

Accepted on 2026-10-21. Amends [[docs/adr/063-admin-auth-csrf-guard|ADR-063]] and
[[docs/adr/233-loopback-only-backend|ADR-233]], which let safe methods through and left guarding
them as an open decision.

## Date

2026-10-21

## Context

The backend listens on loopback only and sends no CORS headers, so a page on another origin cannot
read API responses. It can still make the browser send requests: an `<img>`, `<script>` or
`fetch(..., { mode: "no-cors" })` to `http://localhost:PORT/api/...` executes the route. Before this
change the guard skipped `GET`, `HEAD` and `OPTIONS`, so a malicious page could:

- run expensive aggregations and statistics queries (129 GET operations under `/api`, for example
  `/api/info/*` and `/api/aggregations/*`) to load the database and CPU;
- trigger outbound provider calls (`/api/market/*`, `/api/research/*`, `/api/admin/update/check`)
  that spend provider quota or reveal that Vision is running;
- time responses of lookups to infer facts about the data (ADR-101 notes a timing oracle).

None of these leaks a response body. The cost of closing them is low: the renderer is always
same-origin (the packaged app loads the backend's own origin; development goes through the Vite
proxy), and the Electron main process sends no fetch metadata.

## Decision

`createCsrfGuard` applies to every method. With `Sec-Fetch-Site`, `same-origin` and `none` pass and
`same-site` and `cross-site` get 403. Without it, a present `Origin` must be one of the backend's
own loopback origins, and an absent `Origin` (curl, the Electron main process) passes. The guard
stays mounted on `/api` only, so `/health`, `/health/detailed` and top-level SPA navigations
(including a link opened from another site) are not affected.

## Consequences

- Cross-site pages can no longer trigger any `/api` route.
- Opening an API URL from the address bar, Finder or another app still works (`Sec-Fetch-Site:
  none`).
- A future feature that embeds API URLs in a document on another origin (for example a custom
  protocol page loading `/api` images) would be blocked and must load the data same-origin or
  through IPC instead. The report print window already loads its document in memory.
