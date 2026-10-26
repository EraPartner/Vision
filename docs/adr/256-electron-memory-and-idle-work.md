---
title: "ADR-256: Lighter Electron memory, boot bundle and idle renderer work"
type: adr
status: accepted
date: 2026-10-26
tags:
  [
    adr,
    performance,
    electron,
    memory,
    bundle,
    idle-cpu,
    react-query,
    macos,
    adr-075,
    adr-244,
  ]
description: "Accepted on 2026-10-26 by Tor (phases E and F of the Mac optimisation plan). One shared display probe replaces three 5 s polls and stops while hidden; the sidebar monitor badge polls every 5 min; research quotes stay fresh for one poll; renderer polls pause while the user is away; large list caches are collected after 2 min; V8 code cache from the first run; lucide icons leave the boot chunk; ledger overscan 10 to 6; a test guards against leftover pulse/spin; the Mac baseline measures idle renderer work and a background window. zod/mini and an API client split were measured and declined."
aliases: [adr-256, phase e, phase f, electron memory, idle cpu]
related_code:
  [
    "apps/frontend/src/lib/displayProbe.ts",
    "apps/frontend/src/hooks/useVisualEffectsTier.ts",
    "apps/frontend/src/hooks/useMonitors.ts",
    "apps/frontend/src/hooks/useMarketQuotesQuery.ts",
    "apps/frontend/src/lib/queryPolicies.ts",
    "apps/frontend/src/components/layout/ElectronBridge.tsx",
    "apps/frontend/src/components/shared/VirtualDataTable.tsx",
    "apps/frontend/vite.config.ts",
    "packaging/electron/main.ts",
    "packaging/electron/preload.ts",
    "packaging/electron/electron-api.d.ts",
    "scripts/mac-baseline.ts",
  ]
---

# ADR-256: Lighter Electron memory, boot bundle and idle renderer work

## Status

Accepted on 2026-10-26 by Tor ("do all the items that Fable found"; E1 and E5 deep refactor
skipped on a decision card). Phases E and F of the Mac optimisation plan. Phase D (GPU and
effects, ADR-255) is separate and not touched here. It refines the display re-check of
[[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075]].

## Date

2026-10-26

## Context

Phase 0 baseline on Tor's M1 Air (real app): renderer 100–107 MB after launch and 178–221 MB
after the 5-minute scroll and page-switch loop; GPU process 134–262 → 354–490 MB; main process
51–57 MB, flat. With the Admin Mode pulse fixed (#359), idle is 0.5–4.7% app CPU on reduced and
17–21% on standard (the aurora). A read-only review of `main` @ `0c76b17` found, in code:

- `useLargeDisplay` ran a 5 s poll (four property reads plus one IPC call and two state updates)
  per caller of `useVisualEffectsTier`. The shell has three callers (`ElectronBridge`,
  `VisualEffectsController`, `AppLayout`), so three polls ran, also while the window was hidden.
- The always-mounted sidebar monitor badge polled its inbox every 60 s.
- Research quote polls used `staleTime: 0` on the watchlist page, so the pages that share the key
  refetched on every visit.
- Interval polls kept running while the user was away from the Mac.
- `gcTime` was 5 min for every query, including ledger pages and chat history.
- The `icons` manual chunk put every lucide icon used anywhere into the boot preload graph.

## Decision

Frontend idle work (phase F):

- **F1, F2:** one shared display probe (`lib/displayProbe.ts`, `useSyncExternalStore`) serves
  every caller. It re-checks every 5 s while the window has focus, every 30 s while it is visible
  but not frontmost, and not at all while hidden. Focus, visibility and resize changes re-check at
  once. Behaviour: when Vision is not frontmost, a move to a large external display can take up to
  30 s to drop the tier (was 5 s).
- **F3:** the sidebar badge (`useMonitorInboxBadge`) polls every 5 min and refetches when the
  window becomes visible again. The monitors page keeps its 60 s poll, and monitor actions still
  invalidate the badge at once. Behaviour: a new notification found by a background check can take
  up to 5 min to show on the badge while the monitors page is closed.
- **F4:** research quotes are fresh for one poll period (60 s) by default.
- **F5:** main reports the user as away after 5 min without keyboard or mouse input, or when the
  screen locks (`powerMonitor.getSystemIdleState`, checked every 60 s, plus lock/unlock and resume
  events; new `app:user-idle` event). The renderer then sets React Query's `focusManager` to
  unfocused, which pauses interval polls; on return, focus tracking goes back to document
  visibility and queries that refetch on focus catch up. Unattended Mac baseline runs also count
  as "away" after 5 min, because scripted CDP input is not user input.
- **F6:** a shell test fails if a `animate-pulse` or `animate-spin` element is still rendered once
  every query has settled, the shape of the #359 launch burn.

Memory and bundle (phase E):

- **E2:** the main window uses `v8CacheOptions: "bypassHeatCheck"`, so V8 caches compiled code
  on the first run of a script instead of after it has run several times.
- **E3:** ledger pages, the account ledger and chat history use `gcTime` 2 min
  (`QUERY_GC_TIME_MS.LARGE_LIST`); everything else keeps 5 min. Behaviour: going back to one of
  those pages more than 2 min later shows the loading state instead of the old rows (they were
  refetched on return anyway, because they were stale after 30 s).
- **E4:** `lucide-react` no longer has a named chunk, so each icon ships with the chunk that uses
  it. Measured in the cloud build: boot preload graph 457.83 → 454.82 KB gz (−3.0 KB); all assets
  1259.09 → 1271.38 KB gz (+12.3 KB, spread over lazy route chunks) and 200 → 237 files.
- **E6:** `VirtualDataTable` overscan 10 → 6 rows beyond each edge.

Measurement (`scripts/mac-baseline.ts`): the idle window also records renderer
`Performance.getMetrics` deltas (script and task ms) and the number of page requests;
`--background <s>` measures the same page with Finder frontmost; the spread table adds idle
renderer CPU and script ms, background CPU, renderer and GPU memory after the sustained run, JS
heap used and DOM node count.

Declined (Tor, decision card): **E1** (`zod/mini` on the boot path) and **E5** (splitting the
`LanguageHydration` hub chunk). A source-map build showed 48 boot modules import `zod`, 30 of them
shared request/response contracts in `packages/types`, and the single `apiClient` pulls every
contract into the boot graph. Full zod is 93.5 KB raw in the `logger` chunk; the hub chunk is
mostly `tailwind-merge`, stores, the API client and contracts. Both would mean reworking every
API call and the shared contracts for an estimated 10–20 KB gz at boot, a few milliseconds of
parse time that E2's code cache mostly covers from the second launch.

## Consequences

- All gains except E4's bundle size are estimates until measured on the Mac with
  `bun scripts/mac-baseline.ts --repeat 3 --background 60` before and after.
- No functionality is removed. The visible behaviour changes are the slower display re-check while
  Vision is not frontmost (F2), the badge delay (F3), the loading state after 2 min (E3) and polls
  pausing while the user is away (F5).
- One new IPC event (`app:user-idle`); Electron isolation is unchanged (context isolation on, node
  integration off, sandbox on).
- No new CI job or step.
