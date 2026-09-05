---
title: ADR-117 On-Demand Electron Vibrancy
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags: [adr, electron, macos, ipc, vibrancy, performance, visual-effects-tiers]
description: Allocate the macOS under-window vibrancy material only while the effective visual-effects tier is enhanced, superseding ADR-072's always-present material.
aliases: [adr-117, on-demand vibrancy]
---

# ADR-117: On-Demand Electron Vibrancy

## Status

Accepted

## Context

ADR-072 created every macOS window with `vibrancy: 'under-window'` and made only the renderer body opacity conditional. At standard and reduced tiers the opaque page hid the material, but macOS still maintained the underlying `NSVisualEffectView`. ADR-075 later made the effective tier dynamic, including automatic downgrades on large displays, without changing that native allocation.

The renderer already owns the effective-tier decision. Electron's sandboxed bridge is the narrow boundary through which it can mirror that decision to the native window.

## Decision

Do not set `vibrancy` when creating the window. Add a typed `app:set-vibrancy` command to the canonical Electron invoke contract. `ElectronBridge` sends `true` only when the effective tier is `enhanced`, sends `false` on every other tier and during cleanup, and keeps the existing `vibrancy` HTML class aligned with the same value.

The main process accepts only booleans from the current renderer, applies `setVibrancy('under-window')` only on macOS with a live window, and clears the material with `setVibrancy(null)`. The bridge method remains optional for compatibility with older installed shells.

This supersedes only ADR-072's decision that the native material is always present. ADR-072's window chrome, renderer translucency, sandbox, menu, accent, and file-handoff decisions remain active.

ADR-129 later changes the enhanced-tier renderer treatment: persistent web surfaces and the
full-viewport modal scrim stop applying their own backdrop blur while native vibrancy is active.
The allocation and IPC decisions in this ADR remain active.

## Consequences

- Standard, reduced, and auto-adapted windows no longer maintain an invisible native blur material.
- Enhanced-tier allocation and tier gating are unchanged after the renderer mounts; ADR-129 changes
  the persistent-surface appearance to avoid a second blur pass.
- A short startup interval has no vibrancy until the renderer reports its effective tier.
- Browser builds and older Electron shells keep working because the call is capability-gated.
- Packaged macOS visual behavior still needs an on-device check; automated tests cover the IPC contract and tier transitions, not compositor output.

## Related

- [[docs/adr/072-electron-native-desktop-integration|ADR-072: Electron-Native Desktop Integration]]
- [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075: Visual-Effects Tiers and Display Adaptation]]
- [[docs/adr/129-native-vibrancy-substitutes-persistent-web-blur|ADR-129: Native Vibrancy Substitutes Persistent Web Blur]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/features/appearance|Appearance]]
