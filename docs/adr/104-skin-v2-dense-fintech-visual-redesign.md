---
title: "ADR-104: Dense-fintech visual skin (skin-v2) behind a flag"
type: adr
status: accepted
date: 2026-06-23
updated: 2026-06-24
tags: [adr, design-system, css, feature-flag, skin-v2, visual-redesign, tailwind, theming, accessibility, adr-030, adr-075, adr-103, june-2026, gain-loss, css-tokens, tailwind-colors]
description: Ships a "dense-fintech" visual redesign (Monarch/Copilot spirit) as CSS scoped entirely under a `.skin-v2` root class on <html>, toggled by a build-time env flag VITE_SKIN_V2 (default OFF). Legacy skin renders byte-for-byte unchanged when the class is absent. The flattening redesign (atmosphere/glass/typography/motion/hover) was implemented behind the flag, then reverted at the user's direction; only the colorblind-safe gain/loss recoloring remains behind VITE_SKIN_V2. The aurora, WebGL shader, glass, and hover are retained in the base design. Documents the critical inline-token constraint: applyThemePalette() in themes.ts writes all color tokens as inline styles, defeating any stylesheet override — only structural tokens (radius, blur, motion, aurora alphas) are freely changed from CSS. Addendum 2026-06-24 (initial): colorblind palette promoted to persisted user setting (colorblindGainLoss). Addendum 2026-06-24 (follow-up): default changed to OFF/classic (colorblindGainLoss false, VITE_SKIN_V2 false); --gain/--loss tokens unified app-wide via tokens.css + skin-v2.css overrides; gain/loss Tailwind color utilities added; glass-trend classes re-pointed then deleted in gain/loss consistency pass; ~35 components swept to use gain/loss tokens. Addendum 2026-06-24 (gain/loss consistency pass): .glass-trend-up/.glass-trend-down/.liquid-glass-trend-* deleted from index.css; TrendHue shared component introduced as sole card-hue delivery mechanism.
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
- [[docs/features/appearance|Appearance Feature]] — gain & loss colors UI in Settings → Appearance → Accessibility

---

## Addendum — 2026-06-24: Colorblind palette promoted to user setting

**What changed:** The colorblind-safe gain/loss palette (`.skin-v2` class, green gain / orange loss) was previously controlled exclusively by the `VITE_SKIN_V2` build flag with a `localStorage` dev override. As of 2026-06-24, it is additionally exposed as a **persisted user setting** (`colorblindGainLoss: boolean`, default `true`) in `AppSettings`.

**Mechanism:**
- `AppSettingsProvider` (`stores/hydration/AppSettingsHydration.tsx`) calls `setSkinV2(appSettings.colorblindGainLoss)` on hydration and on change. This means the stored setting governs the `.skin-v2` class for logged-in users, regardless of the build flag.
- Default is `true` — the colorblind-safe palette is on by default for all users, even when `VITE_SKIN_V2=false` at build time. Users who prefer the classic gold/red palette can switch via **Settings → Appearance → Accessibility → Gain & loss colors → Classic (red loss)**.
- The build flag retains its role as the pre-React FOUC-prevention default (applied synchronously in `main.tsx` before first render). Once settings hydrate, the stored `colorblindGainLoss` value takes over.

**Priority order (updated):**
```
Stored colorblindGainLoss setting (post-hydration)
  > localStorage override vision_skin_v2 (dev/QA)
  > VITE_SKIN_V2 build flag (pre-hydration default)
```

**This decision does not alter the scoping, encoding, or CSS of the colorblind palette.** The gain/loss token values (`--gain`, `--loss`), the `.skin-v2` class mechanism, and the unlayered cascade strategy are unchanged. This is purely an upgrade in *who controls the toggle* — from build-time-only to also user-time.

**Files changed:**
- `apps/frontend/src/stores/settingsStore.ts` — `colorblindGainLoss: boolean` field, default `true`
- `apps/frontend/src/contexts/AppSettingsContext.tsx` — `setSkinV2(appSettings.colorblindGainLoss)` effect
- `apps/frontend/src/components/settings/sections/AppearanceSection.tsx` — Accessibility group + Select
- `i18n/source/en.json`, `i18n/source/nl.json` — 5 new keys (`settings.group.accessibility`, `settings.appearance.gainLossColors`, `settings.appearance.gainLossColorsHint`, `settings.appearance.gainLossColors.colorblind`, `settings.appearance.gainLossColors.classic`)

---

## Addendum — 2026-06-24 (follow-up): Default flipped to OFF/classic; `--gain`/`--loss` tokens unified app-wide

**What changed:**

1. **Default flipped to OFF (classic red/gold).**
   - `stores/settingsStore.ts`: `DEFAULT_APP_SETTINGS.colorblindGainLoss` changed from `true` to `false`.
   - `lib/env.ts`: `VITE_SKIN_V2` build-flag default changed from `true` to `false`. This flag is only the first-paint FOUC fallback before the persisted setting hydrates; the user setting is the source of truth for logged-in users.
   - The app now ships with classic gold-gain (`--gain: var(--accent)`) / red-loss (`--loss: var(--destructive)`) by default. The colorblind-safe Okabe-Ito palette (green/orange) is opt-in via **Settings → Appearance → Accessibility → Gain & loss colors → Colorblind-safe (orange loss)**.

