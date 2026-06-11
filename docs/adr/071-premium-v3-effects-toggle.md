---
title: ADR-071 Premium v3 — Numbers, Chart Interactions, and the Enhanced-Effects Toggle
type: adr
status: Accepted
date: 2026-06-10
tags: [adr, design, frontend, charts, motion, webgl, performance, settings, june-2026]
description: Premium v3 batch — odometer numbers, Money typography, chart scrub/sync, large-title collapse, palette v2, workspace aurora, per-widget dashboard hydration, optimistic create, and a user-facing GPU effects toggle gating a WebGL shader aurora
aliases: [adr-071, premium v3, enhanced effects toggle, shader aurora]
---

# ADR-071: Premium v3 — Numbers, Chart Interactions, and the Enhanced-Effects Toggle

## Status
Accepted

## Date
2026-06-10

## Context

Follow-up to [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070]]. The user approved an 18-item batch with one hard constraint: GPU-intense visuals must sit behind an end-user toggle (the [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020]] Electron M1 history makes "always-on" unacceptable). Implementation log: `docs/sessions/2026-06-10-premium-v3-worklog.md`.

## Decision

### Numbers as the hero
- **`RollingNumber`** (`components/shared/`): odometer digit reels (per-digit 0-9 strips, em-based transforms, keyed from the right so digits keep identity across length changes); replaces count-up interpolation in StatCard/NetSummaryCard hero values. Reduced motion → plain span.
- **`Money`**: `Intl.NumberFormat.formatToParts`-based currency micro-typography (raised small symbol, de-emphasized decimals). Adopted in the transactions table and dashboard recent-transactions amount cells. Dashboard negatives now show an explicit "−" (was color-only — deliberate fix).
- **`DeltaPill`**: standardized tinted change chip (supports `invert` for spend-down-is-good); adopted in StatCard.

