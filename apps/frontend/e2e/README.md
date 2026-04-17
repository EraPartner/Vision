---
title: Phase 2 visual parity harness
type: guide
tags: [testing, playwright, phase-2]
description: Screenshot-baseline workflow for the Phase 2 Dashboard/Statistics rewrite.
---

# Phase 2 visual parity harness

Minimal Playwright scaffold locking Dashboard + Statistics page renders before the
Phase 2 rewrite (delete `statisticsProcessing.ts` + split pages into
`features/dashboard/sections/*`). Assertions diff current render vs committed
`.png` baselines.

## One-time setup

```sh
bun add -D -W @playwright/test
bunx playwright install chromium
```

## Capture baseline (before rewrite)

Terminal 1 — dev stack (must use live DB with representative data):

```sh
bun run dev
```

Terminal 2 — write baselines:

```sh
bun run e2e:update
```

This writes `.png` snapshots next to each spec under
`apps/frontend/e2e/*-snapshots/`. Commit them.

## Verify after rewrite

```sh
bun run e2e
```

Fails if any page diffs > `maxDiffPixelRatio: 0.002` or
`maxDiffPixels: 100`. Tuned for font-AA noise only; any real UI regression
will trip the threshold.

## Scope

- **In scope:** Dashboard (`/dashboard`), Statistics (`/statistics`) — the two
  surfaces consuming the legacy `processTransactions` pipeline.
- **Out of scope:** all other pages (untouched by Phase 2), CI integration
  (baseline depends on local DB), numeric parity (covered by Phase 8
  shadow-mode diff of `/api/info/*` vs `/api/aggregations/*`).

## When the diff is intentional

Document the visual change in the phase commit body, then:

```sh
bun run e2e:update
```

Re-commit the updated `.png`. Never suppress failures with `--update-snapshots`
silently.
