---
title: Appearance Feature
type: feature
status: active
date: 2026-04-21
updated: 2026-06-12
tags: [feature, appearance, theming, personalization, frontend, settings, phase-1, visual-effects-tiers, auto-adapt-display, fx-reduced, shader-aurora, webgl, premium-v3, system-accent, vibrancy, electron-native, macos, june-2026, canvas-text, aurora-legibility, liquid-glass-sidebar]
description: Per-user theme variant selection with five color palettes, light/dark mode switching, and schedule-based mode transitions. June 2026 (ADR-075): Visual-effects tier model (reduced/standard/enhanced) + autoAdaptDisplay replaces the ADR-071 enhancedEffects boolean; large-display heuristic auto-drops to reduced on 4K-class screens. June 2026 V12 (ADR-072): system accent color overlay (Electron/macOS only, persisted in theme_settings.systemAccent) and vibrancy gated on effective tier.
aliases: [appearance, theming, theme variants, color palettes, dark mode, light mode, system accent, vibrancy]
related_code:
  - apps/frontend/src/styles/themes.ts
  - apps/frontend/src/contexts/ThemeContext.tsx
  - apps/frontend/src/components/settings/AppearanceTab.tsx
  - apps/frontend/src/lib/accentColor.ts
  - apps/frontend/src/stores/settingsStore.ts
  - apps/node-backend/src/routes/settings.js
---

# Appearance Feature

## Overview

The Appearance system lets users personalize their Vision experience by choosing a theme variant, switching between light and dark modes, and optionally scheduling mode transitions based on time of day. All preferences are stored per-user in the `theme_settings` key and applied immediately across the application.

## Theme Variants

Vision ships with five curated theme variants, each with light and dark sub-palettes:

### 1. Default (Emerald + Gold)

- **Primary**: Emerald (`hsl(161, 83%, 54%)`)
- **Accent**: Champagne Gold (`hsl(73, 87%, 74%)`)
- **Style**: Apple-inspired liquid glass aesthetic
- **Best for**: Premium, cohesive look; broad audience appeal

### 2. Dracula

- **Primary**: Purple (`hsl(265, 100%, 70%)`)
- **Accent**: Pink (`hsl(320, 80%, 60%)`)
- **Style**: Dark-mode optimized, moody atmosphere
- **Best for**: Late-night usage; reduces eye strain in dark rooms

### 3. Solarized

- **Primary**: Yellow-Green (`hsl(68, 80%, 50%)`)
- **Accent**: Blue (`hsl(200, 80%, 55%)`)
- **Style**: High-contrast, reading-friendly
- **Best for**: Extended reading sessions; reduces visual fatigue

### 4. Nord

- **Primary**: Frost Blue (`hsl(220, 60%, 60%)`)
- **Accent**: Aurora Green (`hsl(145, 80%, 55%)`)
- **Style**: Arctic-inspired calm colors
- **Best for**: Minimalist preference; tranquil work environment

### 5. High Contrast

- **Primary**: Navy (`hsl(240, 100%, 20%)`)
- **Accent**: Neon Green (`hsl(120, 100%, 50%)`)
- **Style**: WCAG AAA accessibility-focused
- **Best for**: Low-vision users; compliance with accessibility standards

## Color Token Architecture

All color tokens use HSL (Hue, Saturation, Lightness) components stored as CSS custom properties:

```css
:root {
  --primary-h: 161;     /* Hue (0-360) */
  --primary-s: 83%;     /* Saturation (0-100%) */
  --primary-l: 54%;     /* Lightness (0-100%) */
  
  --accent-h: 73;
  --accent-s: 87%;
  --accent-l: 74%;
  
  /* ... ~25 additional tokens for surfaces, borders, text, etc. */
}
```

Tailwind CSS references these tokens:

```css
.btn-primary {
  background-color: hsl(var(--primary-h), var(--primary-s), var(--primary-l));
}
```

This architecture enables **runtime palette swaps** — changing all colors at once by updating CSS variables, without rebuilding stylesheets.

