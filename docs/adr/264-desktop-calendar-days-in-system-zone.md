---
title: "ADR-264: Desktop computes calendar days in the Mac's time zone"
type: adr
status: accepted
date: 2026-11-03
tags: [adr, backend, dates, timezone, desktop, electron, adr-009]
description: "The desktop app now starts the backend with APP_TIMEZONE set to the Mac's IANA zone, so the backend's 'today' matches the renderer's. Instants stay UTC; calendar days use one explicit zone. Three call sites that mixed zones are fixed."
aliases: [adr-264, desktop app timezone, system timezone]
related_code:
  [
    "packaging/electron/runtime/native.ts",
    "apps/node-backend/src/lib/timezone.ts",
    "apps/node-backend/src/services/portfolioPerformanceSnapshotService.ts",
    "apps/node-backend/src/services/reports/dataFetcherPortfolio.ts",
    "apps/node-backend/src/services/savedAnalysisService.ts",
  ]
---

# ADR-264: Desktop computes calendar days in the Mac's time zone

## Status

Accepted on 2026-11-03. Amends [[docs/adr/009-timezone-policy|ADR-009]] for the desktop app
only. Tor asked whether UTC everywhere would avoid the bugs; this ADR records why it would not.

## Context

- [[docs/adr/009-timezone-policy|ADR-009]] stores instants as UTC and computes calendar days
  in `APP_TIMEZONE` (default `Europe/Brussels`). It says deployers in another zone must set
  `APP_TIMEZONE`, but the desktop app had no way to do that.
- On a Mac in Helsinki the desktop therefore ran three clocks: the backend's business day
  (Brussels), the Node process and renderer (Helsinki), and PostgreSQL's `CURRENT_DATE` (the
  zone `initdb` chose). Every night from 00:00 to 01:00 the backend's "today" was one day behind
  the screen's. CI runs every clock in UTC, so it could not see this.
- A date sweep on 2026-11-03 found, among others: the portfolio report's valuation date was one
  day early on any host east of `APP_TIMEZONE`; the broker snapshot was dated by PostgreSQL's
  `CURRENT_DATE`, so after midnight it could overwrite the previous day's row; and a saved
  analysis defaulted `date_to` to the UTC day.

## Decision

- Instants stay UTC. Calendar days ("today", month and tax-year boundaries, report dates) are
  computed in one explicit zone through `lib/timezone.ts`.
- The desktop backend's `APP_TIMEZONE` is the Mac's IANA zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`). An `APP_TIMEZONE` in `runtime.env` still
  wins. If the host reports no valid zone, the backend keeps its `Europe/Brussels` default rather
  than refusing to start.
- Fixed call sites: the broker snapshot uses `todayAppDateString()`; the report valuation date
  reads the pg `DATE`'s own day (`toYmd`); saved-analysis defaults use the app-zone today and
  label results with `APP_TIMEZONE`.

## Alternatives

- **UTC for calendar days.** Rejected: the day would change at 02:00 or 03:00 Helsinki time, so
  today's transactions would count as yesterday after midnight, and 31 December evening
  activity could fall in the wrong tax year.
- **Fixed Europe/Brussels.** Rejected: it keeps the nightly split between backend and screen
  for anyone outside that zone.
- **A user setting.** Not needed now. `runtime.env` can pin a zone, and the system zone is what
  the screen already shows.

## Consequences

- On Tor's Mac, calendar days move from Brussels to Helsinki time, one hour earlier. Stored
  `DATE` values are unchanged; only the hour at which "today" turns over moves.
- Server deployments outside the desktop keep the ADR-009 default.
- SQL that still reads `CURRENT_DATE` follows the database zone; those uses are lower bounds with
  wide margins and are left as they are.
