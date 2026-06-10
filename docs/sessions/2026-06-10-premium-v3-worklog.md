---
title: Premium v3 Worklog — continuation log for agents
type: session-worklog
date: 2026-06-10
tags: [session, worklog, frontend, premium-v3, implementation-complete]
description: Live implementation log for the Premium v3 batch (18 items). THE authoritative state if a session/context ends mid-work — read this first, then continue from the first unchecked item.
---

# Premium v3 Worklog (2026-06-10)

> [!important] For the next agent
> This file is the **authoritative continuation log** for the "Premium v3" UI batch.
> User instruction: implement ALL 18 items below; GPU-intense effects must sit
> **behind a user-facing toggle** (default off/standard). Update this file as you work
> (mark items, note file paths + gotchas). Baseline before this batch: commit
> `b5f8054e` (Liquid Glass v2, ADR-070) — all v2 context is in that ADR.
> Verify each phase: `bun run typecheck` + targeted vitest; full
> `lint`/`test`/`validate-locales` at the end. KB update via `vision-kb-updater`
> subagent + session note + (likely ADR-071 for the effects toggle) when done.
> User has NOT asked to commit this batch yet.

## Status legend
- [ ] not started · [/] in progress · [x] done (with file refs)

## Phase A — Infrastructure
- [x] A1. This worklog file
- [x] A2. Memory pointer (memory/premium-v3-batch.md + MEMORY.md index line) in `~/.claude/.../memory/` (MEMORY.md index + premium-v3 entry)
- [x] A3. Toggle done: `enhancedEffects: boolean` in stores/settingsStore.ts (AppSettings + default false), Switch in settings/tabs/GeneralTab.tsx (id=enhanced-effects). i18n keys settings.general.enhancedEffects(+Hint) still pending G1. "Enhanced visual effects" user toggle: app setting (`AppSettingsContext` — find storage shape), Appearance/General tab UI in `DashboardSettingsDialog`, i18n keys. Gate = shader aurora (E3). Default OFF.

## Phase B — Numbers as the hero
- [x] B1. DONE — components/shared/RollingNumber.tsx (reels keyed from right, roll-in on mount via rAF settled state, reduced-motion → plain span); adopted in StatCard + NetSummaryCard hero numbers; useCountUp no longer used there (hook kept). — odometer digit reels (per-digit vertical strips, translateY in em units, transition per digit, non-digits static, `aria-label` on parent + `aria-hidden` reels, reduced-motion → plain span). Replace `useCountUp` display in `StatCard` + `NetSummaryCard` hero numbers (keep `useCountUp` hook itself — other consumers may exist).
- [x] B2. DONE — components/shared/Money.tsx (formatToParts); adopted: TransactionsTable amount cell, DashboardPage recent-tx amount cell (NOTE: dashboard negatives now show explicit '-' prefix — was missing before, deliberate fix). NOT adopted: NetSummaryCard income/spending sub-stats (compact format conflicts with decimals treatment) + portfolio pages (sweep later). — `Intl.NumberFormat.formatToParts` based: currency symbol ~0.65em raised, fraction+separator ~0.7em/70% opacity. Adopt in: Dashboard recent-transactions amount column (DashboardPage `columns`), NetSummaryCard income/spending sub-stats, transactions table amount cell (find renderer — likely `useDataTableColumns.ts` or VirtualDataTable column defs). Log un-adopted surfaces here.
- [/] B3. components/shared/DeltaPill.tsx created + adopted in StatCard change prop. Portfolio colored-delta sweep NOT done (StocksPage/CryptoPage/RealEstatePage) — optional polish, low priority. — tinted pill (success/destructive/muted) + direction arrow. Adopt in StatCard `change` prop; scan portfolio summary cards for colored-delta text to convert (StocksPage/CryptoPage/RealEstatePage "+x%" spots).