## Mode System

### Light Mode

- Always display light palette, regardless of system preference
- Background: Light surfaces with high contrast text
- Best for: Bright office environments; daytime usage

### Dark Mode

- Always display dark palette
- Background: Deep charcoal with light text
- Best for: Low-light environments; reduced eye strain

### System Mode (Default)

- Follow the user's OS dark-mode preference (`prefers-color-scheme`)
- Automatically switches when OS theme changes (without page reload)
- Best for: Seamless integration with device settings

### Schedule Mode

- Switch modes based on time of day
- Two time inputs: `lightFrom` and `darkFrom` (both in `HH:MM` format)
- Example: Light theme 6:00 AM – 8:00 PM; dark theme 8:00 PM – 6:00 AM
- Best for: Circadian-aware users; automatic eye-strain reduction

**Schedule Transition Behavior:**

The application evaluates current time against `lightFrom` and `darkFrom`:

```
lightFrom: 06:00, darkFrom: 20:00

Time: 05:59 → dark mode
Time: 06:00 → light mode
Time: 20:00 → dark mode
Time: 23:59 → dark mode
```

Transitions happen immediately on the current page without reload.

## Settings Storage

User preferences are stored in the `theme_settings` JSONB key:

```json
{
  "variant": "default|dracula|solarized|nord|high-contrast",
  "mode": "light|dark|system|schedule",
  "schedule": {
    "lightFrom": "HH:MM",
    "darkFrom": "HH:MM"
  },
  "systemAccent": true
}
```

`systemAccent` is optional. Payloads that omit it hydrate fine (treated as `false`).

### Defaults

New users receive:

```json
{
  "variant": "default",
  "mode": "system",
  "schedule": null
}
```

### Persistence

1. **Live Preview**: Variant or mode change applies immediately to the DOM
2. **Debounced Save**: 500ms after the last change, the full `theme_settings` object is persisted to the backend
3. **localStorage Mirror**: The variant is also written to `localStorage.theme-variant` for FOUC prevention on page reload

## Appearance Settings UI

The Appearance tab in **Settings → Appearance** provides:

### Variant Picker

- Grid of 5 color swatch buttons
- Each swatch shows the variant's primary and accent colors
- Clicking a swatch updates the variant immediately (live preview)
- Selected variant is highlighted with a checkmark or border

### Mode Selector

- Radio button group: Light, Dark, System, Schedule
- Selecting a mode updates the current theme immediately
- If Schedule is selected, time input fields appear below

### Schedule Times (Conditional)

- Only visible when mode is set to "Schedule"
- Two time inputs: "Light theme from" and "Dark theme from"
- Format: `HH:MM` (24-hour time)
- Validation: Rejects invalid times; shows error toast on malformed input

### Save Behavior

- All changes are debounced 500ms and auto-saved
- No explicit "Save" button; settings persist in real-time
- Error toast if validation fails or backend rejects the request

## FOUC Prevention

When a page loads or refreshes, the application must apply the user's theme variant and mode **before React renders**. Without this, users see a flash of the default palette.

**Solution**: Pre-React Flash Script

Located in `apps/frontend/src/theme-flash.ts`, this script:

1. Reads `localStorage.theme-variant` and `localStorage.theme-mode`
2. Resolves the effective mode (e.g., if system mode, checks `prefers-color-scheme`)
3. Calls `applyThemePalette(variant, mode, document.documentElement)`
4. Completes before the first paint

This runs synchronously before React mounts, eliminating the flicker.

## API Integration

### GET /api/settings

Returns the user's current settings, including `theme_settings`:

```json
{
  "defaultCurrency": "EUR",
  "theme_settings": {
    "variant": "dracula",
    "mode": "schedule",
    "schedule": { "lightFrom": "06:00", "darkFrom": "20:00" }
  }
}
```

### PUT /api/settings/:key

Upsert the `theme_settings` key:

```bash
curl -X PUT http://localhost:3002/api/settings/theme_settings \
  -H "Content-Type: application/json" \
  -d '{
    "value": {
      "variant": "solarized",
      "mode": "light"
    }
  }'
```

### PUT /api/settings

Bulk update including `theme_settings`:

```bash
curl -X PUT http://localhost:3002/api/settings \
  -H "Content-Type: application/json" \
  -d '{
    "theme_settings": {
      "variant": "nord",
      "mode": "dark"
    }
  }'
```

### Backend Validation

The backend enforces:
- `variant` must be one of the five allowed values
- `mode` must be `'light'`, `'dark'`, `'system'`, or `'schedule'`
- If `mode` is `'schedule'`, `schedule.lightFrom` and `schedule.darkFrom` must match `HH:MM`
- Invalid requests return `400` with a descriptive error message

## Internationalization

Appearance settings include translated labels and descriptions for both English and Dutch:

### Translation Keys

```
settings.tab.appearance          → "Appearance" / "Uiterlijk"
settings.appearance.variant       → "Theme Variant"
settings.appearance.variantHint   → "Choose a color palette"
settings.appearance.variants.*    → Per-variant names (default, dracula, etc.)
settings.appearance.variantsDesc.*→ Per-variant descriptions
settings.appearance.mode          → "Theme Mode"
settings.appearance.modes.*       → Mode labels (light, dark, system, schedule)
settings.appearance.lightFrom     → "Light theme from"
settings.appearance.darkFrom      → "Dark theme from"
```

All keys are translated in `i18n/source/en.json` and `i18n/source/nl.json`, with outputs generated to `apps/frontend/src/locales/`.

## Browser Support

- **Modern Browsers** (Chrome, Safari, Firefox, Edge): Full support
- **Older Browsers** (IE 11): Graceful fallback to `default` variant; no theme switching
- **Mobile**: Full support; variant swatches adapt to touch input

## Performance

- **Runtime Palette Swaps**: O(n) DOM updates where n = number of CSS variables (~25); no CSS rebuilding
- **FOUC Prevention**: Synchronous flash script runs before React; no render blocking
- **Debounced Persistence**: 500ms debounce prevents excessive API calls during rapid variant changes
- **No Bundle Impact**: No additional theme stylesheets shipped; variants defined in `themes.ts` (JSON data)

## Accessibility

### High Contrast Variant

Meets WCAG AAA accessibility standards:
- Navy (`hsl(240, 100%, 20%)`) primary on light backgrounds exceeds 7:1 contrast ratio
- Neon green accent is distinguishable for colorblind users

### Theme Crossfade (June 2026)

`ThemeContext` now wraps the dark-class flip in `document.startViewTransition` (where supported by the browser) to produce a smooth crossfade between light and dark mode. Falls back to instant flip on unsupported browsers and when `prefers-reduced-motion: reduce` is active.

### Reduced Motion

All theme transitions respect `prefers-reduced-motion`:
- If `prefers-reduced-motion: reduce`, variant changes apply instantly without fade effects; `startViewTransition` is skipped
- Schedule mode does not animate between light/dark; transitions are instant

## Visual Effects Tier Model (ADR-075, June 2026)

> [!info] ADR-075 (2026-06-12) — supersedes the ADR-071 enhancedEffects boolean
> The single `AppSettings.enhancedEffects: boolean` introduced in ADR-071 is replaced by a **tier model** that also auto-adapts based on display size. See [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075]] for the full decision record and rationale (per-display GPU budget, 4K TV docking workflow).

### Tier model

`AppSettings.visualEffects: 'reduced' | 'standard' | 'enhanced'` (default `'standard'`) and `AppSettings.autoAdaptDisplay: boolean` (default `true`), both persisted in the Zustand settings store (`stores/settingsStore.ts`) and applied on dialog Save in Settings → Appearance.

