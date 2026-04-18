---
title: ADR-017 Liquid Glass Aesthetic & Design System Rewrite
type: adr
status: Accepted
date: 2026-04-17
tags: [adr, design, frontend, aesthetic, tokens, motion, phase-9]
description: Apple-inspired liquid-glass aesthetic with emerald + champagne-gold palette, premium material hierarchy, and Framer Motion choreography
aliases: [adr-017, liquid glass, design system, aesthetic]
---

# ADR-017: Liquid Glass Aesthetic & Design System Rewrite

## Status
Accepted

## Date
2026-04-17

## Context

Vision frontend was previously styled with a neutral design system using Tailwind's defaults and shadcn/ui components without significant visual cohesion, motion choreography, or premium hierarchy. User-facing apps benefit from intentional aesthetic direction that clarifies information hierarchy, conveys brand confidence, and guides user attention through motion and material depth.

The project required a comprehensive design system rewrite to establish a premium, production-grade visual identity suitable for financial transaction management and portfolio analysis.

## Decision

### 1. Visual Direction: Apple-Inspired Liquid Glass

Adopt an **Apple-style liquid-glass aesthetic** characterized by:

- **Primary palette**: Emerald (`--primary: oklch(54% 0.15 161)`) paired with champagne gold accent (`--accent: oklch(74% 0.09 73)`)
- **Dark base**: Deep charcoal (`oklch(14% 0 0)`) for contrast against glass surfaces
- **Material hierarchy**: Five-tier glass system (`glass-thin`, `glass-regular`, `glass-thick`, `glass-chrome`, `glass-elevated`) each with configurable blur, saturation, and opacity
- **Premium surfaces**: Named helpers for elevated depth (`surface-elevated`, `premium-frame`, `micro-lift`, `liquid-canvas`)
- **Grain texture**: Subtle 1-2% opacity noise overlay to add tactile richness

### 2. Typography: Heritage + Modern

- **Display font**: Fraunces (variable, serif, high-contrast) via `@fontsource-variable/fraunces` — headlines, hero text, stats
- **Body font**: Inter Tight (variable, sans-serif, geometric) via `@fontsource-variable/inter` — body copy, UI labels, form inputs
- **Self-hosted**: Both fonts loaded as local variable files, eliminating external CDN dependency and improving performance

### 3. Token Architecture

**Location**: `apps/frontend/src/styles/tokens.css` (split from main `index.css` for clarity)

- HSL color tokens for semantic meaning (primary, accent, muted, destructive)
- Material tokens for glass variants
- Surface tokens for elevation + depth
- Spacing tokens with `clamp()` for responsive scaling
- Reduced-motion-aware animation defaults

All Tailwind config extended with custom palette, reducing reliance on defaults.

### 4. Motion System & Reduced-Motion Compliance

**Location**: `apps/frontend/src/lib/motion.ts`

- Exported durations (fast: 150ms, normal: 300ms, slow: 500ms), easings (out-expo, cubic-bezier variants), spring configs
- All motion consumers must check `useReducedMotion()` hook and skip animations when `prefers-reduced-motion: reduce`
- Framer Motion integration for component-level choreography
- PageTransition wrapper animates route changes with spring enter + fade exit

### 5. Component Defaults

**shadcn/ui Primitives** (48 components in `src/components/ui/`) retuned to:
- Use design tokens instead of hardcoded values
- Inherit motion defaults from motion system
- Glass surface classes where semantically appropriate (overlays, modals, popovers)
- Premium frame + micro-lift for elevated card containers

### 6. Shell & Layout

- **AppLayout** (`src/components/layout/AppLayout.tsx`): `liquid-canvas` with animated gradient mesh + grain overlay + motion-aware atmosphere blobs
- **AppSidebar** (`src/components/layout/AppSidebar.tsx`): `glass-chrome` nav with emerald accent rail on active route
- **PageTransition** (`src/components/layout/PageTransition.tsx`): Wraps route outlet with spring entry + fade exit, respects reduced-motion

## Consequences

### Positive

- **Unified aesthetic**: All 25+ pages now follow consistent material hierarchy and motion language
- **Premium brand impression**: Liquid glass + emerald palette conveys sophistication suitable for financial app
- **Accessibility**: Grain + opacity tuning preserves text contrast; reduced-motion fully honored across motion system
- **Performance**: Self-hosted fonts (no CDN round-trip); visx charts (no Recharts bundle bloat); motion respects GPU via compositor-friendly properties
- **Maintainability**: Centralized tokens + motion system reduces scattered magic numbers; single source of truth for colors, spacing, motion timing

### Neutral

- **Bundle size trade-off**: Fraunces + Framer Motion add ~15-20kb gzipped, offset by Recharts removal (~50kb savings)
- **Browser support**: `backdrop-filter` not available in older IE (graceful fallback to solid backgrounds; no breakage)
- **Reduced-motion complexity**: Apps must explicitly check `useReducedMotion()` and conditionally skip animations (not automatic)

### Negative

- **Migration effort**: All Recharts-based chart pages required manual rewrite to visx/d3 primitives
- **Motion testing**: Motion-heavy UI requires visual regression or E2E screenshot tests for verification

## Implementation

### Frontend Changes

1. **Tokens & Styling**: `index.css` + new `styles/tokens.css`
2. **Motion Library**: `lib/motion.ts` with durations, easings, spring configs, `useReducedMotion()` integration
3. **Shell Components**: AppLayout v2, AppSidebar v2 with glass + motion, PageTransition wrapper
4. **UI Primitives**: 48 shadcn components retuned to token-based styling + glass defaults
5. **Chart Migration**: New `components/charts/` with visx/d3 primitives (AreaChart, BarChart, PieChart, LineChart, Sparkline, Candlestick, TreemapChart) replacing Recharts
6. **Page Updates**: Consistent-pass token retuning across all 25+ pages; gradient icon tiles for summary grids
7. **Dialogs**: All 18+ form/info dialogs standardized on `glass-thick` shell + spring entry

### Tailwind Config

- Extended theme with Fraunces + Inter Tight font families
- Custom color palette (emerald + gold + supporting colors)
- Glass + surface utility classes
- Reduced-motion-aware animation defaults

### Dependencies

- Added: `framer-motion`, `@fontsource-variable/fraunces`, `@fontsource-variable/inter`
- Removed: `recharts` (replaced by visx/d3)
- Existing: `visx/*`, `d3-*` packages already available

## Rollout

- **Verification**: `bunx tsc --noEmit` (clean), `bun run build` (5.52s), `bun run lint` (baseline 49 errors, 72 warnings)
- **Visual Testing**: Manual smoke test across 5 breakpoints (320, 375, 768, 1024, 1440); both light + dark themes
- **Accessibility**: Contrast verified (WCAG AA); reduced-motion tested via DevTools emulation
- **No Breaking Changes**: Routes, APIs, data models, Electron security posture untouched

## Related

- [[docs/reference/code-patterns#surface-shell-pattern|Surface Shell Pattern]]
- [[docs/reference/code-patterns#gradient-icon-tile-pattern|Gradient Icon Tile Pattern]]
- [[docs/reference/code-patterns#motion-consumer-pattern|Motion Consumer Pattern]]
- [[docs/adr/018-visx-d3-chart-migration|ADR-018: visx/d3 Chart Migration]]
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]]
- [[docs/architecture/frontend-architecture|Frontend Architecture]]
- [[docs/components/ui-components|UI Components]]
- [[docs/features/views|Views & Pages]]
