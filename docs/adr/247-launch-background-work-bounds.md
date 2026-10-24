---
title: "ADR-247: Bound and defer background work after launch"
type: adr
status: accepted
date: 2026-10-24
tags: [adr, performance, macos, startup, prices, insights, electron, watchdog]
description: "Accepted on 2026-10-24. Phase A of the Mac optimisation plan. The insights count stops reporting pending after 30 s, every yahoo-finance2 request gets a 15 s timeout, the startup quote backfill and live-price refresh start 20 s after boot, and the Electron health watchdog probes every 30 s while healthy (10 s after a failure)."
aliases: [adr-247, launch burn, startup price delay, insights pending limit, watchdog cadence]
related_code:
  [
    "apps/node-backend/src/services/insightsDigestService.ts",
    "apps/node-backend/src/services/prices/yahooClient.ts",
    "apps/node-backend/src/startup/warmup.ts",
    "packaging/electron/main.ts",
    "scripts/lib/mac-baseline/launchProbe.ts",
  ]
---

# ADR-247: Bound and defer background work after launch

## Status

Accepted on 2026-10-24. Changes the watchdog interval described in
[[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022]]; the rest of ADR-022 stands.

## Date

2026-10-24

## Context

The phase 0 Mac baseline ([[docs/performance/mac-baseline|Mac performance baseline]]) found that
the real app, on the reduced and standard tiers, kept the GPU about 80% busy from first paint
until the first interaction, while Vision Demo idled at about 1%. The backend used under 1% CPU
and PostgreSQL about 0% during that time, so the cost was a page animation, not backend work.
Every loading surface uses the endless `animate-shimmer` animation.

Two backend paths can keep a load pending on real data but not in Demo:

- `GET /api/info/insights-count` answers `pending` while a background recount runs, and the
  sidebar badge polls every 2 s while it sees `pending`. The recount had no time limit, and the
  stored count expires after 3 minutes, so most launches start with a recount.
- yahoo-finance2 sets no request timeout, so a stalled Yahoo connection could hold the startup
  quote backfill and live-price refresh open for as long as the connection stays open. Demo
  holdings use manual prices and skip these calls.

Whether either path causes the burn is not yet measured; `--launch-probe` in
`scripts/mac-baseline.ts` records the running animations and page requests after launch to find
out.

## Decision

1. While a background insights recount has been running for more than 30 s,
   `getInsightsCount()` answers `unavailable` instead of `pending`. The badge then polls every
   60 s instead of every 2 s. The recount keeps running and is never started twice; a recount
   slower than 30 s is logged.
2. The shared yahoo-finance2 client uses a `fetch` with a 15 s timeout per request
   (`YAHOO_FETCH_TIMEOUT_MS`), keeping any signal the caller passes. A timed-out request fails like
   any other Yahoo error, so callers fall back to stored prices as before.
3. The startup historical quote backfill and live-price refresh start 20 s after boot
   (`STARTUP_PRICE_REFRESH_DELAY_MS`) instead of at once. The Dashboard reads stored prices, so
   it does not wait for them. The timer is cleared on shutdown. FX warm-up, the FX backfill and
   the snapshot chain are unchanged.
4. The Electron health watchdog probes `GET /health` every 30 s while the backend is healthy and
   every 10 s after a failed probe. Three failures still report `backend:lost`, now after about
   50 s at worst instead of about 30 s.

## Consequences

- No functionality is removed. Badge counts, prices, and the lost-backend banner behave as
  before, with the timing changes above.
- Right after launch, investment prices are the stored ones for about 20 s longer.
- A backend that dies is reported up to about 20 s later than before.
- Page-side causes (the shimmer has no tier gate and no limit; the background-query bar animates
  for every refetch) belong to phase F of the plan and are not changed here.

## Related

- [[docs/adr/244-full-effects-switch|ADR-244]]
- [[docs/adr/index|All ADRs]]
