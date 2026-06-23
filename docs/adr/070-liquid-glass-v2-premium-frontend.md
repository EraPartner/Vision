---
title: ADR-070 Liquid Glass v2 — Premium Frontend Overhaul
type: adr
status: Accepted
date: 2026-06-10
tags: [adr, design, frontend, aesthetic, glass, motion, command-palette, optimistic-updates, performance, june-2026]
description: Restores and completes the ADR-017 liquid-glass system — atmosphere layer, saturated materials, motion choreography, cross-page consistency, command palette, and optimistic transaction mutations
aliases: [adr-070, liquid glass v2, premium frontend]
---

# ADR-070: Liquid Glass v2 — Premium Frontend Overhaul

## Status
Accepted

## Date
2026-06-10

## Context

[[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017]] established the liquid-glass design system (April 2026). [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020]] then deliberately downgraded it the same month after Electron M1 GPU regressions: liquid-canvas and PageTransition removed, `saturate()` dropped, blur capped at ≤12px, glass stripped from dense surfaces. That fixed the jank but left the aesthetic in a halfway state a June 2026 review found wanting:

- With **no atmosphere layer**, `backdrop-filter` had nothing to blur, so the remaining glass materials read as tinted cards.
- `--glass-saturate` was declared but **never applied**; blur tiers (6–12px) were far below Apple-material territory.
- **framer-motion survived only in chart components**; dialogs used CSS zoom/fade, and the v3-era shadcn `slide-in-from-left-1/2` recipe actually double-offset under Tailwind v4's standalone `translate` property.
- **~45 KPI/chart cards** stacked `liquid-glass-hero surface-elevated bg-gradient-to-br …` — `surface-elevated`'s opaque `background` shorthand (later in the cascade) silently defeated both glass and tint.
- `cmdk` was installed with a complete `command.tsx` primitive but **no palette was wired**.
- Optimistic updates (T14b) and empty-state standardization (T15) had been deferred from the May 2026 initiative.

## Decision

**Partially supersedes ADR-020.** The premium layer returns, but with the GPU budget ADR-020 fought for built in — the difference from the original Phase 9 implementation is *bounded scope*, not lower ambition:

- ADR-020's core rule **survives**: dense surfaces (Card default, Input, Textarea, Select, tables, toggles, buttons) stay opaque/near-opaque — glass applies only to KPI/hero/chart cards, overlays, and chrome (~6 backdrop surfaces per viewport).
- The aurora canvas animates **transform only** on two fixed compositor layers (unlike the removed `liquid-drift`, which animated background gradients and forced repaints); it pauses under `prefers-reduced-motion`.
- PageTransition returns **enter-only** (no exit springs, no AnimatePresence double-render).
- `saturate()` returns, but on the bounded surface count above.

If Electron M1 profiling shows regression, the first lever is reducing aurora size/alpha, then blur tiers — not removing the layer (see Consequences).

Five-tier overhaul, dark-theme-first with light fully supported, all functionality retained:

### Tier 1 — Atmosphere + materials
- **Liquid canvas v2** (`AppLayout`): one `position: fixed; z-index: -1` layer with two slow-drifting aurora blobs (compositor-only `transform` animations, 64s/76s alternate) over a static radial wash, plus an SVG `feTurbulence` film-grain child. Colors derive from `--primary`/`--accent`, so all five theme variants in `styles/themes.ts` work without palette changes. Per-mode alphas via new `--aurora-*-alpha` / `--grain-alpha` tokens (dark is more luminous).
- **Materials rewired**: `backdrop-filter` now includes `saturate(var(--glass-saturate))` (light 180%, dark 150%); blur tiers raised to 12/20/24/28/32px (thin/regular/chrome/thick/elevated); thick + elevated materials gained lensing edges (inset top specular, bottom concave shade, long soft drop shadow).
- **A11y correction**: stripping `backdrop-filter` moved from `prefers-reduced-motion` (wrong — blur is static) to `prefers-reduced-transparency`, with near-opaque fallbacks; aurora drift pauses under reduced motion.

### Tier 2 — Motion choreography
- `PageTransition` (new, `components/layout/`): enter-only spring keyed on pathname — deliberately no `AnimatePresence` exit, which double-renders Suspense boundaries around lazy routes.
- Route-chunk loading: `PageLoader` spinner replaced with a 2px top hairline shimmer (no content-area flash).
- Dialog/alert-dialog enter/exit rebuilt as `dialog-in`/`dialog-out` keyframes with an overshooting bezier (`cubic-bezier(0.34, 1.45, 0.64, 1)`) — spring feel without JS, and fixes the v4 `translate`-property double-offset glitch. `motion-reduce` disables both.
- CSS stagger extended from 8 to 12 children.

