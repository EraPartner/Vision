---
title: ADR-025 Theme Variant System
type: adr
status: Accepted
date: 2026-04-20
tags: [adr, design, frontend, theming, tokens, appearance, phase-9]
description: Per-user theme variant selection with five palettes, light/dark mode matrix, HSL token architecture, and FOUC prevention
aliases: [adr-025, theme variants, appearance settings, color palettes]
---

# ADR-025: Theme Variant System

## Status
Accepted

## Date
2026-04-20

## Context

Vision's liquid-glass design system (ADR-017) established a premium emerald + champagne-gold palette and glass material hierarchy. However, users have different color preferences, accessibility needs, and visual sensibilities. Supporting multiple theme variants (each with light and dark sub-palettes) enhances inclusivity and personalization.

The implementation required:
1. A runtime palette-swapping system that applies variant-specific color tokens without full CSS regeneration
2. Prevention of Flash of Unstyled Content (FOUC) on page load or after refresh
3. Storage of user preference in backend settings with validation
4. TypeScript type safety for variant enumeration and token wiring to Tailwind `hsl(var(--X))`

## Decision

### 1. Five Theme Variants

Ship with five curated theme variants, each including light and dark sub-palettes:

| Variant | Primary Color | Accent Color | Aesthetic |
|---------|---------------|--------------|-----------|
| `default` | Emerald | Champagne Gold | Apple liquid glass (existing) |
| `dracula` | Purple | Pink | Dark-mode optimized, moody |
| `solarized` | Yellow-green | Blue | High contrast, reading-friendly |
| `nord` | Frost Blue | Aurora | Arctic-inspired, calm |
| `high-contrast` | Navy | Neon Green | WCAG AAA accessibility-focused |

### 2. HSL Token Architecture

All color tokens use HSL components for runtime value substitution:

**Location**: `apps/frontend/src/styles/themes.ts`

```typescript
type ThemeVariant = 'default' | 'dracula' | 'solarized' | 'nord' | 'high-contrast';

interface TokenValue {
  light: string; // e.g., "hsl(50, 97%, 75%)"
  dark: string;
}

const themes: Record<ThemeVariant, Record<string, TokenValue>> = {
  default: {
    primary: { light: "hsl(161, 83%, 54%)", dark: "hsl(161, 83%, 54%)" },
    accent: { light: "hsl(73, 87%, 74%)", dark: "hsl(73, 87%, 74%)" },
    // ... all other tokens
  },
  dracula: {
    primary: { light: "hsl(265, 100%, 70%)", dark: "hsl(265, 100%, 65%)" },
    // ...
  },
  // ...
};
```

Tailwind CSS uses `hsl(var(--primary-h), var(--primary-s), var(--primary-l))` in config, enabling runtime palette swaps via `document.documentElement.style.setProperty('--primary-h', '161')`.

### 3. Runtime Palette Application

**Function**: `applyThemePalette(variant, mode, root)`

Located in `apps/frontend/src/styles/themes.ts`:

```typescript
export function applyThemePalette(
  variant: ThemeVariant,
  mode: 'light' | 'dark',
  root: HTMLElement
): void {
  const themeTokens = themes[variant];
  const allTokens = TOKEN_KEYS.map(key => {
    const value = themeTokens[key][mode];
    const [h, s, l] = parseHslString(value);
    return { key, h, s, l };
  });
  
  allTokens.forEach(({ key, h, s, l }) => {
    root.style.setProperty(`--${key}-h`, h);
    root.style.setProperty(`--${key}-s`, s);
    root.style.setProperty(`--${key}-l`, l);
  });
}
```

No CSS regeneration; no bundling additional stylesheets. Pure JavaScript DOM manipulation.

### 4. FOUC Prevention

**Strategy**: Pre-React Flash Script

**Location**: `apps/frontend/src/theme-flash.ts` (inline in `index.html`)

Runs before React mounts:

```typescript
(function initTheme() {
  const storedVariant = localStorage.getItem('theme-variant') ?? 'default';
  const storedMode = localStorage.getItem('theme-mode') ?? 'system';
  
  const resolvedMode = storedMode === 'system' 
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : storedMode;
  
  applyThemePalette(storedVariant as ThemeVariant, resolvedMode, document.documentElement);
})();
```