2. **`--gain` / `--loss` tokens unified app-wide.**
   - `styles/tokens.css` now defines `--gain: var(--accent)` and `--loss: var(--destructive)` at `:root` as always-present legacy values. These act as the classic-mode baseline.
   - `styles/skin-v2.css` overrides **only** these two tokens (Okabe-Ito values, light + dark), replacing the old per-class `.amount-gain`/`.amount-loss` rules that were removed as redundant.
   - `index.css`: `.amount-gain`/`.amount-loss` now read `hsl(var(--gain))`/`hsl(var(--loss))`; `.glass-trend-up`/`.glass-trend-down` (and `.liquid-glass-trend-*`) re-pointed from `--success`/`--destructive` to `--gain`/`--loss`.
   - `apps/frontend/tailwind.config.ts`: `gain` and `loss` semantic Tailwind colors registered (`hsl(var(--gain) / <alpha-value>)` etc.), enabling `text-gain`, `bg-loss/12`, `from-gain/20`, `ring-loss/25`, `border-loss/30`, etc. — all toggle-reactive with opacity support.
   - Charts: gain/loss fills/strokes use `hsl(var(--gain))` / `hsl(var(--loss))` strings (reactive via CSS; no JS hook). `DeltaPill` and ~35 component/page files swept from raw `text-success`/`text-destructive`/`text-accent`/`--primary` to these tokens/utilities.
   - Generic destructive/success/status UI (delete, errors, import-complete, health badges) intentionally left unchanged on `--destructive`/`--success`.

**Contributor rule established:** Any gain/loss-semantic color must use `.amount-gain`/`.amount-loss`, the `gain`/`loss` Tailwind utilities, or `hsl(var(--gain))`/`hsl(var(--loss))` — never raw success/destructive/accent.

**Files changed (this follow-up):**
- `apps/frontend/src/stores/settingsStore.ts` — `colorblindGainLoss` default `false`
- `apps/frontend/src/lib/env.ts` — `VITE_SKIN_V2` default `false`
- `apps/frontend/src/styles/tokens.css` — added `--gain`, `--loss` at `:root`
- `apps/frontend/src/styles/skin-v2.css` — overrides `--gain`/`--loss` only; removed old `.amount-gain`/`.amount-loss` per-class rules
- `apps/frontend/src/index.css` — `.amount-gain`/`.amount-loss` re-pointed; `.glass-trend-*` re-pointed
- `apps/frontend/tailwind.config.ts` — `gain`, `loss` color entries added

---

## Addendum — 2026-06-24 (gain/loss colour consistency pass): Orphaned glass-trend classes deleted; TrendHue introduced

**What changed:**

A cross-app gain/loss colour-consistency sweep consolidated all card-hue tint rendering into a single shared component.

1. **New `TrendHue` component** (`apps/frontend/src/components/shared/TrendHue.tsx`) — renders the `bg-gradient-to-br from-{gain|loss|primary}/10 to-.../5` diagonal wash as an `absolute inset-0 pointer-events-none rounded-[inherit]` overlay. Props: `variant: "gain" | "loss" | "neutral"`. This is now the sole mechanism for delivering the card background hue across all summary/stat cards.

2. **Orphaned `.glass-trend-*` classes deleted** — `.glass-trend-up`, `.glass-trend-down`, `.liquid-glass-trend-up`, `.liquid-glass-trend-down` (light + dark) have been removed from `apps/frontend/src/index.css`. After `PerformancePage` migrated off them to `<TrendHue>`, no consumer remained.

3. **Performance page gain/loss border removed** — `PerformancePage` CompactReturnCard and TotalValueCard previously used the `liquid-glass-trend-up/down` classes which added a coloured border. That border is removed for cross-app consistency. The hue wash is preserved via `<TrendHue>`.

4. **`TotalValueCard` (portfolio overview)** gained an `isGain` prop and now renders `<TrendHue>` (previously had no hue at all).

5. **`StatCard` (dashboard)** renders `<TrendHue>` instead of an inline gradient div; gained `valueClassName` prop (default `"text-foreground"`) for featured-total headline colour override.

**Unified colour-role rule (established by this pass):**

| Surface | Rule |
|---|---|
| Card background tint | `<TrendHue variant="gain|loss|neutral" />` — 0.10 opacity; neutral border everywhere |
| Featured total headline | `text-primary` |
| Directional figures | `amount-gain` / `amount-loss` |
| Component figures | `text-foreground` (neutral) |

**Files changed:**
- `apps/frontend/src/components/shared/TrendHue.tsx` — new component
- `apps/frontend/src/components/dashboard/StatCard.tsx` — uses `<TrendHue>`; `valueClassName` prop added
- `apps/frontend/src/components/portfolio/TotalValueCard.tsx` — `isGain` prop; uses `<TrendHue>`
- `apps/frontend/src/pages/portfolio/PerformancePage.tsx` — CompactReturnCard + TotalValueCard off `liquid-glass-trend-*`; compact returns coloured `amount-gain`/`amount-loss`; total value headline `text-primary`
- `apps/frontend/src/pages/portfolio/PortfolioOverviewPage.tsx` — passes `isGain` to TotalValueCard; 3 summary cards use `<TrendHue>`
- `apps/frontend/src/pages/portfolio/net-worth/NetWorthPage.tsx` — featured StatCard passes `valueClassName="text-primary"`
- `apps/frontend/src/index.css` — `.glass-trend-up`, `.glass-trend-down`, `.liquid-glass-trend-up`, `.liquid-glass-trend-down` deleted
