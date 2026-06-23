---
title: ADR-020 Glass System Downgrade & Liquid Canvas Removal
type: adr
status: Partially superseded by ADR-070
date: 2026-04-17
tags: [adr, performance, frontend, optimization, glassmorphism, electron, gpu]
description: Performance optimization reducing glass-system blur tiers and removing liquid-canvas animated background and page transitions due to Electron M1 GPU regression
aliases: [adr-020, glass downgrade, liquid canvas removal, performance refactor]
---

# ADR-020: Glass System Downgrade & Liquid Canvas Removal

## Status
Accepted · Partially superseded by [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070]] (June 2026): atmosphere layer, page transitions, blur tiers, and `saturate()` restored under a bounded GPU budget; the opaque-dense-surface rule from this ADR remains in force.

## Date
2026-04-17

## Context

Vision's Phase 9 design system ([[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017]]) introduced a premium liquid-glass aesthetic with five-tier glass material hierarchy (`glass-thin`, `glass-regular`, `glass-thick`, `glass-chrome`, `glass-elevated`), animated gradient mesh backgrounds (`liquid-canvas`), and Page Transition wrapper with spring choreography.

However, in Electron M1 deployments, sustained glass blur animations and liquid-canvas drift animation caused GPU utilization spikes and battery drain:

1. **Blur cascades**: Five-tier glass system with 6-40px blur on frequently-occluded surfaces (card, input, textarea, tabs, select, popover, etc.) caused GPU overdraw on dense UIs
2. **Liquid-canvas drift**: Ambient `liquid-drift` keyframe animation on page background consumed GPU cycles continuously even when page was inactive
3. **Page transition springs**: Route changes with spring physics added complexity to an already-expensive render pipeline
4. **Saturation filters**: 180-200% `saturate()` on glass surfaces compounded GPU cost

The net result: Noticeable jank on M1 Electron, reduced battery life, and poor perception of app smoothness despite the "premium" aesthetic.

## Decision

### 1. Glass System Downgrade

Reduce glass-system blur across dense surfaces from 6-40px to ≤12px max, with selective application:

| Class | Previous | New | Usage |
|-------|----------|-----|-------|
| `glass-thin` | 14px | 6px | Subtle interactive elements |
| `glass-regular` | 10px | 8px | Standard overlays (default) |
| `glass-thick` | 20px | 12px | Modal dialogs (retained) |
| `glass-chrome` | 8px | 8px | Navigation chrome (no change) |
| `glass-elevated` | 15px | 12px | Premium surfaces (reduced) |

**Saturation filtering**: Drop `saturate(180%-200%)` → no filter (rely on opacity/color for readability).

**Application scope**: Glass blur retained only on:
- Modal overlays (Dialog, AlertDialog, Sheet)
- Sidebar/AppLayout navigation chrome
- Popovers + Tooltips (lowest-impact overlays)

**Removed from**: Card, Input, Textarea, Tabs, Select, Popover content, HoverCard, DropdownMenu, ContextMenu, MenuBar, Alert, Toggle, Resizable, Sonner toast, Button, Carousel, and other dense-surface components.

**Replacement pattern**: `bg-card/95` (95% opacity solid background) + single subtle border + ≤8px shadow (vs. 2-4 layer shadows with 24-68px blur).

### 2. Liquid-Canvas Removal

Remove `.liquid-canvas` animated background mesh entirely:

- **Removal**: `.liquid-canvas` rules + `liquid-drift` / `liquid-canvas-drift` keyframes from `src/index.css`
- **Tailwind config**: Remove `.liquid-canvas` utilities from `tailwind.config.ts`
- **AppLayout.tsx**: Delete `.liquid-canvas` div; rely on solid `bg-background` + ambient grain texture (static, no animation)

**Rationale**: Continuous ambient animation on page background consumed GPU even when user inactive. Static grain overlay achieves aesthetic richness without performance cost.

### 3. Page Transition Removal

Delete PageTransition wrapper and spring entry/exit choreography:

- **Removal**: Delete `apps/frontend/src/components/layout/PageTransition.tsx` (confirmed unused via grep)
- **motion.ts**: Remove `pageVariants` export (no other consumers)
- **framer-motion retention**: Keep library as dependency — chart components + dialogs still use motion durations/easings

**Rationale**: Spring physics on route transitions added GPU complexity for marginal UX benefit. Standard CSS fade/slide transitions (if any) can be CSS-based and more efficient.

### 4. Font Optimization

Downgrade from variable font files to static weights (latin subset):

- **Previous**: `@fontsource-variable/fraunces` + `@fontsource-variable/inter` (full variable range)
- **New**: `@fontsource/fraunces` (400/600/700 latin) + `@fontsource/inter` (400/500/600 latin)

**Impact**: Smaller font files + no preload link needed (Vite hashes filenames; no cache busting issues).

### 5. CSS Cleanup

Remove legacy CSS rules:

- `-webkit-font-smoothing: antialiased` from html (redundant in modern webkit)
- `text-rendering: optimizeLegibility` (can cause layout jank on dynamic text)
- Move `will-change: transform` from `.micro-lift` base to `:hover` only (hint GPU only when needed)

## Consequences

### Positive