## Phase C — Charts (components/charts/*)
- [x] C1. DONE — clip-path sweep reveal added to AreaChart (motion.rect in defs clipPath wrapping series group); LineChart kept its fade (sweep on Area only — Line's per-series fade reads fine). Orig: Draw-in entrances: shared reveal (clip-path inset sweep via framer, once on mount, reduced-motion skip) applied in AreaChart + LineChart (+ BarChart if trivial).
- [x] C2. DONE — useChartScrub + formatScrubDelta in components/charts/scrub.tsx; wired into AreaChart + LineChart behind `scrubbable` prop (pointer capture, range band rect, glass delta pill div, tooltip suppressed during scrub). Enabled on: CashFlowComparisonChart, ForecastInner(+Rolling), BankBalancesWidget, PerformancePage (2x), NetWorthChart. Orig: Scrub-to-compare on AreaChart/LineChart: pointer-drag range → glass delta pill (Δ abs + %), uses existing ChartTooltip styling conventions. Desktop+touch via pointer events.
- [x] C3. DONE — components/charts/ChartSyncContext.tsx (ChartSyncProvider + useChartSync); `syncId` prop on AreaChart/LineChart with domain guard (no edge-pinning across disjoint timelines); dashboard charts share syncId="dashboard-timeline"; ChartSyncProvider wraps DashboardPage. BarChart (MonthlyTrends) NOT synced — categorical band scale, out of scope. Orig: Synced crosshairs: `ChartSyncContext` (hovered x-key publish/subscribe); opt-in `syncId` prop on time-series charts; wire MonthlyTrendsChart + CashFlowForecastChart/ComparisonChart on Dashboard.
- [x] C4. DONE — components/charts/ChartSkeleton.tsx (ghost waveform + shimmer). Adoption into DashboardPage skeletons happens with F1. Orig: `components/charts/ChartSkeleton.tsx` — ghost sparkline waveform + shimmer; use in DashboardPage skeletons (replace plain rect Skeletons for charts) + StatisticsPage if trivial.

## Phase D — Navigation & structure
- [x] D1. DONE — contexts/PageTitleContext.tsx; PageHeader registers title; AppLayout TopbarPageTitle shows it at scrollY>96 (separate titleVisible state). Orig: Large-title collapse: `PageTitleContext` (PageHeader registers title; AppLayout topbar shows it, fade/slide, when `scrolled` past ~64px). Topbar already has `data-scrolled` plumbing from v2.
- [x] D2. DONE — palette v2: recents (LOCAL_STORAGE_KEYS.PALETTE_RECENTS='vision.palette.recents', registered + in EXCLUDED backup list), recipient search (getRecipients debounced 250ms, ≥2 chars, deep-links /transactions?recipient_id&filter_label), 'search transactions for X' action (/transactions?search=; TransactionsPage now seeds+syncs search state from the param). Orig: Command palette v2 (`components/shared/CommandPalette.tsx`): (a) recents — track last ~5 visited routes in localStorage (register key in localStorage-keys excluded list if such test exists — check `lib/` for the registry the admin-token memory mentions); (b) recipient fuzzy search — debounced `apiClient` recipients search when query ≥2 chars, navigate to recipients page (check if it supports a search param; wire if trivial); (c) "Search transactions for X" action → `/transactions?search=X` (check TransactionsPage reads it; wire if needed).
- [x] D3. DONE — components/shared/ShortcutsOverlay.tsx ('?' key, glass dialog, lists ⌘K/?/Esc + chart-scrub hint); mounted in AppLayout. i18n keys pending G1: shortcuts.title/showHelp/closeDialog/chartScrub + commandPalette.recent/searchTransactions. Orig: Shortcuts overlay: `?` (when not in input/textarea/contenteditable) opens glass dialog listing real shortcuts (⌘K, ?, Esc). i18n.
- [x] D4. DONE — ui/tabs.tsx rewritten: Tabs mirrors active value via context (controlled+uncontrolled), TabsTrigger renders layoutId pill (per-instance useId), static active bg/ring removed in favor of pill. Orig: Animated tab indicator in `components/ui/tabs.tsx`: mirror active value via context (intercept value/defaultValue/onValueChange on Root), motion.span `layoutId` scoped per-TabsList via `useId`.

## Phase E — Materials & atmosphere v3
- [x] E1. DONE then REVERTED 2026-06-10 evening at user request (didn't like the cursor shine) — .specular CSS, lib/specular.ts, and card wiring all removed. Orig: Cursor-tracking specular on hero glass cards: `--mx/--my` CSS vars set on pointermove (rAF-throttled), `.specular::after` radial highlight; apply to StatCard + NetSummaryCard; CSS in index.css under `@media (hover: hover)` + reduced-motion off.
- [x] E2. DONE — data-workspace on .liquid-canvas (AppLayout, useWorkspace is route-derived, no provider needed); CSS swaps blob hues for portfolio. Orig: Data-aware aurora: workspace-driven hue — AppLayout reads `useWorkspace()`, sets `data-workspace` on `.liquid-canvas`; CSS swaps blob hue emphasis (portfolio = gold-led, budgeting = emerald-led). (Net-worth-trend tint = deferred, logged below.)
- [x] E3. DONE — components/layout/ShaderAurora.tsx (raw WebGL, fbm, 0.25x res, 30fps cap, theme colors via MutationObserver, reduced-motion = 1 static frame, failure → CSS blobs remain); rendered in AppLayout only when appSettings.enhancedEffects. Orig: Shader aurora behind A3 toggle: `components/layout/ShaderAurora.tsx` — raw WebGL (no deps), 1 fullscreen quad, fbm/simplex noise blending two hues read from CSS vars (--primary/--accent resolved to rgb at mount + on theme change), renders at ~0.25× resolution upscaled, ~30fps cap, pauses on `document.hidden` + reduced-motion, context-loss + creation-failure → fallback to CSS blobs. Replaces CSS blobs only when toggle ON.
- [x] E4. DONE — tokens.css light block (paper bg 40 36% 96%, ink fg, border/muted warmed) + premium-frame bottom hairline emboss; styles/themes.ts defaultLight re-mirrored (themes.test.ts 4/4 green). Orig: Light-mode paper & ink pass (tokens.css + index.css, light only): warmer ivory bg, ink-density headings, embossed card edge (inset top highlight + hairline bottom), keep WCAG AA — conservative deltas only.

## Phase F — Perceived speed
- [x] F1. DONE — DashboardPage loading gate removed; per-widget skeletons (statSkeleton/recentSkeleton consts + ChartSkeleton cards); error-banner + exclusion logic untouched. Orig: Per-widget dashboard hydration: remove the all-queries loading gate in DashboardPage; per-section skeletons (stat grid, bank balances, charts, recent table) keyed to their own query loading states. Careful: preserve exclusion-toggle logic and partial-error banner behavior.
- [x] F2. DONE via existing entrance system — widgets mount inside animate-stagger/framer draw-ins when replacing skeletons; no extra wrapper needed. Orig: Skeleton→content crossfade: small `FadeIn` mount wrapper (or `animate-in` class) on each dashboard widget's content when it replaces a skeleton.
- [x] F3. DONE — useCreateTransaction optimistic (temp -Date.now() id, head insert, onSuccess temp→server swap, rollback, onSettled invalidate); 2 new tests (6 total) green. Orig: Optimistic create (extend `hooks/useTransactions.ts` useCreateTransaction): onMutate insert temp row (`id: -Date.now()`) at head of `['transactions']` plain caches only (NOT virtual — see ADR-070 rationale), onSuccess swap temp→server row, onError remove+rollback, onSettled invalidate (fixes ordering/filters). Extend `useOptimisticTransactions.test.tsx`.

## Phase G — Wrap-up
- [x] G1. DONE — 8 keys added en+nl (settings.general.enhancedEffects[Hint], shortcuts.*, commandPalette.recent/searchTransactions); generate+validate clean (2854 keys). Orig: i18n: collect ALL new keys (settings toggle, shortcuts overlay, palette v2 groups/actions) → `i18n/source/en.json`+`nl.json` (flat, alphabetical, 2-space indent) → `bun run generate-locales` + `validate-locales`.
- [x] G2. DONE — tsc 0 errors, eslint 0 errors (warnings pre-existing/coverage), vitest 1417 pass + known adminToken env failure. Orig: Verify: `bun run typecheck`, `bun run lint`, `bun vitest run` (frontend). Known pre-existing failure: `adminToken.test.ts` (env issue, fails on clean tree — ignore).
- [x] G3. DONE — KB synced. Files changed: docs/adr/index.md, docs/architecture/frontend-architecture.md, docs/components/ui-components.md, docs/components/charts.md, docs/components/dashboard.md, docs/components/hooks.md, docs/features/transactions.md, docs/features/appearance.md, docs/features/backup-coverage-audit.md, docs/i18n/translations.md, docs/index.md, docs/diagrams/frontend-component-structure.puml, docs/reference/code-patterns.md. Orig: ADR-071 (effects toggle + premium v3 summary), KB sync via `vision-kb-updater` subagent, update this file + session note.
- [x] G4. DONE — memory updated (premium-v3-batch.md: implemented, not committed). Orig: Update memory (premium-v3 status). Do NOT commit unless user asks.

## Deferred / explicitly out of scope this batch
- Net-worth-trend aurora tint (data coupling into shell — wants its own design).
- Money component adoption beyond the surfaces listed in B2 (sweep later).
- prefers-contrast / density toggle / mobile bottom-bar (from brainstorm, not in the 18).

## Gotchas already known (from v2 session — don't relearn)
- Tailwind v4: translate utilities use the standalone `translate` property; keyframes may animate `transform` freely without breaking centering.
- Custom `@layer utilities` classes in index.css come AFTER generated utilities → their `background` shorthand beats `bg-*` utilities. Don't stack opaque surface classes on glass classes.
- `['transactions-virtual']` cache must never be optimistically patched (hook mirrors first page into local state; scrolled list collapses).
- i18n source JSONs: flat, alphabetical, 2-space indent, trailing newline; edit via python json (sort_keys), keep diff minimal.
- ADR-020 history: Electron M1 GPU jank is why effects must stay budgeted; shader aurora MUST default off.
- Edit tool requires Read on files first (Bash `cat` doesn't count).

## Premium v4 candidates (scan done 2026-06-10 evening — user asked for "another pass")

Prioritized; none started. Next agent: confirm with user before implementing.

1. **Donut/Pie selection morph** — clicking a slice animates the center label/value (springs); CategoryPieChart + portfolio allocation donuts. Medium effort, high demo value.
2. **`n` quick-create shortcut** — `n` (or `g x`) opens the Add Transaction dialog from anywhere: needs `/transactions?new=1` param + TransactionsPage dialog-open wiring; pairs with optimistic create. Small functionality add.
3. **Empty-state sweep (T15 completion)** — adopt the upgraded EmptyState across all pages' ad-hoc empty divs (grep `py-16 text-center` + table.noData paths).
4. **Portfolio DeltaPill sweep (B3 completion)** — StocksPage/CryptoPage/RealEstatePage colored "+x%" texts → DeltaPill(invert-aware).
5. **Sheet/drawer spring polish** — sheet.tsx still uses default shadcn slide; give it the dialog treatment (overshoot bezier, glass-thick already?) — check first.
6. **Sticky table headers with glass** — DataTable/VirtualDataTable header rows get glass-thin + shadow on scroll within their scroll containers.
7. **Number transitions on filter changes** — totals in table footers/summaries use RollingNumber.
8. **View Transitions for in-page filter swaps** — startViewTransition around table filter changes (progressive).
9. **Onboarding wizard cinematic pass** — glass panels + staggered steps + aurora intro.
10. **Shader aurora visual iteration** — user must eyeball current constants (tuned blind: smoothstep 0.34-0.68/0.38-0.72, alpha 0.65, opacity 60/80%); consider exposing intensity sub-setting if still too subtle/strong.

Also outstanding: packaged-Electron M1 profiling, e2e visual snapshot regen (`bun run test:e2e:visual` needs running stack).

## Review pass 2 (2026-06-10 late) — Apple-native + learnable shortcuts, donut morph

- ⌘, opens Settings (AppLayout listener); settings button title shows it.
- Learnability: palette items show G-sequences via CommandShortcut (GoToHint, GO_TO_BY_URL map), settings action shows ⌘,, new "Keyboard shortcuts" palette action opens overlay (state lifted to AppLayout; ShortcutsOverlay now controlled via props), sidebar tooltips append " · G T" (withGoToHint in AppSidebar), overlay lists ⌘, row.
- DonutChart: floating ChartTooltip REMOVED; in-hollow center morph (AnimatePresence crossfade, hovered slice name + dot + value) + arc whileHover lift (transformBox fill-box). Hover color resolved from palette at arc level.
- Verified: tsc clean, lint 0 errors, component tests 300 pass. Committed.
- Still open from v4 list: items 2-9 (n quick-create, empty-state sweep, portfolio DeltaPill, sticky glass headers, sheet polish, onboarding pass) + shader visual iteration by user + M1 profiling + e2e snapshots.
