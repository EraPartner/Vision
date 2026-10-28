---
title: "ADR-244: Full effects switch and built-in display exemption"
type: adr
status: accepted
date: 2026-10-21
tags: [adr, appearance, visual-effects, gpu, performance, macos, electron, adr-075]
description: "Accepted on 2026-10-21. A new AppSettings.fullEffects switch (off by default) restores, as they were, the effects removed or reduced to save GPU work, within each tier's own scope. The ADR-075 large-display cap no longer applies to a built-in panel; the desktop app asks the main process whether the window's display is internal. scripts/mac-baseline.ts can measure the switch off and on and repeat runs."
aliases: [adr-244, full effects, restore removed effects, built-in display]
related_code:
  [
    "apps/frontend/src/index.css",
    "apps/frontend/src/lib/visualEffects.ts",
    "apps/frontend/src/hooks/useVisualEffectsTier.ts",
    "apps/frontend/src/components/layout/VisualEffectsController.tsx",
    "packaging/electron/main.ts",
    "scripts/mac-baseline.ts",
  ]
---

# ADR-244: Full effects switch and built-in display exemption

## Status

Accepted on 2026-10-21. Amends [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075]]
(large-display detection). Amended by [[docs/adr/255-cheaper-full-effects|ADR-255]]: the switch is now `auto|on|off` with default `auto`; a stored `false` maps to `auto`.

## Date

2026-10-21

## Context

Between April and October 2026 several effects were removed or reduced to save GPU work: the
smooth aurora drift (#329), the CSS blobs under the WebGL aurora, the frosted modal overlay below
the enhanced tier, glass chart tooltips and scrub pills, the frosted pivot column, nested glass in
AI chat, the dark-mode double halo, the 20px card material (ADR-132), web blur under native
vibrancy (ADR-129), the animated card hover shadow and the uncapped chart stagger. None was
measured on Tor's MacBook Air M1. The Mac optimisation plan measures first: the full look must be
available for measurement before phase 2 makes it cheaper, and Tor's everyday app must not change.

The phase 0 baseline also showed that the Air's built-in panel in a "More Space" scaled mode
reports 1680×1050 at 2× (7.06 M backing pixels). That is above ADR-075's 6 M threshold, so the
built-in screen was treated like a 4K TV: standard and enhanced froze the aurora, and with
auto-adapt on the app dropped to reduced.

## Decision

- **One switch.** `AppSettings.fullEffects: boolean`, default `false`, in Settings → Appearance →
  Visual effects ("Full effects"). `VisualEffectsController` sets `fx-full` on `<html>`;
  `index.css` restores the CSS effects under `:root.fx-full`, and components read the switch with
  `useFullEffects()` for class-level restores (Card `glass-regular`, chart tooltip and scrub pill
  `glass-thick`, chat composer and tool-table header `glass-thin`, uncapped bar stagger).
- **Plain restore.** Each effect comes back as it was before its removal commit, within its
  original tier scope. Reduced motion, reduced transparency, the reduced tier, the large-display
  freeze and the idle pause still apply. Where code has moved on, the restore adapts minimally
  (current typography tokens, `--ease-glide` for the retired `--ease-out-quint`, the hover shadow
  on interactive cards only, as ADR-172 routes hover).
- **Not restored.** The WebGL aurora and native vibrancy stay enhanced-only (Tor, 2026-10-21:
  they were gated from the start, not removed). The sidebar workspace tab strip no longer exists.
  Opaque tables (ADR-020) were a design rule, not removed code. The account-ledger row hover fade
  and the sidebar's double blur were never removed.
- **Built-in panels are never large.** `isLargeDisplay()` takes a `builtIn` flag; the desktop app
  asks the main process (`app:display-is-internal`, Electron `Display.internal` for the display
  matching the window) on mount, on resize and on the existing 5-second poll. Until the first
  answer the hook assumes built-in, so the Mac's screen never flashes the reduced tier at launch.
  Outside Electron, or when the answer is unknown, the pixel heuristic applies unchanged.
  Rationale: the cap exists for external 4K/5K outputs; a built-in panel ships matched to its
  machine's GPU, so its backing-store pixel count is the wrong signal.
- **Measurement.** `scripts/mac-baseline.ts` gains `--full-effects off,on` and `--repeat <n>`;
  the summary reports median and min–max per tier and switch state, and marks an off/on
  difference "beyond noise" only when the ranges over at least two runs per side do not overlap.

## Consequences

- With the switch off the look and cost are unchanged on every display except a built-in panel
  above 6 M backing pixels, which now gets the chosen tier instead of the large-display cap.
- With the switch on, the restored effects cost GPU again; phase 2 of the optimisation plan
  measures them on the Air and makes them cheaper.
- One new IPC invoke channel (25 total), no-argument, sender-checked like the others.
- No CI job or CI time is added.

## Related

- [[docs/features/appearance|Appearance Feature]]
- [[docs/performance/mac-baseline|Mac Performance Baseline]]
- [[docs/adr/index|All ADRs]]