This runs synchronously before the first paint, eliminating the flicker.

### 5. Context Integration & Persistence

**Location**: `apps/frontend/src/contexts/ThemeContext.tsx`

Context extends `ThemeContextValue`:

```typescript
interface ThemeContextValue {
  mode: 'light' | 'dark' | 'system' | 'schedule';
  schedule?: { lightFrom: string; darkFrom: string }; // "HH:MM"
  variant: ThemeVariant;
  setMode: (mode) => void;
  setVariant: (variant: ThemeVariant) => void;
}
```

On variant change:
1. Apply palette to DOM immediately (live preview)
2. Write to localStorage mirror
3. Debounce 500ms and persist full `{ mode, schedule, variant }` to backend `theme_settings` key

### 6. Backend Validation

**Location**: `apps/node-backend/src/routes/settings.js`

New `validateThemeSettingsValue` enforcer:

```javascript
function validateThemeSettingsValue(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid theme_settings');
  
  const { variant, mode, schedule } = value;
  
  // variant must be one of the five allowed values
  if (!['default', 'dracula', 'solarized', 'nord', 'high-contrast'].includes(variant)) {
    throw new Error('Invalid theme variant');
  }
  
  // mode must match 'light|dark|system|schedule'
  if (!['light', 'dark', 'system', 'schedule'].includes(mode)) {
    throw new Error('Invalid theme mode');
  }
  
  // if mode is 'schedule', validate schedule times
  if (mode === 'schedule' && schedule) {
    if (!isValidTimeString(schedule.lightFrom) || !isValidTimeString(schedule.darkFrom)) {
      throw new Error('Invalid schedule times');
    }
  }
  
  return true;
}
```

Wired into single-key and bulk PUT paths.

### 7. Settings Key Shape

Backend `theme_settings` JSONB value:

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

Default variant for new users: `'default'` (existing emerald + gold palette).

Existing rows lacking `variant` key default to `'default'` on read via `SETTING_DEFAULTS`.

### 8. Settings UI: Appearance Tab

**Location**: `apps/frontend/src/components/settings/AppearanceTab.tsx`

New Appearance tab in DashboardSettingsDialog:

- **Variant picker**: Grid of 5 color swatches with live preview (no round-trip to backend yet)
- **Mode picker**: Radio buttons for `light`, `dark`, `system`, `schedule`
- **Schedule inputs**: Conditional time pickers when mode is `'schedule'`
- **Debounced persistence**: 500ms after any change to `theme_settings`

Swatch grid uses aspect-square with variant primary + accent colors overlaid.

### 9. i18n Keys

New translation keys under `settings.appearance.*`:

```json
{
  "settings": {
    "tab": {
      "appearance": "Appearance"
    },
    "appearance": {
      "variant": "Theme Variant",
      "variantHint": "Choose a color palette",
      "variants": {
        "default": "Default (Emerald)",
        "dracula": "Dracula",
        "solarized": "Solarized",
        "nord": "Nord",
        "highContrast": "High Contrast"
      },
      "variantsDesc": {
        "default": "Apple-inspired liquid glass with emerald and gold",
        "dracula": "Dark-optimized moody palette",
        "solarized": "High contrast, reading-friendly",
        "nord": "Arctic-inspired calm colors",
        "highContrast": "WCAG AAA accessibility-focused"
      },
      "mode": "Theme Mode",
      "modeHint": "Light, dark, system, or schedule",
      "modes": {
        "light": "Always Light",
        "dark": "Always Dark",
        "system": "Follow System",
        "schedule": "Schedule (Custom Times)"
      },
      "lightFrom": "Light theme from",
      "darkFrom": "Dark theme from"
    }
  }
}
```

Both `en.json` and `nl.json` updated; outputs regenerated to `apps/frontend/src/locales/` and `packaging/electron/i18n/`.

## Consequences

### Positive