| Tier | Effect |
|------|--------|
| `reduced` | No backdrop-filter glass (near-opaque surfaces), liquid canvas hidden. Mirrors the pre-existing `prefers-reduced-transparency` fallback look. |
| `standard` | CSS aurora blobs + glass materials. Unchanged default look. |
| `enhanced` | Adds WebGL `ShaderAurora` + Electron vibrancy. |

**Effective tier**: `reduced` while `autoAdaptDisplay` is on and the window sits on a large display; otherwise the chosen tier. Turning `autoAdaptDisplay` off is the explicit "don't touch my effects" override.

#### Select shows the effective tier (addendum, 2026-06-12)

The Appearance-tab tier Select always shows the **currently in-use tier on this display** (the effective tier), not the synced preference. This makes the control unambiguous: what you see is what is running.

#### Session-scoped manual override (`sessionTierOverride`)

`settingsStore` carries `sessionTierOverride` and `setSessionTierOverride` outside `appSettings` — it is never serialised or synced, only in-memory for this device and this session. `resolveEffectiveTier(pref, auto, large, sessionOverride?)` accepts it as an optional 4th argument: the override **replaces the auto-adapt cap**, so it only has effect while `autoAdaptDisplay && isLargeDisplay`; on a small display, or when auto-adapt is off, the synced preference governs. An app restart returns large displays to pure auto mode.

**Save routing in `DashboardSettingsDialog`**: the dialog stages a `tierSelection` value (`null` = untouched) and routes it on Save:

- **Capped display** (`autoAdaptDisplay && isLargeDisplay`): changed tier pick → session override (picking `'reduced'` clears the override rather than setting it; synced `visualEffects` is not written).
- **Uncapped display**: changed tier pick → normal synced preference + override cleared.
- **Toggling auto-adapt without touching the tier** → override cleared (auto takes back control).

`resetAppSettings` also clears the session override.

#### Contextual notes under the Select

When the display is auto-capped, a note styled `text-primary` explains the situation (`settings.appearance.visualEffectsAutoNote`). When a session override is active, a note styled `text-warning` informs the user that the override is device-local and will be reclaimed by auto mode after the next app launch (`settings.appearance.visualEffectsOverrideNote`). Both keys are translated in en + nl.

### Large-display detection (`isLargeDisplay`)

`screen.width × screen.height × devicePixelRatio² > 6,000,000` physical px. The threshold sits between the MacBook Air M1 built-in panel (~5.2M px) and 4K outputs (~8.3M px); 1080p/QHD externals at 1× stay below it. Re-evaluated by `useVisualEffectsTier` on `resize` plus a 5-second property-read poll (no DOM event fires reliably on display drag).

### Application points

**`VisualEffectsController`** (`components/layout/VisualEffectsController.tsx`) — renders null, mounted in `AppLayout`. Tags `<html>`:
- `fx-reduced` — effective tier is `reduced`. `index.css` carries a class-selector mirror of the `prefers-reduced-transparency` block (both blocks are deliberately duplicated; the media block must work before React mounts).
- `fx-static-atmosphere` — large display but user kept a higher tier: aurora blobs stop drifting (`animation: none`) so the compositor can idle.

**`AppLayout`** — mounts `ShaderAurora` only when effective tier is `enhanced`.

**`ElectronBridge`** — gates the `vibrancy` html class on the *effective* tier (so vibrancy also drops on large displays when auto-adapt is on).

**`ShaderAurora`** — backing store additionally capped at 640px wide (`MAX_CANVAS_WIDTH`) on top of the 0.25× resolution factor.

### Key files

| File | Role |
|------|------|
| `apps/frontend/src/lib/visualEffects.ts` | `isLargeDisplay()`, `resolveEffectiveTier()` (4-arg, incl. session override) |
| `apps/frontend/src/hooks/useVisualEffectsTier.ts` | Resize + 5s poll hook; reads `sessionTierOverride` from store |
| `apps/frontend/src/components/layout/VisualEffectsController.tsx` | `<html>` class manager |
| `apps/frontend/src/stores/settingsStore.ts` | Persisted state + `migrateAppSettings`; `sessionTierOverride` (non-persisted) |
| `apps/frontend/src/lib/__tests__/visualEffects.test.ts` | 17 unit tests (13 original + 4 override cases) |