- **Electron M1 performance**: GPU utilization returns to baseline; no sustained blur + animation tax
- **Battery efficiency**: Reduced GPU cycles extend mobile + laptop battery runtime
- **Jank elimination**: Modal transitions + chart updates no longer race against background animation
- **Simplicity**: Fewer CSS rules, smaller motion.ts scope, cleaner component surface styling
- **Perceived smoothness**: Standard-pace animations feel more responsive than spring-delayed ones
- **Bundle**: Font subset (~5kb savings); fewer CSS utilities (~2-3kb)

### Neutral

- **Visual downgrade**: Liquid-glass aesthetic loses animated background + spring choreography, but solid frosted-glass + grain still conveys premium feel
- **Glass perception**: Reduced blur makes glass feel "softer" (less dramatic), but readability improves
- **Component motion**: Charts + dialogs retain motion via Framer Motion; only route-level choreography removed

### Negative

- **Phase 9 reversion**: Loss of some premium aesthetic polish introduced in ADR-017
- **Animation polish loss**: Modal/dialog entry animations no longer spring-based (instant or linear CSS fade)
- **Design coherence**: Reduced glass hierarchy may feel less "premium" on first impression, though usability wins offset this

## Implementation

### Frontend Changes

1. **Tokens** (`src/styles/tokens.css`):
   - Update `--glass-*-blur` values (40→12, 10→8, etc.)
   - Remove `saturate()` from glass utilities
   - Keep opacity tiers intact

2. **Components** (48 UI components + 10+ page-level components):
   - Replace `.glass-*` on card, input, textarea, tabs, select, popover, hover-card, dropdown-menu, context-menu, menubar, alert, toggle, resizable, sonner, button, carousel with `bg-card/95 border shadow-sm`
   - Retain `.glass-thick` on Dialog, AlertDialog, Sheet
   - Retain `.glass-chrome` on Sidebar/AppLayout chrome

3. **AppLayout.tsx**:
   - Delete `.liquid-canvas` div
   - Keep solid `bg-background`
   - Retain static grain overlay (CSS rule, no animation)

4. **motion.ts**:
   - Remove `pageVariants` export
   - Keep durations, easings, spring configs (used by charts, dialogs)
   - Keep `useReducedMotion()` hook

5. **PageTransition.tsx**:
   - Delete file
   - Update route outlet in App.tsx to render page directly (no wrapper)

6. **Fonts**:
   - Swap `@fontsource-variable/fraunces` → `@fontsource/fraunces` (400/600/700)
   - Swap `@fontsource-variable/inter` → `@fontsource/inter` (400/500/600)
   - Remove preload links from `src/index.html` (not necessary with Vite hashing)

7. **index.css**:
   - Remove `.liquid-canvas` rules
   - Remove `liquid-drift`, `liquid-canvas-drift` keyframes
   - Clean up `-webkit-font-smoothing` and `text-rendering` from html rule
   - Move `will-change: transform` from `.micro-lift` to `:hover` modifier

### Dependencies

- **Remove**: None (framer-motion retained; chart/dialog consumers still use it)
- **Update**: `@fontsource/fraunces`, `@fontsource/inter` (package.json)
- **No breaking changes**: API contracts, routing, data models untouched

### Testing & Verification

- **Performance**: GPU utilization baseline re-established; Electron M1 frame rate stable at 60fps (no jank on chart scrolls, modal transitions)
- **Build**: `bun run build` (expect minor file-size reduction due to font subset + removed CSS)
- **Type check**: `bunx tsc --noEmit` (zero errors)
- **Lint**: `bun run lint` (no new warnings)
- **Visual**: Smoke test across 5 breakpoints (320, 375, 768, 1024, 1440); light + dark themes
- **Accessibility**: Reduced-motion tests unchanged; glass removal does not impact a11y (still 2-layer surfaces for semantic nesting)

## Rollout Plan

1. **Phase 1**: Glass-system downgrade + font swap (no motion removal yet) — measure GPU impact
2. **Phase 2**: Liquid-canvas removal (verify grain overlay aesthetic is acceptable)
3. **Phase 3**: Page transition removal + cleanup (final polish)

Alternative: Single-phase rollout (all changes at once) if risk appetite is high.

## Compatibility Impact

- **Electron**: M1 performance restored; x86_64 unaffected
- **Browser**: No breaking changes; CSS-only modifications
- **Mobile**: Reduced blur improves readability on smaller screens
- **Dark mode**: Opacity-based layering works equally in light + dark
- **Accessibility**: No WCAG violations introduced; contrast preserved

## Migration Path (if reverting in future)

Should premium glass aesthetic be desired again:

1. Increase `--glass-*-blur` values back to Phase 9 levels
2. Re-add `liquid-canvas` div + animation to AppLayout
3. Re-add PageTransition wrapper to route outlet
4. Swap fonts back to `@fontsource-variable/fraunces` + `@fontsource-variable/inter`

All changes are straightforward CSS/JSX modifications with no schema or contract changes.

## Related

- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]] — Original design system
- [[docs/adr/019-framer-motion-adoption|ADR-019: Framer Motion Adoption]] — Motion system (retained for dialogs/charts)
- [[docs/components/ui-components|UI Components]] — Updated surface patterns
- [[docs/architecture/frontend-architecture|Frontend Architecture]] — Design system overview
- [[docs/performance/index|Performance Documentation]] — Performance optimization strategies