### Tier 3 — Consistency rollout
- The `surface-elevated … bg-card backdrop-blur-sm` class soup replaced with `glass-regular` (KPI/chart cards) or `glass-elevated` (dashboard hero cards, with trend tint moved to an overlay child so it survives the cascade). **Tables stay opaque** (`DataTable`/`VirtualDataTable`/Watchlist grid) — deliberate perf budget: ~6 backdrop-filter surfaces per viewport.
- `premium-frame` is now baked into the base `Card`, so the primary-tinted hover outline is universal (previously only pages that added the class got it — e.g. dashboard yes, portfolio overview no). `premium-frame` and `micro-lift` declare identical full `transition` lists (border-color, box-shadow, transform) so whichever wins the cascade still animates all three.
- `EmptyState` upgraded (glass icon tile over a blurred brand glow, display-serif title); toasts moved to `glass-thick`; AI-chat panes converted to `glass-regular`.

### Tier 4 — Signature moments
- **⌘K command palette** (`components/shared/CommandPalette.tsx`): all pages of both workspaces + admin (when enabled), theme and settings actions; jumps sync the sidebar workspace. Topbar trigger button with `⌘K` kbd hint; 5 new i18n keys (en/nl).
- **Sidebar magic-move**: the active-route accent rail is now a framer `layoutId` element that glides between nav items (`springs.snappy`, instant under reduced motion).
- **Theme crossfade**: `ThemeContext` wraps the dark-class flip in `document.startViewTransition` where supported.
- **Scroll-linked topbar**: material moved to an `::before` that fades with a `data-scrolled` attribute (gradients can't transition), passive scroll listener.

### Tier 5 — Perceived performance
- **Optimistic transaction update/delete** (closes T14b): snapshot-all → patch-all → rollback-on-error via `setQueriesData` across all `['transactions', params]` caches, `onSettled` invalidation so server truth always wins. **`['transactions-virtual']` is deliberately not patched** — `useTransactionListData` mirrors its cached first page into local state and a scrolled list would collapse. `tags` excluded from the merge (payload `string[]` vs cached `Tag[]`). 4 new tests in `useOptimisticTransactions.test.tsx`.
- **Route-chunk hover prefetch**: `lib/routePreload.ts` holds the route→`import()` map; `App.tsx` `lazy()` calls and `AppSidebar` hover share it (dedup set, errors fall through to the lazy path).

## Consequences

### Positive
- Glass finally reads as glass — there is content behind it to refract; dark mode is the showcase.
- Single material vocabulary across all ~28 pages; the cascade-conflict class soup is gone.
- Navigation feels instant: hover-warmed chunks, enter-only page springs, optimistic money rows with provable rollback.
- All five theme variants inherit the atmosphere automatically (no `themes.ts` changes needed).

### Negative / Trade-offs
- Stronger blur+saturate raises GPU cost per glass surface — mitigated by the opaque-dense-surface rule and per-viewport budget. **Watchpoint: the packaged Electron app on Apple Silicon is the environment that triggered ADR-020.** Verified responsive in dev by the user; profile the packaged app before release and de-scope via aurora alpha → blur tiers if needed.
- Optimistic update can briefly show a stale `category_name`/`recipient_name` when only the id changed (corrected by the settled refetch); amounts always come from user input, never derived.
- E2E visual snapshots (`e2e/visual.spec.ts`) need regeneration; build + on-stack visual verification were deferred at the user's request.

### Verification
`tsc` clean (app + node configs) · ESLint 0 errors (9 pre-existing warnings) · vitest 1415 passed, 1 pre-existing environment failure (`adminToken.test.ts`, fails on the unmodified tree too) · `validate-locales` clean.

## Related
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]] (extended)
- [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020: Glass System Downgrade]] (partially superseded — atmosphere, transitions, and saturate restored under a bounded GPU budget; the opaque-dense-surface rule is retained)
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]]
- [[docs/adr/047-tailwind-v4-migration-dependency-upgrades|ADR-047: Tailwind v4 Migration]]
- [[docs/architecture/frontend-architecture|Frontend Architecture]]
- [[docs/adr/index|All ADRs]]
