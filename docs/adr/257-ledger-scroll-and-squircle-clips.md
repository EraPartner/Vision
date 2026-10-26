---
title: "ADR-257: Cheaper ledger scroll, squircle clips and page transitions"
type: adr
status: accepted
date: 2026-10-26
tags: [adr, performance, gpu, compositing, react, macos, mac-optimisation, phase-g, adr-244, adr-255, adr-256]
description: "Phase G of the Mac optimisation plan (Tor picked G1-G4 and H1-H5 on 2026-10-26). AI chat notifies once per frame and renders only the transcript; analysis panels are memoised; the inspector no longer clips. Squircle boxes no longer clip composited content (ledger card, ticker, chart skeleton); the ledger renders less per scroll frame (memoised header, hoisted sort icon, one body context menu, row label once); the page transition keeps one layer; three diagnostic mac-baseline variants test why enhanced scrolls cheapest. No look change intended. Gains unmeasured until the Mac run."
aliases: [adr-257, phase g, squircle clip, ledger scroll]
related_code:
  [
    "apps/frontend/src/components/shared/VirtualDataTable.tsx",
    "apps/frontend/src/features/portfolio/PortfolioTicker.tsx",
    "apps/frontend/src/components/charts/ChartSkeleton.tsx",
    "apps/frontend/src/components/layout/PageTransition.tsx",
    "apps/frontend/src/lib/aiChatStreamStore.ts",
    "apps/frontend/src/pages/AIChatPage.tsx",
    "apps/frontend/src/pages/AnalysisWorkspacePage.tsx",
    "apps/frontend/src/components/ui/inspector.tsx",
    "scripts/mac-baseline-variants/no-backdrop.css",
    "scripts/mac-baseline-variants/corner-round.css",
    "scripts/mac-baseline-variants/vibrancy-on.js",
  ]
---

# ADR-257: Cheaper ledger scroll, squircle clips and page transitions

## Status

Accepted on 2026-10-26. Tor picked all four phase G proposals (G1 to G4) and then all five of the
second list (H1 to H5). H2 and H5 follow once PR #369 lands, because they change the same chart
files and measurement script. Not yet measured on the Mac; every gain below is an estimate.

## Context

Phases D (ADR-255, PR #369) and E/F (ADR-256, PR #372) are expected to change little. The
phase 0 baseline ([[docs/performance/mac-baseline]]) leaves two numbers unexplained: the ledger
scroll costs 4.4 to 5.4 W of GPU power on the reduced and standard tiers, and the enhanced tier,
which has the most effects, scrolls at about 2.1 W. A read-only review of the code and of
Chromium's compositor sources found four causes worth testing.

## Decision

1. **Squircles do not clip composited content (G1).** Every `Card` uses `corner-shape: squircle`
   (`corner-continuous`). When such a box also has `overflow: hidden` and its subtree contains a
   composited layer, Chromium cannot use its fast rounded-corner path. It draws the box into an
   extra surface through a mask layer on every frame (inference from Chromium's
   `paint_property_tree_builder.cc` and `property_tree_manager.cc`; unverified on Electron's
   build). The ledger host `Card` drops its clip (nothing inside reaches the corners), the
   portfolio ticker relies on its rectangular `.ticker-mask`, and `ChartSkeleton` clips its
   painted ghost with the squircle and its moving shimmer with a plain rounded box.
2. **Less React work per ledger scroll frame (G3).** The virtualizer re-renders the table on every
   scroll frame. The header row is memoised on its inputs, `SortIcon` moves to module level (a
   component defined in the render body remounted every frame), `getRowLabel` runs once per row,
   and one body-level `ContextMenu` replaces the Radix root that every row mounted. The host
   resolves the row from `data-index` on `contextmenu` (mouse, Ctrl-click, keyboard menu key) and
   on touch/pen long-press.
3. **One layer for page transitions (G4).** The route wrapper carries `will-change: opacity`, so
   Chromium does not promote and demote the whole page around each 520 ms entrance. A
   `transform` hint is avoided because it would contain the `position: fixed` chart tooltips.
   `will-change: opacity` alone does not make the wrapper a backdrop root: checked in Chromium
   153 (Playwright), where the blur behind a `backdrop-filter` box was pixel-identical with and
   without the hint.
4. **Diagnostics for the enhanced-is-cheapest gap (G2).** Three `mac-baseline --variant` files:
   `no-backdrop.css` (look change, diagnostic only), `corner-round.css` (look change, diagnostic
   only) and `vibrancy-on.js` (native vibrancy on any tier with an opaque body). They need the
   `--variant` support from ADR-255. A product change follows only if the numbers support one.

5. **AI chat streaming renders only the transcript (H1).** `aiChatStreamStore` still writes each
   token immediately but notifies listeners at most once per animation frame; every other event
   notifies synchronously and flushes a pending frame. `useSendChatMessage` returns only values
   that are stable between tokens; `useChatStream` (used by `LiveChatMessageList`) carries the
   full state. The composer, conversation list, investigation panel and Ollama banner are
   memoised, and auto-scroll skips `scrollTo` when the view is already at the bottom. Assistant
   and tool bubbles drop their own backdrop filter (`chat-bubble-flat`): they sit inside the
   already-blurred transcript card, so each was one more render surface for a near-invisible
   difference. Approved by Tor as part of H1; a look check on the Mac is still due.
6. **Analysis workspace panels re-render only on their own inputs (H3).** The four panels are
   memoised and `AnalysisWorkspacePage` passes stable props (memoised derived objects, callback
   handlers); the field list filters against `useDeferredValue(fieldSearch)`.
7. **The docked inspector does not clip (H4).** Same mechanism as G1: its body scroller clips
   itself and the header and footer have no fill. Dialogs keep their clip: their content is the
   scroller and 46 call sites override its layout classes, so moving the clip inward is not a
   safe mechanical change; a scrollable dialog is also short-lived.

## Consequences

- The only intended look change is H1's bubbles (no nested blur). The ledger menu now stays open if its row scrolls out of the virtual
  window (before, the row's menu unmounted with the row); it closes when the row leaves the data.
- The search suggestions slot of `VirtualDataTable` is no longer clipped by the card. No caller
  uses it today.
- Rejected: moving card blur to a pseudo-element, saturating the aurora canvas instead of cards,
  and smaller per-frame items (see the proposal list in the project files,
  `mac-optimisation/2026-10-26-phase-g-proposals.md`).