### Chart interactions (`components/charts/`)
- **Scrub-to-compare**: `scrub.tsx` (`useChartScrub` + `formatScrubDelta`) wired into AreaChart/LineChart behind a `scrubbable` prop — pointer-drag selects a range, shows a glass Δ pill (abs + %), suppresses the tooltip while scrubbing. Enabled on dashboard cash-flow/forecast/bank-balance charts, PerformancePage, NetWorthChart.
- **Synced crosshairs**: `ChartSyncContext.tsx`; charts sharing a `syncId` under one provider mirror hover (nearest point, with a domain guard so disjoint timelines don't pin to edges). Dashboard time-series share `syncId="dashboard-timeline"`. Categorical BarChart excluded.
- **Sweep reveal** on AreaChart (animated clipPath); **`ChartSkeleton`** ghost waveform replaces rectangle skeletons for charts.

### Navigation
- **Large-title collapse**: `PageTitleContext` — PageHeader registers its title; the topbar shows it (fade/slide) past 96px scroll.
- **Palette v2**: recents (localStorage `vision.palette.recents`, registered in `localStorage-keys.ts` and excluded from backups), debounced recipient search deep-linking to `/transactions?recipient_id=…&filter_label=…`, and a "search transactions for X" action (`/transactions?search=…`; TransactionsPage now seeds and syncs its search state from that param).
- **Shortcuts overlay** (`?` key) and **animated tab indicator** (tabs.tsx mirrors Radix's active value through context; framer `layoutId` pill per tablist).
- **Go-to key sequences** (`hooks/useGoToShortcuts.ts`): Gmail-style `g` + key navigation (g d dashboard, g t transactions, g s statistics, g c categories, g r recipients, g i import, g p portfolio, g n net worth, g a AI chat; 900 ms window, inert in text fields). The overlay lists these plus the pre-existing ⌘B sidebar toggle from `ui/sidebar.tsx`.
- **Apple conventions + in-UI learnability** (second review pass): `⌘,` opens Settings (the macOS standard; free in Electron, may be intercepted by some browsers). Shortcuts are taught where users already look: palette page items show their `G ·` sequence as `CommandShortcut` hints, the Settings action shows `⌘,`, a "Keyboard shortcuts" palette action (with `?` hint) opens the overlay, collapsed-sidebar tooltips read "Title · G T", and the topbar settings button title includes `⌘,`. The go-to route table is exported once (`GO_TO_ROUTES`) and consumed by the hook, palette, sidebar, and overlay so no surface can drift.
- **Donut center morph**: DonutChart's floating tooltip replaced by an in-hollow morph — hovering a slice lifts the arc (whileHover scale, fill-box origin) and crossfades the center to that slice's name + value; the default `center` content returns on leave. Reduced-motion renders without the transitions.

### Materials & atmosphere
- ~~Cursor specular sheen~~ — implemented, then **removed same-day at user request** (felt gimmicky in practice). The lensing edge shadows from ADR-070 are unaffected.
- **Workspace-aware aurora**: `data-workspace` on the liquid canvas swaps blob hue emphasis (budgeting emerald-led, portfolio gold-led).
- **Light mode "paper & ink"**: conservative token deltas (warmer paper background, deeper ink, embossed bottom hairline on `premium-frame`); `themes.ts` default-light palette kept mirrored.

### Enhanced-effects toggle (the GPU gate)
- New `AppSettings.enhancedEffects` (default **false**), Switch in Settings → General.
- Post-review fixes: `formatScrubDelta` strips signs that value formatters already emit (double "+" on relative-performance scrubs); shader fbm thresholds lowered into the noise's actual [0.3, 0.7] band (initial constants made the layer effectively invisible).
- When on, **`ShaderAurora`** (`components/layout/`) renders inside the liquid canvas: raw WebGL (no dependency), one fullscreen triangle, 4-octave value-noise fbm tinted from `--primary`/`--accent` (re-resolved on theme change via MutationObserver). Budget: 0.25× resolution upscaled, ~30 fps cap, single static frame under reduced motion, rAF-paused when hidden, and any WebGL failure silently leaves the CSS blobs (always rendered underneath) as fallback.

### Apple-behavior pass (third review pass, same day)
- **Undo + ⌘Z** (`lib/undo.ts`): transaction delete offers an 8-second undo via toast action and ⌘Z (inert in text fields); undo faithfully recreates the row from the cache snapshot, offered only when the create contract can be satisfied (`recipient_id`, date, account present).
- **Spotlight-style palette answers**: `100 USD in GBP` converts via the app's own FX data; charset-validated arithmetic evaluates inline; Enter copies the result.
- **`prefers-contrast: more`** support (stronger hairlines, 3px focus outline, aurora off) — completes the macOS a11y triad with the existing reduced-motion/reduced-transparency handling.
- **Window-state restoration**: last route persisted (`vision.lastRoute`, backup-excluded); fresh launches landing at `/` reopen where the user left off.
- **Topbar seam fix** (user-reported): the always-on `saturate()` backdrop-filter rendered the bar region brighter than the page at scroll-top while the veil was hidden; the filter is now gated on `data-scrolled` like the veil.
- Deferred to a focused session (worklog V5-V12): row context menus, Quick Look, arrow-key table nav, icon micro-bounce, stat scrubbing, genie close, suggestion card, and the Electron-native block (traffic lights, menu bar, dock badge/menu, CSV drag-import, vibrancy, system accent).

### Perceived speed
- **Per-widget dashboard hydration**: the all-queries loading gate in DashboardPage is gone; each section (stats, charts, recent table) renders its own skeleton keyed to its own query.
- **Optimistic create** (completes the ADR-070 mutation work): temp negative-id row inserted at the head of plain `['transactions']` caches, server row swapped in on success, rollback on error, `onSettled` invalidation restores true ordering/filtering. Virtual list still deliberately untouched. 6 tests total in `useOptimisticTransactions.test.tsx`.

## Consequences

- Default experience adds no meaningful GPU load (aurora hue swap is pure CSS); the shader is strictly opt-in and self-throttling.
- Optimistic-create rows briefly lack derived names (category/recipient) until the settled refetch; renderers already fall back. Row actions are valid immediately after success thanks to the temp→server id swap.
- tabs.tsx now intercepts `value`/`defaultValue`/`onValueChange` — new Tabs consumers must route through the wrapper (they already do).
- Verified: tsc clean, ESLint 0 errors, vitest 1417 pass (1 pre-existing `adminToken.test.ts` env failure), `validate-locales` clean. Packaged-Electron M1 profiling remains the outstanding gate before release (see ADR-070).

## Related
- [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070: Liquid Glass v2]]
- [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020: Glass System Downgrade]]
- [[docs/architecture/frontend-architecture|Frontend Architecture]]
- [[docs/adr/index|All ADRs]]

---

## Addendum — 2026-06-11: DeltaPill portfolio sweep complete (B3)

The "adopted in StatCard" scope noted in the Decision section above was the initial adoption. B3 of this batch — the portfolio DeltaPill sweep — was completed on 2026-06-11:

- **StocksPage** (`apps/frontend/src/pages/portfolio/StocksPage.tsx`): holdings-table unrealized-percent cell replaced with `DeltaPill` (value = `unrealizedPercent`, label via `fmtPct`).
- **CryptoPage** (`apps/frontend/src/pages/portfolio/CryptoPage.tsx`): holdings-table unrealized-percent cell replaced with `DeltaPill` (`h.gainLossPercent`).
- **RealEstatePage** (`apps/frontend/src/pages/portfolio/RealEstatePage.tsx`): two spots — (a) Total Return summary card ROI subtitle ("+x.x% Total ROI") replaced with `DeltaPill` + muted label; (b) each property card's "Total ROI" colored percent replaced with `DeltaPill`.

All ad-hoc green/red percent strings in the three portfolio pages are now standardised on the shared component.