### Migration from enhancedEffects boolean

`migrateAppSettings` (applied at hydration in `AppSettingsContext`) converts legacy stored blobs: `enhancedEffects: true → visualEffects: 'enhanced'`; `enhancedEffects: false → visualEffects: 'standard'`. An explicitly stored `visualEffects` value wins without remapping. The legacy key is stripped so the next debounced persist writes the new shape. No backend change — `app_settings` is an opaque JSON blob.

### ShaderAurora technical details

- Raw WebGL (no external dependency) — one fullscreen triangle, 4-octave value-noise fbm.
- Colors tinted from `--primary` and `--accent` CSS vars; re-resolved on theme change via `MutationObserver`.
- Renders at 0.25× resolution, upscaled to full viewport; additionally capped at 640px wide.
- ~30 fps cap (rAF-throttled).
- Single static frame when `prefers-reduced-motion: reduce` is active.
- rAF paused when `document.hidden` (tab not visible).
- Any WebGL context creation failure → silently falls back to CSS blobs only (no error shown).
- **Dark-mode canvas opacity**: `dark:opacity-50`. Reduces peak brightness so the text legibility halo can do its job without excessive shadow values.

**Aurora blob alpha tokens (CSS fallback, dark mode)**: `--aurora-primary-alpha: 0.13`, `--aurora-accent-alpha: 0.10`, `--aurora-wash-alpha: 0.08`. This reduces the brightness ceiling the text legibility halo has to overcome.

**Canvas-text legibility guarantee (dark mode)**: A background-colored text-shadow halo is applied globally in dark mode to `h1/h2/h3/.font-display` and to any subtree marked `.canvas-text`. `PageHeader` applies `canvas-text`, so every page's title/subtitle area is covered automatically. Muted text (`.text-muted-foreground`) inside `.canvas-text` subtrees is lifted to `foreground/0.72` in dark mode. All three measures are `.dark`-scoped; light mode is structurally unaffected.

