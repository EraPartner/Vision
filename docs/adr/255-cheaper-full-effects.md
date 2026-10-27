---
title: "ADR-255: Cheaper full effects (GPU phase D)"
type: adr
status: accepted
date: 2026-10-27
tags: [adr, performance, gpu, macos, visual-effects-tiers, full-effects, shader-aurora, webgl, glass-materials, adr-075, adr-129, adr-244]
description: "Accepted on 2026-10-26 by Tor (all items of the phase D proposal list). Keeps the Full effects look while cutting the work behind it: aurora drift on a 33 ms grid instead of every vsync, the WebGL aurora draws the blobs itself (one animator), cards and the desktop sidebar keep saturate but drop blur, the sidebar filters once, the aurora pauses under modals, ledger rows stop chasing hover while scrolling, plus smaller blob layers, opacity-only hover shadow, a capped bar stagger, transform-positioned chart pills and Mac measurement variants. The WebGL aurora stays on enhanced only, because the Mac run measured it as more expensive than the CSS blobs on standard."
aliases: [adr-255, cheaper full effects, phase d gpu]
related_code:
  [
    "apps/frontend/src/index.css",
    "apps/frontend/src/components/layout/ShaderAurora.tsx",
    "apps/frontend/src/components/layout/auroraBlobs.ts",
    "apps/frontend/src/components/layout/VisualEffectsController.tsx",
    "apps/frontend/src/components/shared/VirtualDataTable.tsx",
    "scripts/mac-baseline.ts",
    "scripts/mac-baseline-variants/",
  ]
---

# ADR-255: Cheaper full effects (GPU phase D)

## Status

Accepted on 2026-10-26 by Tor, who picked every item of the phase D proposal list ("i want you to
do all of them") and asked for a Vision-drawn shader aurora. Builds on
[[docs/adr/244-full-effects-switch|ADR-244]]; [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075]] tiers
are unchanged.

## Date

2026-10-26

## Context

The ADR-244 off-vs-on run (M1 Air, Vision Demo, 3 repeats) measured the Full effects switch at
idle as 471 to 4575 mW GPU on standard and 667 to 6251 mW on enhanced, and enhanced scrolling as
2420 to 7052 mW. In code: the full-effects drift moved the aurora blobs on every vsync, so every
backdrop-filter surface re-blurred 60 times a second; on enhanced its selector out-ranked the
`fx-webgl-live` freeze, so the CSS blobs and the WebGL aurora animated out of step; the desktop
sidebar stacked two `glass-chrome` layers; the aurora kept moving under open modals. The causes
of the measured cost were inferred, not traced.

## Decision

- **Drift cadence.** Full effects run the sampled `aurora-drift-a/-b` keyframes with `steps(120)`
  per 4 s segment: 30 changes a second (33 ms) instead of every vsync. The `-smooth` keyframes are
  removed.
- **One animator on the WebGL path.** `ShaderAurora` draws the two blobs in the same fragment
  pass as its noise, from `auroraBlobs.ts`, which mirrors the CSS geometry and drift. While the
  program is live, `fx-webgl-live` removes the CSS blob pseudo-elements; they return as the
  fallback on context loss. The noise opacity (0.6, dark 0.5) moved into the shader. The shader's
  clock advances only while it loops, so pauses resume in place.
- **Saturate-only glass over the canvas.** `.card-material` and the desktop `.app-sidebar` keep
  `saturate()` and drop `blur()`; surfaces over content keep blur.
- **One sidebar pass.** The wrapper applies saturate twice (the saturate matrices compose
  exactly); the inner `data-sidebar` layer has no filter.
- **Modal pause.** `fx-modal-open` (any `.modal-overlay` mounted) pauses the CSS drift and stops
  the WebGL loop.
- **Smaller blob layers.** Each blob box is cut to its visible 72% (same pixels), and
  `.liquid-canvas` has `contain: strict`.
- **Hover and charts.** Full-effects hover shadow and inset highlight fade on the pre-rendered
  `::after` (border still fades); interactive cards clip an inner wrapper. The dark double halo
  stays on headings, with canvas body text on the single 8 px halo. The bar stagger wave lasts at
  most 1.2 s (unchanged up to 80 bars). Chart scrub pills and the tooltip move by `transform`.
  Virtualized ledger rows ignore the pointer while the list scrolls (120 ms tail).
- **Measurement.** `scripts/mac-baseline.ts` gains `--variant name=file` (CSS or JS injected
  after launch, plus `<html data-fx-variant>`), `--variants-only-idle`, an idle-trace frame rate
  and a glass-surface census. `shader-standard` mounts the WebGL aurora on standard, so that
  choice is made from numbers (Tor, 2026-10-26: "Measure first, then decide").
- **Not done:** one blur strip for the pivot frozen column. Its cells carry row tints and hover;
  a strip behind transparent cells would hide them or lose the blur, which changes the look.

## Consequences

- Cards and the sidebar lose a 12–32 px blur of soft gradients and faint grain. This is a subtle
  look change; the `glass-blur` variant restores the old filters for an A/B.
- The aurora holds still behind dimmed modals and resumes in place.
- Ledger hover does not follow rows mid-scroll; it returns once scrolling settles.
- The win is claimed only after a Mac before/after run with 3 repeats and non-overlapping ranges.

## Measured outcome (2026-10-27)

Mac overnight run on the M1 Air with Vision Demo and 3 repeats. Main `bbaf122` against this
change at `8d91c3a`. A gain counts only when the min–max ranges do not overlap.

- With Full effects on: standard idle GPU 5825 → 417 mW, enhanced idle GPU 8786 → 1462 mW,
  enhanced scroll 40.5 → 59.9 fps.
- With Full effects off: reduced scroll GPU 5776 → 832 mW, standard idle 638 → 137 mW.
- Compared with main with Full effects off, standard with Full effects on is cheaper. Enhanced is
  about level at idle (+6%), while scroll is +16% and memory +24%.
- `shader-standard` costs more than the CSS blobs on standard (off 137 → 602 mW, on 411 →
  600 mW). The WebGL aurora therefore stays on enhanced only, and the variant remains available
  for measurement.
- The `glass-blur` variant (old card and sidebar filters) puts standard idle back up from 416 to
  2514 mW, so the saturate-only glass is the largest single saving. The drift costs about
  14 mW per frame per second.

## Default (Tor, 2026-10-27)

Following these numbers, Tor chose "Default on standard only". `AppSettings.fullEffects` becomes
`auto | on | off` with `auto` as the default. `auto` is on when the chosen tier is standard and off
on reduced and enhanced. It follows the chosen tier, not the display-capped one, so no display
check is needed. The Settings switch shows the resolved state, and flipping it stores an explicit
`on` or `off`. A stored `true` from before becomes `on`. A stored `false` becomes `auto`, because
it cannot be told apart from the old untouched default.
