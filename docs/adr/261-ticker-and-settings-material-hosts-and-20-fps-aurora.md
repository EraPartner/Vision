---
title: "ADR-261: Ticker and Settings material hosts, 20 fps WebGL aurora"
type: adr
status: accepted
date: 2026-10-28
tags: [adr, performance, gpu, compositing, glass, css, macos, mac-optimisation, phase-j, adr-255, adr-257, adr-260]
description: "Phase J. The portfolio ticker box takes the cards' saturate-only filter and draws its glass on a ::before under the moving tape. The Settings dialog draws its glass on a ::before once its entrance settles, clips its pane with a rounded-rect wrapper instead of the squircle box, and its Cards drop their nested filter. The enhanced-tier WebGL aurora is capped at ~20 fps instead of ~30. Verified in headless Chromium (software compositing), not on the Mac."
aliases: [adr-261, phase j, ticker material host, settings material host, aurora 20 fps]
related_code:
  [
    "apps/frontend/src/index.css",
    "apps/frontend/src/styles/tokens.css",
    "apps/frontend/src/features/portfolio/PortfolioTicker.tsx",
    "apps/frontend/src/features/settings/DashboardSettingsDialog.tsx",
    "apps/frontend/src/components/layout/ShaderAurora.tsx",
  ]
---

# ADR-261: Ticker and Settings material hosts, 20 fps WebGL aurora

## Status

Accepted on 2026-10-28. Tor picked all three phase J items ("do all items"). It extends
[[docs/adr/260-ledger-card-material-on-a-pseudo|ADR-260]] to two more hosts and changes the
WebGL frame cap set in [[docs/adr/255-cheaper-full-effects|ADR-255]].

## Context

- J1: the portfolio ticker box (`liquid-glass`) is not a Card, so on the standard tier it kept the
  full `blur(20px)` backdrop filter that ADR-255 removed from cards. Its tape moves on every frame
  while `/portfolio` is open, and a filtered box re-renders and re-filters its subtree with it.
- J2: the Settings dialog (`glass-thick`, `blur(28px)`) scrolls a pane inside a clipping squircle
  box. Each scrolled frame paid for the squircle clip mask (ADR-257) and for re-filtering the
  dialog-sized surface (ADR-260). Its settings groups are glass Cards nested in that surface.
- J3: the enhanced tier's WebGL aurora damages the whole window on every frame it draws, so its
  idle cost scales with the frame rate (phase D: ~14 mW per fps on standard; enhanced not measured).

## Decision

- Material hosts are no longer Cards only: `:is(.card-material.premium-frame, .liquid-glass,
  .glass-thick).material-host` keeps the ADR-260 rules at three-class weight. `liquid-glass` and
  `glass-thick` hosts publish their inset and outer shadow halves, which `--elevation-2-inset`,
  `--elevation-2-outer`, `--elevation-4-inset` and `--elevation-4-outer` now provide;
  `--elevation-2` and `--elevation-4` are composed from them, unchanged.
- The ticker box adds `card-material` (the saturate-only filter, as on cards) and `material-host`.
- The Settings dialog becomes a host only once its entrance animation has finished, and stops
  being one as soon as it starts closing. While the box's opacity is below 1 it is the backdrop
  root of its `::before`, which would then frost nothing (headless check: up to 43/255 during the
  fade). Its content sits in a `rounded-[inherit] overflow-hidden` wrapper; the box itself no
  longer clips.
- Cards inside a host drop their own backdrop filter (`.material-host .card-material`), as the flat
  chat bubbles do: the host box is no longer their backdrop root, and over the near-opaque dialog
  fill the saturate filter changed little.
- `ShaderAurora` `FRAME_MIN_MS` 33 → 48 (~20 fps on 60 Hz; 48 so three vsyncs pass despite
  jitter). The clock runs on elapsed time, so the motion keeps its speed.

## Consequences

- Measured in headless Chromium only (Playwright, SwiftShader software compositing, 1440×900 at
  2×, static harness with the built CSS, dark and light, three alternating runs each). These are
  proxies, not Mac GPU numbers.
  - Ticker animating: GPU process CPU 156–221 → 55–81 ticks per 6 s (about −60%).
  - Settings pane scrolling (1100×800 at 1×): GPU process saturated in both, but presented frames
    went from 50–55 to 99–104 per 6 s, so per-frame compositing work roughly halved.
  - Settings dialog compositor layers: 41 → 14 (the nested Card filters were most of them). Ticker
    layers: 12 → 13.
- Look, at rest (same harness, over sharp coloured shapes, which overstates it next to the soft
  aurora): settings dialog p99.9 pixel difference 12–14/255, max 83–101 at the border ring and
  corners; ticker differences are glyph anti-aliasing and the backdrop no longer blurred behind it
  (ADR-255's card trade-off). The Settings dialog snaps from box glass to host glass when its
  entrance ends; the difference is in the at-rest range above.
- The aurora on enhanced updates 20 times a second instead of 30. Not measured on the Mac; Tor
  judges the look.
- Enhanced idle GPU and the Mac watt figures for J1 and J2 are not measured. Tor asked for no
  routine Mac runs.
