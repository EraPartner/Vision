---
title: Appearance Feature
type: feature
status: active
date: 2026-04-20
tags: [feature, appearance, theming, personalization, frontend, settings]
description: Per-user theme variant selection with five color palettes, light/dark mode switching, and schedule-based mode transitions
aliases: [appearance, theming, theme variants, color palettes, dark mode, light mode]
related_code:
  - apps/frontend/src/styles/themes.ts
  - apps/frontend/src/contexts/ThemeContext.tsx
  - apps/frontend/src/components/settings/AppearanceTab.tsx
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
  }
}
```

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

### Reduced Motion

All theme transitions respect `prefers-reduced-motion`:
- If `prefers-reduced-motion: reduce`, variant changes apply instantly without fade effects
- Schedule mode does not animate between light/dark; transitions are instant

## Related Features

- [[docs/features/settings|Settings Feature]] — Settings system overview
- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]] — Design system foundation
- [[docs/adr/025-theme-variant-system|ADR-025: Theme Variant System]] — Architectural decision and token details
- [[docs/api/settings|Settings API]] — Backend API contracts
- [[docs/i18n/translations|Translations & i18n]] — Localization system
- [[apps/frontend/src/styles/themes.ts|Theme Variants Source Code]] — Palette definitions and `applyThemePalette()` function
