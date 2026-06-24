---
title: "ADR-104: Dense-fintech visual skin (skin-v2) behind a flag"
type: adr
status: accepted
date: 2026-06-23
tags: [adr, design-system, css, feature-flag, skin-v2, visual-redesign, tailwind, theming, accessibility, adr-030, adr-075, adr-103, june-2026]
description: Ships a "dense-fintech" visual redesign (Monarch/Copilot spirit) as CSS scoped entirely under a `.skin-v2` root class on <html>, toggled by a build-time env flag VITE_SKIN_V2 (default OFF). Legacy skin renders byte-for-byte unchanged when the class is absent. The flattening redesign (atmosphere/glass/typography/motion/hover) was implemented behind the flag, then reverted at the user's direction; only the colorblind-safe gain/loss recoloring remains behind VITE_SKIN_V2. The aurora, WebGL shader, glass, and hover are retained in the base design. Documents the critical inline-token constraint: applyThemePalette() in themes.ts writes all color tokens as inline styles, defeating any stylesheet override — only structural tokens (radius, blur, motion, aurora alphas) are freely changed from CSS.
aliases: [skin-v2, dense fintech skin, visual redesign, fintech skin flag]
---

# ADR-104: Dense-fintech visual skin (skin-v2) behind a flag

## Status

Revised — 2026-06-23. The flattening redesign described below (atmosphere, glass, typography, motion, hover) was implemented behind the flag, reviewed, and **reverted** at the user's direction: the aurora, WebGL `ShaderAurora`, hybrid glass, and hover glow are all retained in the base design. The only surviving change is the **colorblind-safe gain/loss recoloring** (`.amount-gain`/`.amount-loss` + `--gain`/`--loss` tokens), gated by `VITE_SKIN_V2` — **now ON by default** as of 2026-06-24 (set `VITE_SKIN_V2=false` to ship the legacy gold/red gain-loss). The original goal — reducing the "AI-generated" feel while **preserving** the rich aesthetic — is reopened and unresolved. The decision detail below is retained as a record of the explored (and mostly reverted) direction.

## Context

The app's existing "Apple-luxury" aesthetic, established in ADR-017 and extended through ADR-070 and ADR-071, layers glassmorphism over a drifting aurora "liquid canvas" background, uses Fraunces serif across all heading levels, and adds micro-lift hover translations and specular `::before` overlays on cards. User feedback identified the look as over-decorated and "AI-generated" rather than premium — visually loud for a data-dense financial tool used daily.

The reference aesthetic is the calm, flat, data-first style of tools like Monarch and Copilot: no animated atmosphere, tight radius, utility-grade motion, Inter for headings, and colorblind-safe gain/loss encoding always paired with explicit +/− symbols and directional arrows.

Two requirements shaped the implementation strategy:

1. **Instant rollback**: the production aesthetic must remain fully intact while the redesign is developed and reviewed. Any regression should be reversible without a hotfix deploy.
2. **No branching**: the legacy-skin codebase must not fork. A single component tree must render both skins.

## Decision

### Mechanism: scoped root class + build-time flag

The entire redesign lives in `apps/frontend/src/styles/skin-v2.css`, imported after Tailwind in `apps/frontend/src/index.css`. Every rule in `skin-v2.css` is scoped under `:root.skin-v2`. When that class is absent, `skin-v2.css` contributes zero computed styles — the legacy skin renders byte-for-byte unchanged.

The `.skin-v2` class is applied (or not) by `applySkinV2Class()` in `apps/frontend/src/lib/skin.ts`, which is called synchronously in `apps/frontend/src/main.tsx` before the first React render to avoid a flash of unstyled content.

The build-time default is controlled by `VITE_SKIN_V2` (default `false`), parsed through the ADR-030 `booleanEnv` helper in `apps/frontend/src/lib/env.ts` and exported as `isSkinV2Default`. Rollback is therefore: remove the `.skin-v2` class via the flag, or flip it locally.

### Runtime override for before/after comparison

