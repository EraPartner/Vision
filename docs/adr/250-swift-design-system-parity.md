---
title: "ADR-250: Swift design-system parity foundation"
type: adr
status: accepted
date: 2026-10-25
tags:
  [
    adr,
    architecture,
    swift,
    swiftui,
    native-app,
    design-system,
    design-tokens,
    glass,
    dialogs,
    parity,
    adr-249,
  ]
description: "Accepted on 2026-10-25. The Swift app takes its design system from the generator, not from hand-typed constants: new DesignTokens namespaces, glass materials, centred in-window dialogs instead of system sheets and alerts, web-sized controls, Full effects in Swift and Settings as an in-window dialog. Phase 2a builds the foundation; phase 2b applies it to every screen."
aliases: [adr-250, swift design system, swift visual parity foundation]
related_code:
  [
    "scripts/native-design-tokens.ts",
    "apps/native/Sources/VisionNativeCore/Design/Generated/DesignTokens.swift",
    "apps/native/Sources/VisionNativeCore/Design/GlassMaterial.swift",
    "apps/native/Sources/VisionNativeUI/Components/VisionGlassSurface.swift",
    "apps/native/Sources/VisionNativeUI/Components/VisionGlassDialog.swift",
    "apps/native/Sources/VisionNativeUI/Components/VisionModalHost.swift",
    "apps/native/Sources/VisionNativeUI/Components/VisionEffects.swift",
    "apps/native/Sources/VisionNativeUI/Components/VisionButtonStyles.swift",
    "apps/native/Sources/VisionNativeUI/Screens/Settings/NativeSettingsWindow.swift",
  ]
---

# ADR-250: Swift design-system parity foundation

## Status

Accepted on 2026-10-25. Builds on [[docs/adr/249-revive-swift-app|ADR-249]], which asks for full
visual parity. [[docs/adr/249-revive-swift-app|ADR-249]] and
[[docs/adr/244-full-effects-switch|ADR-244]] are not edited; this record adds the design-system
decisions they leave open.

## Date

2026-10-25

## Context

[[docs/adr/249-revive-swift-app|ADR-249]] restored the Swift app and set the goal of full visual
parity with the React app, "in terms of design tokens and all other things". The restored port
had the palettes but hand-typed most other values (easing curves, spring timings, glass
recipes, dialog geometry, control heights). It presented dialogs, alerts and Settings as system
sheets, drew controls at macOS sizes and had no Full effects switch
([[docs/adr/244-full-effects-switch|ADR-244]]). The gap audit of 2026-10-25 listed the missing
tokens and components. Phase 2a builds the shared foundation; screens follow in phase 2b.

## Decision

1. **The token generator is the single source.** `scripts/native-design-tokens.ts` reads
   `styles/tokens.css`, `styles/index.css`, `tailwind.config.ts`, the button, input and dialog
   components and `lib/motion.ts`. It writes `DesignTokens.swift` and fails on an unresolved
   `var(--x)` and on a design-system custom property that has no Swift counterpart. Doc comments
   cite the CSS variable, selector or class plus the file, never a line number, so unrelated CSS
   edits do not change the output. The palette output is unchanged. New `DesignTokens`
   namespaces: `Ease`, `Spring`, `Elevation`, `Glass`, `Atmosphere`, `FocusRing`, `Overlay`
   (scrim, frost and dialog geometry), `Hover`, `Press`, `Selection`, `Halo`, `Typography` (the
   type ramp) and `Control` (heights), plus an extended `Radius` scale.
2. **Glass is data plus a surface.** `GlassMaterialSpec` (Core) holds the web recipes
   (`glass-thin`, `-regular`, `-thick`, `-chrome`, `-elevated`) as fill gradient, border and
   shadow layers. `VisionGlassSurface` (UI) draws one with the system `Material` nearest the CSS
   `backdrop-filter` blur, the recipe's fill, border and shadows. Reduce Transparency swaps it for
   `--card`, Increase Contrast for the high-contrast border.
3. **Centred in-window dialogs replace system sheets and alerts.** `.visionDialog`,
   `.visionAlert`, `.visionConfirmationDialog` and `.visionSideSheet` present a
   `VisionGlassDialog` or `VisionSideSheet` over the presenting view in the same window,
   mirroring Radix `Dialog`, `AlertDialog` and `Sheet`. They carry the spring enter, glide exit,
   Reduce Motion, Escape, scrim click and modal accessibility behaviour of the web.
