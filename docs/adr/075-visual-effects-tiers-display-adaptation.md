---
title: ADR-075 Visual-Effects Tiers and Per-Display Auto-Adaptation
type: adr
status: Accepted
date: 2026-06-12
tags: [adr, design, frontend, performance, webgl, settings, gpu, june-2026]
description: Replaces the ADR-071 enhancedEffects boolean with a reduced/standard/enhanced tier plus an auto-adapt cap that drops to reduced on large (4K-class) displays; adds shader resolution cap and static-atmosphere degradation
aliases: [adr-075, visual effects tiers, auto-adapt display, fx-reduced]
---

# ADR-075: Visual-Effects Tiers and Per-Display Auto-Adaptation

## Status

Accepted

## Date

2026-06-12

## Context

The [[docs/adr/071-premium-v3-effects-toggle|ADR-071]] `enhancedEffects` boolean assumed one
GPU budget per machine. In practice the budget is per _display_: on the MacBook Air M1
built-in panel (~4.3M physical px) the full enhanced stack runs at ~70% GPU; on a 4K TV
(~8.3M physical px) even the _standard_ look stutters, because the dominant costs scale
with physical pixels:

1. **Backdrop-filter glass** (five tiers + the 16px topbar blur) re-blurs its backdrop
   every scrolled frame — ~2× the pixel work at 4K.
2. **The aurora blobs never idle** — compositor-only transforms, but their infinite
   drift keeps the window compositing at full 4K on every vsync.
3. **Vibrancy** (enhanced only) makes the whole window translucent: macOS blurs the
   desktop behind all 8.3M px every frame and Chromium loses its opaque-window fast path.
4. The WebGL shader aurora is comparatively cheap (0.25× resolution, 30 fps cap).

A single user-flipped boolean cannot serve a laptop that docks to a TV; manually toggling
on every plug/unplug is friction the setting was supposed to remove.

## Decision

### Tier model (replaces the boolean)

`AppSettings.visualEffects: 'reduced' | 'standard' | 'enhanced'` (default `standard`) +
`AppSettings.autoAdaptDisplay: boolean` (default `true`), both in Settings → Appearance.

- **reduced** — no backdrop-filter glass (near-opaque surfaces), liquid canvas hidden.
  Reuses the look of the pre-existing `prefers-reduced-transparency` fallback.
- **standard** — CSS aurora blobs + glass materials (unchanged default look).
- **enhanced** — adds the WebGL shader aurora and Electron vibrancy. ADR-129 later makes native
  vibrancy substitute for persistent web-surface blur on macOS instead of stacking both passes.

**Effective tier** = `reduced` while `autoAdaptDisplay` is on and the window sits on a
large display; otherwise the chosen tier (`resolveEffectiveTier`,
`lib/visualEffects.ts`). Turning auto-adapt off is the explicit "don't touch my
effects" override.

### Large-display detection

`screen.width × screen.height × devicePixelRatio² > 6,000,000` physical px
(`isLargeDisplay`). The threshold deliberately sits between the built-in panel
(1440×900 @2× ≈ 5.2M) and 4K outputs (8.3M in both 1× and HiDPI modes); 1080p/QHD
externals at 1× stay below it. Re-evaluated by `useLargeDisplay()` on `resize` plus a
5s property-read poll — no DOM event fires reliably when a window is dragged between
displays. Renderer-only by design: no Electron main/preload IPC, so web and desktop
share one code path. (A future Electron `screen.getDisplayMatching` + `display.internal`
IPC could replace the heuristic with exact per-display facts.)

### Application points

- `VisualEffectsController` (renders null, in AppLayout) tags `<html>`:
  - `fx-reduced` — effective tier is reduced. `index.css` carries a class-selector
    mirror of the `prefers-reduced-transparency` block (kept in sync by comment; the
    media block must keep working from first paint, before React mounts, so the two
    blocks are deliberately duplicated rather than JS-unified).
  - `fx-static-atmosphere` — large display but the user kept a higher tier: aurora
    blobs stop drifting (`animation: none`) so the compositor can idle.
- `AppLayout` mounts `ShaderAurora` only at effective tier `enhanced`.
- `ElectronBridge` gates vibrancy on the _effective_ tier, so auto-adapt also drops
  the translucent window on large displays.