`lib/skin.ts` additionally checks `localStorage.getItem('vision_skin_v2')`. The string `'true'` activates the skin regardless of the build flag; `'false'` suppresses it. The override lets QA and developers toggle between skins live without a rebuild. In development mode, `window.__setSkinV2(true | false | undefined)` is exposed for convenience (`undefined` clears the override and falls back to the build flag).

```
Priority:  localStorage override > VITE_SKIN_V2 build flag
```

### Why UNLAYERED CSS wins over Tailwind

`skin-v2.css` is imported outside any `@layer` block. Unlayered rules have higher cascade priority than all `@layer`-declared rules (including Tailwind's `base`, `components`, and `utilities` layers), so skin-v2 overrides glass material classes such as `.glass-regular` and `.premium-frame` without fighting specificity races. The trade-off is intentional override duplication — addressed in the Consequences section.

### Critical constraint: inline color tokens

`applyThemePalette()` in `apps/frontend/src/styles/themes.ts` writes all palette color tokens (`--background`, `--foreground`, `--card`, `--primary`, `--accent`, and the full set of `ThemeTokens` keys) as **inline styles** on `document.documentElement` via `root.style.setProperty()`. Inline styles have higher priority than any external stylesheet rule.

**Consequence**: `skin-v2.css` cannot override color token values. The emerald/warm-gold/champagne palette is carried through unchanged. Dark-accent desaturation — one of the originally planned visual changes — requires a `themes.ts` edit and is explicitly deferred.

**What IS freely overridable from CSS**: structural tokens that are not set by `applyThemePalette()`. These include `--radius`, the glass blur size tokens (`--glass-regular-blur`, etc.), `--glass-saturate`, the aurora alpha tokens (`--aurora-primary-alpha`, `--aurora-accent-alpha`, `--aurora-wash-alpha`, `--grain-alpha`), and the motion tokens (`--duration-fast`, `--duration-normal`, `--duration-slow`, `--ease-out-quint`, `--ease-out-expo`, `--ease-in-out-quart`). All of these are changed in Phases 1–2.

### Design direction (locked choices)

- **Typography**: Fraunces serif is restricted to bare `<h1>` page titles and explicit `.font-display` spans (hero numbers). Section and card headings (`h2`, `h3`) switch to Inter via a `:root.skin-v2 :is(h2, h3)` rule that wins by unlayered cascade. `CardTitle` renders as `h3.font-display`; under skin-v2 the font-family rule on `h3` takes precedence.
- **Gain/loss encoding**: Okabe-Ito colorblind-safe colors — green `#009E73` (HSL `162 84% 30%`, dark: `160 65% 52%`) and vermillion `#D55E00` (HSL `24 85% 45%`, dark: `24 90% 62%`) — defined as `--gain` and `--loss` tokens in `skin-v2.css`. These are **always** paired with explicit +/− signs and directional arrows in component markup. Color alone is never the sole signal.
- **Hybrid glass**: cards, hero tiles, sidebar, and top chrome are fully flat (`hsl(var(--card))`). The single retained glass surface is `.glass-thick` (dialogs, popovers, command palette), which keeps a calmed frost: `blur(16px) saturate(1.4)` at `hsl(var(--popover) / 0.86)`.
- **Radius**: tightened from `0.875rem` to `0.5rem` globally. Cards (`.glass-regular.premium-frame`) use `0.625rem` specifically.
- **Motion**: durations shortened (fast 130ms, normal 200ms, slow 280ms); bouncy eases replaced with `cubic-bezier(0, 0, 0.2, 1)` for all ease-out variants.
- **Shadows**: three flat tiers (`--skin-shadow-sm`, `--skin-shadow-md`, `--skin-shadow-overlay`) replace the per-material glass shadows.
- **Aurora**: the CSS radial-gradient blobs and film grain are removed — `--aurora-*-alpha` zeroed and `.liquid-canvas::before`/`::after`/`.liquid-canvas-grain` set to `display: none`. The WebGL **ShaderAurora** (ADR-071, `fx-enhanced` tier) is **retained** by explicit user request: its `<canvas>` is a child of `.liquid-canvas`, so the container stays displayed and only the CSS blob layers are hidden. (An earlier iteration `display:none`'d the whole `.liquid-canvas`, which also hid the shader — corrected.)
- **Interaction**: `.micro-lift:hover` translate stripped; `.premium-frame` hover glow removed; the specular `.glass::before` overlay hidden. Buttons lose the Tailwind `--tw-shadow` drop-glow but retain the `--tw-ring-shadow` focus ring and the `:active scale(0.98)` press feedback.

### Rollout phases

| Phase | Scope | Status | Notes |
|---|---|---|---|
| 0 | Flag scaffold: `VITE_SKIN_V2`, `lib/skin.ts`, `applySkinV2Class()` pre-render call | Implemented | CSS-only, zero JSX changes |
| 1 | Atmosphere + structural tokens: remove CSS aurora blobs (keep WebGL ShaderAurora), flatten glass hierarchy, tighten radius, calm motion | Implemented | CSS-only |
| 2 | Primitives: typography (h2/h3 → Inter), card corners, button shadow reset, success-icon animation | Implemented | CSS-only; `skin-v2-fade-in` keyframe replaces `icon-success-bounce` |
| 3 | Component-level wiring: `--gain`/`--loss` token application with +/− arrows, persisted density toggle, category-pill restyle | **In progress** | Requires JSX changes; gated on `isSkinV2Active()` so legacy skin is unaffected |
| 4 | Accessibility audit + polish | Planned | WCAG AA contrast re-check against emerald palette with new gain/loss tokens |

Phase 3 is the first phase that touches component code. Each skin-v2 branch must be wrapped in `isSkinV2Active()` so that the flag-off path is identical to the current main-branch code.

## Consequences

**Positive**

- Phases 0–2 are completely reversible: flip the flag or remove the class; the legacy skin is unchanged.
- The CSS-only constraint for Phases 0–1–2 means the flag-off build is provably identical to the pre-skin-v2 codebase.
- One stylesheet file (`skin-v2.css`) centralizes all visual overrides; review surface is bounded.
- The `localStorage` override and `window.__setSkinV2` dev helper allow live A/B comparison without rebuilds, reducing QA friction.
- `--gain`/`--loss` tokens define the colorblind-safe encoding in a single place; Phase 3 component changes consume them consistently.

**Negative / cost**

- Phase 3 couples a small number of components to the skin via `isSkinV2Active()` branches. This is a deliberate, contained coupling rather than a pervasive one.
- Build-time flag means CI needs a flag-on build to exercise the skin-v2 code paths. The `localStorage` dev toggle mitigates this for manual review but not for automated visual regression.
- `skin-v2.css` contains intentional override duplication (e.g., resetting every `.glass-*` variant separately) — the verbosity is the price of the unlayered cascade strategy.
- Color token overrides (including dark-accent desaturation) require `themes.ts` changes, not CSS. This deferred work is documented as Phase 4 prep but has no timeline.

**Neutral**

- The emerald/warm-gold palette is unchanged and remains the only supported palette under skin-v2.
- ADR-075 visual-effects tiers (`fx-reduced`, `fx-static-atmosphere`) compose correctly with skin-v2: the tier system operates on `backdrop-filter` presence, while skin-v2 sets `backdrop-filter: none` on most surfaces independently. On `glass-thick` (overlays) both systems can coexist since ADR-075's `fx-reduced` path strips the filter.
- Theme variants (Dracula, Solarized, Nord, High-Contrast) are unaffected in Phase 0–2 because skin-v2 targets structural rather than color tokens.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/030-frontend-env-schema|ADR-030: Frontend env schema]] — `booleanEnv` helper and `VITE_SKIN_V2` registration
- [[docs/adr/103-per-account-holdings-ui-flag|ADR-103: Per-account holdings UI flag]] — precedent for `booleanEnv` build-time flag pattern
- [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075: Visual-effects tiers]] — reduced-transparency fallbacks that compose with skin-v2
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]] — the legacy skin being selectively overridden
- [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070: Liquid Glass v2]] — current production glass vocabulary
- [[docs/adr/071-premium-v3-effects-toggle|ADR-071: Premium v3]] — typography system that skin-v2 overrides for headings
- [[docs/reference/code-patterns#scoped-skin-behind-a-flag-pattern-adr-104|Code Patterns — Scoped-skin flag pattern]]
