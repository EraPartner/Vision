---
title: "Native parity: design system"
type: reference
status: active
date: 2026-10-25
updated: 2026-10-25
tags:
  [
    reference,
    swift-rewrite,
    native-parity,
    design-system,
    design-tokens,
    dialogs,
    effects,
    settings,
    adr-250,
  ]
description: "Checklist of the Swift design-system foundation against the React app: design tokens, glass, dialogs, form controls, effects and Settings. Every foundation row is done in phase 2a; the screen sweep that moves call sites onto it is pending in phase 2b."
aliases: [native design system parity, swift design system checklist]
---

# Native parity: design system

> [!abstract] Scope
> The shared visual layer of the Swift app against the React app, decided in
> [[docs/adr/250-swift-design-system-parity|ADR-250]]. Screens and their action rows are on the area
> pages listed in [[docs/reference/native-parity/index|the parity index]]. `Foundation` is the
> component or token set in `apps/native/`; `Screens` is whether every screen uses it.

`Status` reads "foundation done, screen sweep pending (phase 2b)" when the primitive exists and
call sites still use the older system presentation or macOS-sized controls. Each row flips when the
phase 2b sweep reaches its last screen.

## Design tokens

| #   | Area                                  | CSS source                                             | Swift                                                                          | Status                                           |
| --- | ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| 1   | Easing curves and springs             | `tokens.css` `--ease-*`, `--spring-*`; `lib/motion.ts` | `DesignTokens.Ease`, `Spring`                                                  | foundation done, screen sweep pending (phase 2b) |
| 2   | Elevation, glass recipes, atmosphere  | `tokens.css`, `index.css` `.glass-*`                   | `DesignTokens.Elevation`, `Glass`, `Atmosphere`; `GlassMaterialSpec`           | foundation done, screen sweep pending (phase 2b) |
| 3   | Focus ring, hover, press, selection   | `index.css`, `tailwind.config.ts`                      | `DesignTokens.FocusRing`, `Hover`, `Press`, `Selection`                        | foundation done, screen sweep pending (phase 2b) |
| 4   | Overlay scrim, frost, dialog geometry | `index.css` `.modal-overlay`, dialog components        | `DesignTokens.Overlay`                                                         | foundation done, screen sweep pending (phase 2b) |
| 5   | Type ramp, canvas halos               | `tailwind.config.ts`, `index.css` `.page-header-title` | `DesignTokens.Typography`, `Halo`                                              | foundation done, screen sweep pending (phase 2b) |
| 6   | Control heights, radius scale         | `button.tsx`, `input.tsx`, `tailwind.config.ts`        | `DesignTokens.Control`, extended `Radius`                                      | foundation done, screen sweep pending (phase 2b) |
| 7   | Fonts                                 | `styles/` font faces                                   | Inter 400, 400 italic, 500, 600, 700 and Fraunces 400, 700, OFL, `VisionFonts` | foundation done, screen sweep pending (phase 2b) |

## Dialogs and sheets

| #   | Surface                       | Web                               | Swift                                                  | Status                                           |
| --- | ----------------------------- | --------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| 8   | Dialog                        | `dialog.tsx`                      | `.visionDialog`                                        | foundation done, screen sweep pending (phase 2b) |
| 9   | Alert                         | `alert-dialog.tsx`                | `.visionAlert`                                         | foundation done, screen sweep pending (phase 2b) |
| 10  | Confirmation                  | `useConfirmDialog`                | `.visionConfirmationDialog`                            | foundation done, screen sweep pending (phase 2b) |
| 11  | Side sheet                    | `sheet.tsx`                       | `.visionSideSheet`                                     | foundation done, screen sweep pending (phase 2b) |
| 12  | Scrim, frost and content blur | `.modal-overlay`, `:root.fx-full` | `VisionModalHost`, only under Full effects or Enhanced | foundation done, screen sweep pending (phase 2b) |

## Form controls

| #   | Control                         | Web                                             | Swift                                                                     | Status                                           |
| --- | ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| 13  | Buttons, all variants and sizes | `button.tsx`                                    | `VisionButtonStyles`, `VisionControlMetrics`                              | foundation done, screen sweep pending (phase 2b) |
| 14  | Text field, text editor         | `input.tsx`, `textarea.tsx`                     | shared input chrome, `VisionTextEditorStyle`                              | foundation done, screen sweep pending (phase 2b) |
| 15  | Select                          | `select.tsx`                                    | `VisionSelect` (no popover arrow)                                         | foundation done, screen sweep pending (phase 2b) |
| 16  | Switch, checkbox, radio         | `switch.tsx`, `checkbox.tsx`, `radio-group.tsx` | `VisionToggleStyles`                                                      | foundation done, screen sweep pending (phase 2b) |
| 17  | Segmented control               | `segmented-control.tsx`                         | `VisionSegmentedControl`                                                  | foundation done, screen sweep pending (phase 2b) |
| 18  | Tooltip, badge, link button     | `tooltip.tsx`, `badge.tsx`                      | `VisionTooltip` (child `NSPanel`), `VisionBadge`, `VisionLinkButtonStyle` | foundation done, screen sweep pending (phase 2b) |

## Effects

| #   | Effect                           | Web                                  | Swift                                    | Status                                           |
| --- | -------------------------------- | ------------------------------------ | ---------------------------------------- | ------------------------------------------------ |
| 19  | Full effects switch              | `:root.fx-full`                      | `visionFullEffects`, `VisualEffectsTier` | foundation done, screen sweep pending (phase 2b) |
| 20  | Smooth aurora drift              | `aurora-drift-*-smooth`              | `AuroraCanvas`                           | foundation done, screen sweep pending (phase 2b) |
| 21  | Glass card, hover frame and lift | `card.tsx`                           | `VisionCard`                             | foundation done, screen sweep pending (phase 2b) |
| 22  | Glass toasts and chrome          | `glass-thick`, chrome                | `ActionToast`, `ShellGlassViews`         | foundation done, screen sweep pending (phase 2b) |
| 23  | Canvas text halo                 | `.page-header-title`, `.canvas-text` | `VisionEffects`, `VisionPageHeader`      | foundation done, screen sweep pending (phase 2b) |

## Settings

| #   | Item                            | Web                           | Swift                                            | Status                                           |
| --- | ------------------------------- | ----------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| 24  | Settings as an in-window dialog | `DashboardSettingsDialog.tsx` | `NativeSettingsWindow`, `NativeShellOverlayHost` | foundation done, screen sweep pending (phase 2b) |
| 25  | Unsaved-changes alert           | `useConfirmDialog`            | `.visionAlert`                                   | foundation done, screen sweep pending (phase 2b) |

## Known approximations

No backdrop saturation, no shadow spread, `\.dismiss` inert inside vision dialogs (use `onClose` or
`visionDismissDialog`), no select popover arrow, and a child `NSPanel` for the tooltip. See
[[docs/adr/250-swift-design-system-parity|ADR-250]].

## Related

- [[docs/reference/native-parity/index|Native parity inventory]]
- [[docs/reference/native-parity/shell-and-settings|App shell, navigation, settings and onboarding]]
- [[docs/architecture/native-app|Native app architecture]]
- [[docs/features/appearance|Appearance]]