- ADR-129 removes web `backdrop-filter` from persistent cards, chrome, hero surfaces, the top bar,
  and the full-window modal scrim only while native macOS vibrancy is active; thin and thick
  transient materials retain it.
- `ShaderAurora` backing store is now additionally capped at 640px wide
  (`MAX_CANVAS_WIDTH`) — on 1×-scaled 4K outputs, 0.25× alone was still ~0.5MP.

### Migration

`migrateAppSettings` (settingsStore, applied at hydration): legacy
`enhancedEffects: true → visualEffects: 'enhanced'`, `false → 'standard'`; an explicit
stored `visualEffects` wins; the legacy key is stripped so the next debounced persist
writes the new shape. No backend change — `app_settings` is an opaque JSON blob.

### Settings UI & i18n

Appearance tab: tier `Select` + auto-adapt `Switch` (staged, applied on dialog Save).
Keys `settings.appearance.visualEffects*` / `autoAdaptDisplay*` added (en + nl);
`settings.general.enhancedEffects*` removed.

## Consequences

- The docked-TV workflow needs zero interaction: enhanced on the built-in panel,
  reduced within ≤5s of landing on the TV, restored on return.
- Fresh installs keep today's standard look; the reduced tier punishes nobody by
  default (it only engages on large displays or by explicit choice).
- The 6M px threshold is a heuristic: a 5K Studio Display (14.7M px) is treated as
  "large" even on GPUs that could handle it — those users turn auto-adapt off. Mirrored
  displays report the active screen; acceptable.
- The `fx-reduced` CSS block duplicates the `prefers-reduced-transparency` block —
  edits must touch both (flagged by comments at both sites).
- `enhancedEffects` no longer exists on `AppSettings`; stored blobs migrate on first
  load. Rollback would need the inverse mapping (enhanced → true, else false).
- Verified: tsc clean, ESLint clean, 13 new vitest cases for
  `isLargeDisplay`/`resolveEffectiveTier`/`migrateAppSettings` pass,
  `validate-locales` clean (2,911 keys parity). Full frontend suite: 6 failures in
  portfolio-math/adminToken tests reproduce on clean HEAD — pre-existing, unrelated.
- Untested on real hardware yet: actual GPU relief on a 4K TV (profiling follow-up).

## Related

- [[docs/adr/071-premium-v3-effects-toggle|ADR-071: Premium v3 — Enhanced-Effects Toggle]] (toggle superseded by this tier model)
- [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070: Liquid Glass v2]]
- [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020: Glass System Downgrade]]
- [[docs/architecture/frontend-architecture|Frontend Architecture]]
- [[docs/adr/index|All ADRs]]

---

## Addendum — 2026-06-12: tier-in-use display and session-scoped manual override

Same-day follow-up (user request). The Appearance-tab Select now shows the tier
**currently in use on this display** (the effective tier), not the synced preference,
and the auto-adapt cap can be manually overridden with deliberately narrow scope
(user-chosen semantics: local-only, reclaimed by auto mode on restart):

- **`sessionTierOverride`** (settingsStore, _outside_ `appSettings` so it is never
  persisted): in-memory, this-device-only. `resolveEffectiveTier` gained it as an
  optional 4th parameter — the override **replaces the cap, not the preference**, so
  it only has effect while `autoAdaptDisplay && largeDisplay`; back on a small display
  the synced preference governs, and an app restart returns large displays to auto mode.
- **Save routing** (DashboardSettingsDialog): a changed tier pick (`tierSelection`
  staged state, null = untouched) routes on Save — capped display → session override
  (picking 'reduced' clears it; synced `visualEffects` untouched), uncapped → normal
  synced preference + override cleared. Toggling auto-adapt without touching the tier
  also clears the override ("auto takes back control").
- **UI**: under the Select, a note explains the state — auto-capped ("Reduced
  automatically for this large display…", `text-primary`) or overridden ("Session
  override for this device — automatic reduction resumes after the next launch",
  `text-warning`). Keys `settings.appearance.visualEffectsAutoNote` /
  `visualEffectsOverrideNote` (en+nl).
- Consequence: from a capped display the synced baseline preference cannot be changed
  without first turning auto-adapt off — deliberate, keeps one Select unambiguous.
- Tests: 4 new cases (override replaces cap; dormant on small display / auto-off;
  absent → reduced). 17 total in `visualEffects.test.ts`. tsc/ESLint/validate-locales
  clean (2,913 keys).