See [[docs/components/ui-components#canvas-text-legibility-guarantee-june-2026|Canvas-Text Legibility Guarantee]] for full details.

**Liquid-glass sidebar**: `.glass-chrome` background alphas were lowered to 0.55→0.72 (light) / 0.55→0.74 (dark), allowing the aurora and Electron vibrancy to glow through the sidebar blur. A `@supports not (backdrop-filter)` rule keeps a near-opaque fallback for browsers without blur support. See [[docs/components/ui-components#glass-chrome-sidebar-transparency-june-2026|glass-chrome entry]] for token values.

**Vibrancy gate**: `ElectronBridge` gates the `vibrancy` html class on the *effective* tier. The window is always created with `vibrancy: 'under-window'` + `visualEffectState: 'followWindow'`; body becomes translucent (`hsl(var(--background) / 0.72)`) only when the effective tier is `enhanced`. This means vibrancy is automatically disabled on large displays even if the chosen tier is `enhanced`. See [[docs/architecture/electron|Electron Architecture — Under-Window Vibrancy]].

**i18n keys** (en + nl):
- Added (ADR-075 original): `settings.appearance.visualEffects`, `settings.appearance.visualEffects.reduced`, `settings.appearance.visualEffects.standard`, `settings.appearance.visualEffects.enhanced`, `settings.appearance.visualEffectsHint`, `settings.appearance.autoAdaptDisplay`, `settings.appearance.autoAdaptDisplayHint`
- Added (addendum 2026-06-12): `settings.appearance.visualEffectsAutoNote`, `settings.appearance.visualEffectsOverrideNote`
- Removed: `settings.general.enhancedEffects`, `settings.general.enhancedEffectsHint`

Code links: [[apps/frontend/src/lib/visualEffects.ts]], [[apps/frontend/src/hooks/useVisualEffectsTier.ts]], [[apps/frontend/src/components/layout/VisualEffectsController.tsx]], [[apps/frontend/src/components/layout/ShaderAurora.tsx]], [[apps/frontend/src/stores/settingsStore.ts]], [[apps/frontend/src/components/settings/AppearanceTab.tsx]]

---

## System Accent Color (Electron/macOS Only, V12 June 2026 — ADR-072)

> [!info] Added in ADR-072
> **"Use system accent color"** Switch in **Settings → Appearance**, rendered only when `isElectronMac()` returns true.

### What it does

When enabled, `ThemeContext` re-applies `applyThemePalette` (resets all variant tokens) and then **overlays** the macOS system accent color onto five CSS custom properties:

| Property | Role |
|----------|------|
| `--primary` / `--primary-foreground` | Buttons, links, active indicators |
| `--ring` | Focus rings |
| `--sidebar-primary` / `--sidebar-primary-foreground` | Sidebar active-item highlight |
| `--sidebar-ring` | Sidebar focus ring |

Because `applyThemePalette` runs first, the overlay **composes with all five theme variants and both light/dark modes** — it is not a sixth variant.

### Implementation details

- **`lib/accentColor.ts`** — `hexToHslComponents(rrggbbaa)` converts Electron's RRGGBBAA hex string to `"h s% l%"` component form. `accentForegroundComponents(h, s, l)` picks a WCAG-contrast foreground: ink for yellow/green accents, white for blue/purple.
- **`settingsStore.ts`** — adds `themeSystemAccent: boolean` + `setThemeSystemAccent` with hydration support. The flag is persisted inside the existing `theme_settings` blob under the key `systemAccent`.
- **`ThemeContext.tsx`** — An **epoch counter** ensures that stale async accent-color fetches arriving out-of-order do not overwrite a more recent apply. Live re-tint on `AppleColorPreferencesChangedNotification` (pushed via `electronAPI.onAccentColorChanged`).
- Toggling off self-heals: `applyThemePalette` resets every token back to the active variant's values.

### Degradation

- On non-Electron / non-macOS builds the Switch is hidden entirely.
- If `getAccentColor()` fails (permissions, OS version), the overlay is silently skipped; the active variant is left unchanged.

**i18n keys**: `settings.appearance.systemAccent`, `settings.appearance.systemAccentHint` (en + nl, +2 keys from ADR-072).

Code links: [[apps/frontend/src/lib/accentColor.ts]], [[apps/frontend/src/contexts/ThemeContext.tsx]], [[apps/frontend/src/stores/settingsStore.ts]], [[apps/frontend/src/components/settings/AppearanceTab.tsx]]

---

## Related Features

- [[docs/features/settings|Settings Feature]] — Settings system overview
- [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075: Visual-Effects Tiers and Per-Display Auto-Adaptation]] — Tier model + large-display heuristic (2026-06-12)
- [[docs/adr/072-electron-native-desktop-integration|ADR-072: Electron-Native Desktop Integration]] — System accent overlay, vibrancy opt-in (June 2026)
- [[docs/adr/071-premium-v3-effects-toggle|ADR-071: Premium v3]] — Original effects toggle + full Premium v3 batch; enhancedEffects boolean superseded by ADR-075 (June 2026)
- [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070: Liquid Glass v2]] — Theme crossfade via `startViewTransition` (June 2026)
- [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020: Glass System Downgrade]] — GPU budget rationale (Electron M1)
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]] — Design system foundation
- [[docs/adr/025-theme-variant-system|ADR-025: Theme Variant System]] — Architectural decision and token details
- [[docs/architecture/electron|Electron Architecture]] — Under-window vibrancy, system accent IPC
- [[docs/api/settings|Settings API]] — Backend API contracts
- [[docs/i18n/translations|Translations & i18n]] — Localization system
- [[apps/frontend/src/styles/themes.ts|Theme Variants Source Code]] — Palette definitions and `applyThemePalette()` function