- **Personalization**: Users choose a palette matching their brand or accessibility needs
- **Inclusivity**: High-contrast variant supports WCAG AAA; solarized supports low-vision readers
- **Live preview**: Variant change applies immediately in the DOM without round-trip lag
- **Performance**: No stylesheet bundling; pure HSL token swaps via runtime `style.setProperty`
- **Type safety**: TypeScript `ThemeVariant` enum prevents invalid variant selection
- **FOUC prevention**: Pre-React flash script ensures correct palette loads before first paint
- **Backward compatibility**: Existing `theme_settings` rows default to `'default'` variant

### Neutral

- **Storage expansion**: `theme_settings` now includes `variant` + optional `schedule` object (vs. previous flat structure with just `mode` and `accentColor`)
- **Validation complexity**: Backend must validate variant name, mode, and schedule times; adds 30-40 lines of validation code
- **Translation maintenance**: Five variant descriptions + three additional mode types require i18n coverage in en/nl

### Negative

- **Browser compatibility**: `document.documentElement.style.setProperty` requires ES6+ and modern DOM APIs; graceful fallback to default palette in IE11 (no theme switching)
- **Token maintenance**: Adding a new variant requires enumerating all color token values in both light and dark modes (list of ~25 tokens)

## Implementation

### Frontend Changes

1. **Tokens & Theming**: New `apps/frontend/src/styles/themes.ts` with `ThemeVariant` type, `themes` palette map, `TOKEN_KEYS` enumeration, `applyThemePalette()` function, `isThemeVariant` type guard
2. **Tests**: `apps/frontend/src/styles/themes.test.ts` — variant coverage, token-key parity, non-empty values, type-guard safety (4 cases)
3. **Theme Flash**: Update `apps/frontend/src/theme-flash.ts` to read `theme-variant` from localStorage and apply before React mounts
4. **ThemeContext**: Extend `apps/frontend/src/contexts/ThemeContext.tsx` to track `variant`, debounce persistence, apply palette on change
5. **Appearance Tab**: New `apps/frontend/src/components/settings/AppearanceTab.tsx` with variant picker, mode selector, schedule inputs
6. **Settings Dialog**: Update `apps/frontend/src/components/settings/DashboardSettingsDialog.tsx` to add Appearance tab (grid-cols-4 → grid-cols-5)
7. **i18n**: Add keys to `i18n/source/en.json` and `i18n/source/nl.json`; regenerate outputs

### Backend Changes

1. **Routes**: Update `apps/node-backend/src/routes/settings.js` — add `validateThemeSettingsValue` validator, wire into single PUT and bulk PUT; set default `variant: 'default'` in response defaults
2. **Tests**: Add 4 test cases to `apps/node-backend/tests/routes/settings.test.js` covering variant/mode/schedule validation

### Database

No migration required. JSONB column supports optional `variant` field; existing rows gracefully default to `'default'`.

## Testing

### Frontend Tests (Pass: 4/4)

- `themes.test.ts`: Variant enumeration complete, all token keys present, non-empty values, type-guard rejects invalid
- Manually verified in browser: five variants × two modes = ten palette combinations render correctly

### Backend Tests (Pass: 25/25 + 4 new)

- `settings.test.js`: New cases verify variant ∈ {default,dracula,solarized,nord,high-contrast}, mode ∈ {light,dark,system,schedule}, schedule.lightFrom/darkFrom match HH:MM regex
- All existing settings route tests pass; no regression

### E2E (Manual)

1. Fresh load: FOUC avoided, correct variant + mode loaded from localStorage
2. Theme switch: Palette updates live, 500ms debounce fires API call, backend persists
3. Schedule mode: Time inputs conditionally visible, validation prevents invalid times
4. Variant reset: Deleting `theme_settings` key reverts to `'default'` on next load

## Related

- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]]
- [[docs/features/settings|Settings Feature]]
- [[docs/api/settings|Settings API]]
- [[docs/i18n/translations|Translations & i18n]]
- [[docs/architecture/frontend-architecture|Frontend Architecture]]
- [[apps/frontend/src/styles/themes.ts|Theme Variants Source]]