4. **Frosted scrim only under Full effects or Enhanced.** The scrim is plain `--background` at
   `Overlay.scrim` (`.modal-overlay`, `index.css`). With Full effects on or the Enhanced tier it
   becomes the frosted scrim (`:root.fx-full .modal-overlay`) and the presenting content is
   blurred by `Overlay.blur`. SwiftUI cannot blur what is behind an overlay with a chosen radius,
   so the blur is applied to the content under the scrim.
5. **Web-sized controls.** `VisionControlMetrics` (heights 36, 32, 28 and 40 points from
   `DesignTokens.Control`, with the web padding and font sizes per button size) sizes buttons, the shared input chrome of text
   fields, text editors and selects, the sliding-pill segmented control, the glass select, switch,
   checkbox and radio styles, the glass tooltip and the badge, with the web hover, press and
   focus-ring states. `.buttonStyle(.visionOutline/.visionPrimary)` and `.textFieldStyle(.vision)`
   keep compiling.
6. **Full effects in Swift.** `visionFullEffects` is an environment value the shell sets from
   `AppSettings.fullEffects`; `VisualEffectsTier` types the existing tier string. Under Full
   effects the aurora drifts smoothly, cards are `glass-regular` with an animated hover frame and
   lift, toasts and chrome use their glass materials and canvas text carries the double halo.
   With it off the output is unchanged.
7. **Settings is an in-window dialog.** The shell overlay host presents Settings through
   `.visionDialog` at the `DashboardSettingsDialog` geometry (256 pt rail, `primary/0.10`
   selection, 82% height). Retained state, dismissal rules, focus return and the unsaved-changes
   alert (now `.visionAlert`) are kept.
8. **Bundled fonts.** Inter (400, 400 italic, 500, 600, 700) and Fraunces (400, 600, 700) are
   bundled as TrueType under their OFL licences and registered by `VisionFonts`, so the app does
   not depend on installed fonts.
9. **Phase 2b** applies this foundation to every screen: it moves call sites to the new dialogs
   and controls, replaces remaining system sheets and alerts and signs off each screen against the
   React app. The foundation lands in these packages, each mirroring a CSS source:

| Package | What it adds                                                                    | CSS source it mirrors                                                                           |
| ------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A       | Tokens, `GlassMaterialSpec`, `VisionGlassSurface`, fonts                        | `tokens.css`, `index.css` glass utilities, `tailwind.config.ts`, `lib/motion.ts`                |
| B       | `VisionGlassDialog`, `VisionModalHost`, the four modifiers                      | `components/ui/dialog.tsx`, `alert-dialog.tsx`, `sheet.tsx`, `.modal-overlay`                   |
| C       | Buttons, inputs, toggles, segmented control, select, tooltip, badge, focus ring | `components/ui/button.tsx`, `input.tsx`, `select.tsx`, `switch.tsx`, `tooltip.tsx`, `badge.tsx` |
| D       | `visionFullEffects`, glass card, toasts, chrome blur, aurora drift, header halo | `:root.fx-full`, `.page-header-title`, `components/ui/card.tsx`                                 |
| E       | Settings as an in-window dialog, shell overlay host                             | `DashboardSettingsDialog.tsx`                                                                   |

## Consequences

- A change to a design token reaches Swift by regenerating `DesignTokens.swift`; hand-typed
  copies of CSS values in views are bugs.
- Known approximations, accepted because SwiftUI has no equivalent:
  - No backdrop saturation: the system material does not apply the recipe's `saturate()`.
  - No shadow spread: CSS blur maps to half the SwiftUI radius and the negative spread of the
    ambient layers is dropped, so stacked shadows add slightly to each other.
  - `\.dismiss` is inert inside vision dialogs. Callers pass `onClose` or read
    `visionDismissDialog`.
  - The select popover has no arrow.
  - The tooltip is a child `NSPanel`, not an in-tree view.
  - The dialog exit has no genie origin, which would need the trigger's frame, and the frosted
    blur is on the content under the scrim, not on the scrim.
- Nothing here compiles on Linux. The macOS `swift-build` workflow and a side-by-side
  screenshot review on Tor's Mac gate each package, as in [[docs/adr/249-revive-swift-app|ADR-249]].
- Screens still use system sheets and macOS-sized controls until phase 2b. The checklist is
  [[docs/reference/native-parity/design-system|Native parity: design system]].

## Related

- [[docs/adr/249-revive-swift-app|ADR-249]]
- [[docs/adr/244-full-effects-switch|ADR-244]]
- [[docs/architecture/native-app|Native app architecture]]
- [[docs/features/appearance|Appearance]]
- [[docs/reference/native-parity/design-system|Native parity: design system]]
- [[docs/adr/index|All ADRs]]
