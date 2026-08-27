---
title: "ADR-105: Apple-refined visual pass — refined geometry, jewel accent, and glass differentiation as base design"
type: adr
status: accepted
date: 2026-06-23
tags: [adr, design-system, css, tokens, glass, visual-identity, typography, motion, jewel-emerald, radius, hairlines, june-2026, adr-104, adr-017, adr-070, adr-071, adr-075]
description: Bakes an "Apple-refined" visual pass into the base design (not behind a flag). Tightens geometry (--radius 0.875rem → 0.625rem; Card rounded-[0.75rem]), differentiates glass-regular vs glass-elevated shadows, switches --primary/--ring/--sidebar-primary/--sidebar-ring to a bespoke jewel-emerald (light 164 78% 26% / dark 160 74% 52%), replaces both ease-out motion curves with the Apple/Vaul spring shape cubic-bezier(0.32,0.72,0,1), sets .press-feedback:active scale to 0.97, adds .tabular-nums letter-spacing -0.006em, and introduces 0.5px hairline borders on hi-dpi for glass-regular/premium-frame/glass-thin. Follows ADR-104's revert of the flatten direction; the surviving skin-v2 surface (VITE_SKIN_V2 gain/loss recoloring) is independent and unaffected.
aliases: [apple-refined pass, jewel emerald, refined geometry, glass differentiation, hairlines, adr-105]
---

# ADR-105: Apple-refined visual pass — refined geometry, jewel accent, and glass differentiation as base design

## Status

Accepted — 2026-06-23

## Context

ADR-104 explored a "dense-fintech" direction (Monarch/Copilot spirit) that ultimately flattened too much: the aurora, WebGL `ShaderAurora`, glass materials, and hover glow were all retained by explicit user decision, and the flatten direction was reverted. What remained was the original open question: *how do we reduce the "AI-generated" sameness while keeping the richness?*

Research into Apple's craft (HIG, WWDC25 "Liquid Glass", WWDC19 dark mode, and bjango's optical-adjustment writing) reframed the problem: the "AI slop" signal is **sameness** — one shadow depth, one corner radius, one spacing step everywhere, which is the statistical mean of shadcn/Tailwind defaults — not richness. Apple's aesthetic reads as "clean" because it applies **optical resolution within richness**: differentiated elevation, tuned geometry, spring-shaped motion curves, and per-context material weights. The fix is "refine, don't flatten."

A temporary evaluation harness was built (`lib/feel.ts` + `styles/feels.css`, localStorage-driven, inline-token observer) with two feel candidates ("refined" / "crisp") and two accent candidates ("jewel" / "pine"). Once "refined + jewel" was chosen, the harness was removed and the winning values were baked directly into the base tokens.

## Decision

All changes are in the base design and apply at all times. **None of these are behind a flag.**

### Geometry

- `--radius`: `0.875rem` → `0.625rem` (verified: `apps/frontend/src/styles/tokens.css` line 50: `--radius: 0.625rem`).
- `Card` component base class: `rounded-2xl` → `rounded-[0.75rem]` — slightly larger than `--radius` to give cards a softer feel than interactive elements while both are tighter than before (verified: `apps/frontend/src/components/ui/card.tsx` line 9: `rounded-[0.75rem]`).

The user explicitly preferred "tighter, straighter edges" but not fully sharp. `--radius` governs buttons, inputs, and chips; cards land at `0.75rem`.

### Typography

- Tabular figures (`.tabular-nums`) now carry `letter-spacing: -0.006em` to counteract the tracking widening that `font-variant-numeric: tabular-nums` introduces at Inter's optical size (verified: `apps/frontend/src/index.css` lines 929–931).
- Heading negative tracking (`-0.02em` on h1/h2/h3/.font-display) is unchanged.
- Font stack: Fraunces Variable (display) + Inter Variable (body) is retained — it mirrors Apple's own serif-for-display / sans-for-chrome model and was not identified as an "AI tell."

### Motion

Both ease-out motion tokens set to the Apple/Vaul spring-shaped curve (verified: `apps/frontend/src/styles/tokens.css` lines 107–108):

