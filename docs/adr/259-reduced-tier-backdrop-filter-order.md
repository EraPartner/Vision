---
title: "ADR-259: Reduced tier really turns glass filters off"
type: adr
status: accepted
date: 2026-10-27
tags: [adr, performance, gpu, css, glass, fx-reduced, reduced-transparency, macos, mac-optimisation, phase-g, adr-075, adr-255, adr-257]
description: "The reduced tier, prefers-reduced-transparency and print declared `backdrop-filter: none` before `-webkit-backdrop-filter: none`. The CSS minifier keeps only the last of the pair and Chromium ignores the prefixed one, so on those paths every card, the sidebar rail and the top bar kept their saturate or blur filter under an opaque fill. The pair is reordered and a contract test guards it. Found in the phase G Mac run."
aliases: [adr-259, reduced tier filter, backdrop-filter order]
related_code:
  [
    "apps/frontend/src/index.css",
    "apps/frontend/src/components/ui/__tests__/backdrop-filter-order.test.ts",
  ]
---

# ADR-259: Reduced tier really turns glass filters off

## Status

Accepted on 2026-10-27. Found while reading the phase G Mac run
([[docs/adr/257-ledger-scroll-and-squircle-clips|ADR-257]],
[[docs/adr/258-chart-entrances-and-compositor-diagnostics|ADR-258]]).

## Context

[[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075]] defines the reduced tier as glass without
`backdrop-filter`. The phase G run's glass census found 7 filtered surfaces covering 71.4% of the
window on the reduced tier of `main`, the same as on standard. In a production build the
`fx-reduced`, `prefers-reduced-transparency` and print rules contain only
`-webkit-backdrop-filter: none`: they declared the standard property first, the minifier
(Lightning CSS) keeps one declaration of the pair and keeps the last, and Chromium does not apply
`-webkit-backdrop-filter`. Rules that declare the prefixed property first come through with both.
Checked with a Vite build of `main` and Chromium 153: on `fx-reduced`, cards and the rail computed
`saturate(1.8)` and the top bar `blur(16px) saturate(1.8)`.

The fills on those paths are opaque, so the filter result was hidden while its render surface was
still drawn every frame.

## Decision

- Declare `-webkit-backdrop-filter` first and `backdrop-filter` last in the three rules.
- A source contract test fails if any rule declares the standard property before the prefixed one.

## Consequences

- Look: on a test page over a saturated gradient, reduced-tier screenshots match within about
  170 anti-aliased card-edge pixels (at most 12/255) at 2x; standard and enhanced are unchanged.
- Expected gain, not measured on its own: in the phase G run the I1 arm, which also leaves
  reduced-tier cards without a filter, used 67% less GPU power on the reduced ledger scroll
  (1060 to 347 mW) and 62% less over the sustained minute (1175 to 452 mW) than `main`. The next
  Mac run measures this fix directly.
- Phase D and earlier numbers for the reduced tier and for reduced transparency were taken with
  the filters still on.
