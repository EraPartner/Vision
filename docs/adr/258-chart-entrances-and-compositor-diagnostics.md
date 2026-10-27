---
title: "ADR-258: Chart entrances on the compositor and compositor diagnostics"
type: adr
status: accepted
date: 2026-10-27
tags: [adr, performance, gpu, compositing, charts, motion, macos, mac-optimisation, phase-g, adr-255, adr-257]
description: "Phase G follow-up (H2, H5, I5). Area, line and sparkline entrance animations run as CSS transform and opacity animations on HTML wrappers instead of Framer animating SVG attributes, so the chart SVG rasters once. mac-baseline gains window-scroll and chat-stream segments, a GPU readout, a cc trace summary and --chromium-switch. Pixel-identical end state; gains unmeasured until the Mac run."
aliases: [adr-258, chart entrance, compositor diagnostics]
related_code:
  [
    "apps/frontend/src/components/charts/chartEntrance.tsx",
    "apps/frontend/src/components/charts/AreaChart.tsx",
    "apps/frontend/src/components/charts/LineChart.tsx",
    "apps/frontend/src/components/charts/Sparkline.tsx",
    "apps/frontend/src/components/charts/CartesianChartFrame.tsx",
    "scripts/mac-baseline.ts",
    "scripts/lib/mac-baseline/segments.ts",
    "scripts/lib/mac-baseline/gpuInfo.ts",
    "scripts/lib/mac-baseline/trace.ts",
  ]
---

# ADR-258: Chart entrances on the compositor and compositor diagnostics

## Status

Accepted on 2026-10-27. Tor picked H2, H5 and I5 with the rest of phase G on 2026-10-26; they
waited for ADR-255 (PR #369), which changed the same chart files and the harness. I1 (glass on a
pseudo-element) is held for Tor's decision because it changes the card border ring slightly. Not
yet measured on the Mac.

## Context

[[docs/adr/257-ledger-scroll-and-squircle-clips|ADR-257]] covers the rest of phase G. Chart
entrances used Framer `m.*` components on SVG children (the area sweep animated a clip rect's
`width`, series groups animated `opacity` and `y`). Framer drives SVG attributes from JavaScript
on every frame, and any change inside an `<svg>` repaints the whole chart, so each 320 to 380 px
chart was re-rastered for the 0.26 to 0.52 s of its entrance, during the page transition.

The harness could not see three costs it needs for the next decisions: scrolling the window
(cards and topbar glass), chat streaming, and the compositor itself (render passes, viz draw time,
the active Skia backend).

## Decision

1. **Chart entrances run on the compositor (H2).** `chartEntrance.tsx` adds `ChartLayerSvg` (an
   `aria-hidden` series layer), `ChartEntrance` (fade, or fade and 12 px rise for stacked areas)
   and `ChartReveal` (the left-to-right sweep). The sweep is an `overflow: hidden` wrapper and its
   child sliding in opposite directions with transforms, so the edge moves at
   `marginLeft + innerWidth × ease(t)` while the series stays still; a `clip-path` animation was
   not used because its compositing in Electron 44 is unverified, and `scaleX` would distort.
   Each series is its own `<svg>` with a static full-width clip; the grid is a layer underneath;
   the frame `<svg>` on top keeps the role, label, keyboard handling, hover rect, axes and
   reference lines. Durations and delays come from `lib/motion.ts`; reduced motion is handled by
   the existing `prefers-reduced-motion` block in `index.css`. Animations play on insert only
   (mount, series key change) and the sweep replays when the plot grows wider, as before.
   `BarChart`, `DonutChart`, `PieChart` and `StackedBarChart` keep Framer: per-bar growth and
   per-arc scale inside one focusable SVG cannot move to HTML wrappers without a look or
   accessibility change.
2. **Window-scroll and chat-stream segments (H5).** `mac-baseline --segment window-scroll`
   scrolls the window on `/` and `/statistics`; `--segment chat-stream` streams 300 tokens at 20
   per second through the real send path with `window.fetch` mocked over CDP. Both are opt-in, so
   the default run length is unchanged. No app-side hook.
3. **Compositor readout (H5, I5).** Every run stores CDP `SystemInfo.getInfo` (feature status,
   Graphite, overlays); the traced pass adds the `cc` category and reports viz `DrawFrame`, render
   passes per frame and raster time per segment.
4. **`--chromium-switch` (I5).** Repeatable launch switches for diagnostics, for example
   `--disable-features=SkiaGraphite`. Nothing ships; a product switch needs a beyond-noise result
   on every tier.

## Consequences

- Finished and reduced-motion charts are pixel-identical to the previous code (Playwright,
  Chromium 153). Mid-animation sweep edges match the formula within a pixel.
- Edge cases: if a chart narrows in the middle of a sweep, the clip jumps to the new width (at
  most a 1 px stroke overhang); print pages show charts in their finished state, since the
  existing print rule stops CSS animations.
- Chart DOM now has several `<svg>` elements per chart; tests and code that need the chart's
  accessible SVG select `svg[role]`.
- The harness trace event names come from Chromium sources and are not yet checked against an
  Electron 44 trace; the largest cc/viz events are listed so a mismatch is visible.