```
--ease-out-expo:   cubic-bezier(0.32, 0.72, 0, 1)
--ease-out-quint:  cubic-bezier(0.32, 0.72, 0, 1)
```

This is the same curve used by Vaul's sheet and Apple's spring-damped panel transitions. It begins fast and settles gradually, which reads as "snappy without bouncing."

Active press feedback tightened: `.press-feedback:active` → `scale(0.97)` (was `0.98`). Verified in `apps/frontend/src/index.css` line 784.

### Glass material differentiation

The "same shadow on everything" flat tell has been eliminated by giving `glass-regular` (cards) and `glass-elevated` (hero tiles/KPIs) distinct shadow signatures, while keeping the glass background, blur, and border completely intact.

**`glass-regular` (light)**: `inset 0 1px 0 hsl(var(--glass-highlight) / 0.6)` + soft exterior `0 6px 20px -8px hsl(var(--glass-shadow) / 0.14)` — a single crisp specular top-highlight, shallow drop shadow (verified: `apps/frontend/src/index.css` lines 246–247).

**`glass-regular` (dark)**: `inset 0 1px 0 hsl(var(--glass-highlight) / 0.12)` + `0 8px 24px -8px hsl(0 0% 0% / 0.5)` — stronger exterior depth in dark (verified: `apps/frontend/src/index.css` lines 263–264).

**`glass-elevated` (light)**: `inset 0 1px 0 hsl(var(--glass-highlight) / 0.72)` — brighter specular — + `0 18px 46px -16px hsl(var(--glass-shadow) / 0.30)` — substantially deeper exterior lift (verified: `apps/frontend/src/index.css` lines 357–358).

**`glass-elevated` (dark)**: `inset 0 1px 0 hsl(var(--glass-highlight) / 0.18)` + `0 22px 56px -18px hsl(0 0% 0% / 0.72)` — the deepest shadow in the hierarchy (verified: `apps/frontend/src/index.css` lines 373–374).

The previous state had nearly identical shadow parameters on both tiers; now a card looks like a card and a hero tile looks like something you could pick up.

### Hairlines on hi-dpi

New `@media (min-resolution: 2dppx)` rule sets `border-width: 0.5px` on `.glass-regular`, `.premium-frame`, and `.glass-thin` (verified: `apps/frontend/src/index.css` lines 933–939). On Retina/high-DPI screens this renders a true sub-pixel line, matching Apple's own card borders in macOS and iOS apps.

### Accent color — jewel emerald

The previous emerald primary was Tailwind's stock `emerald-700` / `emerald-400` — a recognizable "AI default." Replaced with a bespoke "jewel emerald" in both `tokens.css` and `themes.ts` `defaultLight`/`defaultDark`:

| Token | Light (HSL components) | Dark (HSL components) |
|---|---|---|
| `--primary` | `164 78% 26%` | `160 74% 52%` |
| `--ring` | `164 78% 26%` | `160 74% 52%` |
| `--sidebar-primary` | `164 78% 26%` | `160 74% 52%` |
| `--sidebar-ring` | `164 78% 26%` | `160 74% 52%` |

The light value (`164 78% 26%`) is slightly deeper and more saturated than stock, sitting between Tailwind `emerald-700` and `emerald-800` but shifted toward teal. The dark value (`160 74% 52%`) is more luminous than stock `emerald-400` with a cooler hue. Verified in:
- `apps/frontend/src/styles/tokens.css` lines 33, 41, 73, 78, 141, 149, 179, 184
- `apps/frontend/src/styles/themes.ts` `defaultLight` (lines 109, 113, 129, 134) and `defaultDark` (lines 157, 162, 178, 184)

The champagne-gold `--accent` (`38 58% 52%` / `42 72% 66%`) is unchanged.

> [!note] Inline-token constraint (from ADR-104)
> `applyThemePalette()` in `themes.ts` writes all color tokens as `element.style.setProperty()` inline styles. Because the `default` variant in `themes.ts` now mirrors the jewel values, switching away from the default variant and back will correctly restore the jewel palette. Alternative theme variants (Dracula, Solarized, Nord, High-Contrast) are unaffected — they define their own primary values.

### What was explicitly NOT changed

