---
title: ADR-129 Native Vibrancy Substitutes Persistent Web Blur
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags: [adr, electron, macos, vibrancy, performance, glass, visual-effects-tiers]
description: At the enhanced macOS Electron tier, native under-window vibrancy replaces backdrop blur on persistent web surfaces while small transient materials keep local blur.
aliases: [adr-129, vibrancy blur substitution]
---

# ADR-129: Native Vibrancy Substitutes Persistent Web Blur

## Status

Accepted

## Context

ADR-117 limits native under-window vibrancy to the enhanced tier, but that tier still applied the
same web `backdrop-filter` blur to persistent cards and chrome. Those surfaces sampled an already
blurred native backdrop, so enhanced mode paid for two blur passes over the same pixels. The
translucent window also prevents an opaque-window compositor shortcut.

## Decision

When `html.electron-mac.vibrancy` is active, native under-window vibrancy substitutes for web blur
on persistent materials: default and regular glass, chrome, elevated and hero surfaces, and the
full-width app top bar. The full-viewport modal scrim also stays a flat translucent dim instead of
re-blurring the entire window. Surface fills, borders, highlights, and shadows remain, preserving
the material hierarchy without another `backdrop-filter` pass.

Thin navigation material and thick dialog or popover material keep their local web blur. These
smaller transient surfaces still need separation from the content directly beneath them and do not
dominate the standing full-window cost. The dialog panel therefore retains local depth even though
its viewport-sized scrim is flat.

Web builds and standard or reduced tiers are unchanged. The rule is conditional on both the
Electron macOS class and the live vibrancy class, so it cannot apply while the native material is
absent.

## Consequences

- Enhanced macOS mode no longer stacks native blur with persistent web surfaces or a full-window
  modal-overlay blur.
- Enhanced mode changes visually: persistent surfaces inherit more of the native material while
  keeping their existing tint and edge treatment.
- Small transient surfaces retain the stronger local depth cue.
- Automated tests pin selector scope, but contrast and material appearance still require a packaged
  macOS visual pass.

## Related

- [[docs/adr/117-on-demand-electron-vibrancy|ADR-117: On-Demand Electron Vibrancy]]
- [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075: Visual-Effects Tiers and Display Adaptation]]
- [[docs/features/appearance|Appearance]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