- Aurora CSS radial blobs, film grain, and `liquid-canvas` layers: retained.
- WebGL `ShaderAurora` (ADR-071): retained.
- Hybrid glass material classes (background gradient, `backdrop-filter` blur/saturate, glass border): untouched, only shadows differentiated.
- `.micro-lift:hover` translate and `.premium-frame` hover glow: retained.
- Fraunces / Inter font stack: retained.

### Evaluation harness (removed)

A temporary toggle harness was built to evaluate candidates:
- `apps/frontend/src/lib/feel.ts` — localStorage-driven feel/accent selector
- `apps/frontend/src/styles/feels.css` — CSS custom property overrides per candidate
- Exposed `window.__setFeel(feel, accent)` and a `<div id="feel-switcher">` toggle panel

Once "refined + jewel" was selected, the harness files were deleted and the winning values baked into the base. The `localStorage` keys (`vision_feel`, `vision_accent`) and `window.__set*` helpers no longer exist.

### Deferred

**Apple's label-opacity text hierarchy** (primary text 1.0 / secondary 0.6 / tertiary 0.3 / quaternary 0.18) — needs a token-level change, not CSS, to avoid inconsistency with the existing `muted-foreground` opacity variants (`.text-muted-foreground/90`, etc.) that components use directly. Deferred to a separate ADR.

## Consequences

**Positive**

- The "AI-generated sameness" tell is reduced through optical resolution rather than flattening — the rich aesthetic is preserved and deepened.
- Differentiated glass elevation is now legible: cards read as cards, hero tiles read as prominently elevated.
- The jewel emerald de-defaults a stock color without breaking any existing design token contract.
- Hairlines at 0.5px on Retina are visually identical to Apple's own card borders on macOS/iOS.
- The spring-shaped ease-out curve is the same one Apple uses for panel transitions; the motion now "feels native."

**Negative / cost**

- The base visual identity has changed (palette, geometry, shadows, motion). The flag-off design is no longer byte-for-byte the pre-ADR-104 codebase. Rollback is via git.
- Alternative theme variants (`themes.ts`) were not given jewel primaries — those remain their own palettes. Only the `default` variant picks up the jewel emerald.
- The label-opacity text hierarchy deferred — text hierarchy remains as-is until a follow-up ADR addresses it.

**Neutral**

- `VITE_SKIN_V2` and the colorblind-safe gain/loss recoloring (ADR-104's surviving piece) are completely independent and unaffected by this ADR. That flag still gates only `.amount-gain`/`.amount-loss` → `--gain`/`--loss` colors.
- ADR-075 visual-effects tiers (`fx-reduced`, `fx-static-atmosphere`) compose correctly: they operate on `backdrop-filter` presence and aurora animation, neither of which this ADR touches.
- The `prefers-reduced-motion` and `prefers-reduced-transparency` fallbacks in `index.css` are unaffected.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/104-skin-v2-dense-fintech-visual-redesign|ADR-104: Dense-fintech visual skin (skin-v2)]] — the flatten direction that was reverted; VITE_SKIN_V2 gain/loss flag remains active and independent
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]] — the original design system this refines
- [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070: Liquid Glass v2]] — established the current glass material vocabulary and blur tiers
- [[docs/adr/071-premium-v3-effects-toggle|ADR-071: Premium v3]] — ShaderAurora and typography system that this ADR keeps intact
- [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075: Visual-effects tiers]] — reduced/standard/enhanced tier system; composes cleanly with this ADR
## Implementation note — 2026-08-27

Material shadow geometry and alpha remain unchanged, but every dark and sticky-column shadow now reads its hue from `--glass-shadow` instead of literal black. This lets each theme variant preserve the same depth model with its own shadow hue. Warning and neutral-information surfaces likewise route through the existing `warning` token and the new theme-level `info` token; gain/loss remains governed only by `--gain` and `--loss`.

The later semantic-color sweep removed the transitional `.amount-gain` and `.amount-loss` aliases. Production components now use `text-gain` and `text-loss` directly, while `VITE_SKIN_V2` still changes the underlying `--gain` and `--loss` token values. Custom charts also read their categorical colors from the shared chart-palette utility instead of local arrays.
