---
title: ADR-019 Framer Motion Adoption for Component Choreography
type: adr
status: Accepted
date: 2026-04-17
tags: [adr, motion, animation, frontend, framer-motion, phase-9, accessibility]
description: Adopt Framer Motion as the canonical motion library for Vision frontend, with unified reduced-motion compliance and motion system exports
aliases: [adr-019, framer motion, choreography, animation system]
---

# ADR-019: Framer Motion Adoption for Component Choreography

## Status
Accepted

## Date
2026-04-17

## Context

Vision frontend previously had minimal structured motion choreography. The liquid-glass design system rewrite ([[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017]]) required a unified, accessible approach to component-level animations:

1. **Hierarchy & guidance**: Motion clarifies UI hierarchy and guides user attention (entrance, exit, state change)
2. **Polish**: Smooth transitions and spring physics add perceived refinement without overwhelming interaction
3. **Accessibility**: Must respect `prefers-reduced-motion` globally; cannot be purely decorative
4. **Consistency**: Motion timing, easing, and spring configs should be centralized to avoid scattered magic numbers

Framer Motion is the industry standard for React component animation, provides excellent TypeScript support, and integrates cleanly with React 18.

## Decision

### 1. Motion Library

Adopt **Framer Motion** (`framer-motion`) as the canonical motion library for Vision.

- **Scope**: Component-level animations (entrance, exit, state changes, hover/focus feedback)
- **Exports**: Via `apps/frontend/src/lib/motion.ts` (durations, easings, spring configs)
- **Reduced-motion**: All motion consumers must check `useReducedMotion()` hook and conditionally apply animations

### 2. Motion System (`src/lib/motion.ts`)

Centralized motion configuration exported as TypeScript constants and factory functions:

```ts
// Durations
export const DURATION_FAST = 150;      // UI response, micro-interactions
export const DURATION_NORMAL = 300;    // Dialog/sheet entrance, typical transitions
export const DURATION_SLOW = 500;      // Page transitions, complex choreography

// Easings
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1];
export const EASE_OUT_CUBIC = [0.33, 1, 0.68, 1];
export const EASE_IN_QUAD = [0.11, 0, 0.5, 0];

// Spring Configs
export const SPRING_BOUNCE = { type: 'spring', bounce: 0.4, damping: 12 };
export const SPRING_SMOOTH = { type: 'spring', damping: 20, stiffness: 100 };
export const SPRING_SNAPPY = { type: 'spring', damping: 15, stiffness: 140 };

// Variants Library
export const variantPageEnter = { /* ... */ };
export const variantPageExit = { /* ... */ };
export const variantDialogEnter = { /* ... */ };
export const variantFadeIn = { /* ... */ };

// Reduced-motion hook
export function useReducedMotion(): boolean {
  const prefersReduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  return prefersReduced;
}
```

### 3. Core Use Cases

| Pattern | Component | Timing | Easing | Spring |
|---------|-----------|--------|--------|--------|
| Dialog/Sheet Entry | Modal overlays | 300ms | ease-out-expo | SPRING_SMOOTH |
| Dialog/Sheet Exit | Dismiss | 200ms | ease-out-cubic | — |
| Page Transition | PageTransition wrapper | 300ms enter, 200ms exit | — | SPRING_BOUNCE |
| Hover Elevation | Card, Button | 150ms | ease-out-cubic | — |
| Focus Ring | Interactive elements | 200ms | ease-out-cubic | — |
| Tooltip/Popover | Overlay content | 150ms | ease-out-cubic | SPRING_SNAPPY |
| Fade In/Out | Content appearance | 200-300ms | ease-out-cubic | — |
| Micro-interactions | Icon action, checkbox state | 150ms | ease-out-expo | — |

### 4. Accessibility: Reduced-Motion Compliance

**Rule**: All motion consumers must conditionally apply animations based on `useReducedMotion()`.

```tsx
function DialogContent() {
  const prefersReduced = useReducedMotion();
  
  return (
    <motion.div
      initial={prefersReduced ? {} : { opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={prefersReduced ? {} : { opacity: 0, scale: 0.90 }}
      transition={prefersReduced ? {} : { duration: 0.3, type: 'spring' }}
    >
      {/* Content */}
    </motion.div>
  );
}
```

**Pattern**: If `prefersReduced` is true, skip animations entirely (empty initial/exit + instant transition).

### 5. Component Integration Points

**High-priority consumers** (motion enhances clarity):

1. **PageTransition** (`src/components/layout/PageTransition.tsx`): Route change → spring enter + fade exit
2. **Dialog/Sheet** (`src/components/ui/dialog.tsx`, `sheet.tsx`): Modal overlays → slide up + fade in
3. **Popover/Dropdown** (`src/components/ui/popover.tsx`, `dropdown-menu.tsx`): Trigger-based overlays → scale + fade
4. **Card/Surface elevation**: Hover → subtle lift via transform (no layout shift)
5. **Tooltips** (`src/components/shared/Tooltip.tsx`): Delayed entry + fade
6. **Form dialogs** (18+ across app): Standardized glass-thick shell with spring entry
7. **Loading skeletons**: Pulse animation with reduced-motion fallback (opacity only)
8. **Micro-interactions**: Icon buttons, checkbox/radio toggle, toggle switches

**Nice-to-have consumers** (motion adds polish):

- Chart animations (data entry stagger, axis label reveal)
- Sparkline updates (smooth data transitions)
- Stat card counter animations (discretized number change)

### 6. Integration with Design System

Framer Motion animations align with liquid-glass aesthetic:

- **No layout shift**: Use `transform`, `opacity` only (GPU-accelerated, no reflow)
- **Spring physics**: SPRING_SMOOTH/SNAPPY configs feel premium vs. linear easings
- **Token integration**: Motion timing from centralized token system, not hardcoded in components

### 7. TypeScript Support

Framer Motion provides first-class TypeScript support via `motion.div`, `motion.span`, etc.:

```tsx
import { motion } from 'framer-motion';
import { DURATION_NORMAL, EASE_OUT_CUBIC, useReducedMotion } from '@/lib/motion';

const MyComponent = () => {
  const prefersReduced = useReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: DURATION_NORMAL / 1000, ease: EASE_OUT_CUBIC }}
      // ... normal React props still work
    />
  );
};
```

## Consequences

### Positive

- **Unified motion language**: All animations follow the same token system, easing curves, timing
- **Accessibility built-in**: `useReducedMotion()` hook ensures compliance; animations are respectable, not mandatory
- **Polish**: Component-level choreography adds perceived refinement
- **Maintainability**: Centralized `motion.ts` makes global motion tweaks trivial (e.g., "slow down all animations by 20%")
- **Performance**: Framer Motion optimizes GPU-accelerated transforms; no jank
- **TypeScript**: Full type safety for motion props and variants

### Neutral

- **Bundle size**: Framer Motion adds ~15-20kb gzipped (offset by other optimizations in design-system rewrite)
- **Learning curve**: Teams unfamiliar with Framer Motion need onboarding

### Negative

- **Animation testing**: Snapshot tests do not capture motion; requires visual regression or E2E screenshot tests for verification
- **Reduced-motion burden**: Every motion consumer must explicitly check `useReducedMotion()`; no automatic fallback

## Best Practices

1. **Always use `useReducedMotion()` for non-essential animation** — Decorative motion must be opt-out via OS preference
2. **Prefer `transform` and `opacity`** — Avoid animating width, height, left, top (causes reflow)
3. **Centralize configs** — New motion patterns should be added to `motion.ts`, not scattered in components
4. **Test accessibility** — Use DevTools emulation of `prefers-reduced-motion: reduce` during QA
5. **Document intent** — Comment why motion is used (clarity, guidance, feedback) not just "looks good"
6. **Avoid animation chaining** — Use `transition: { staggerChildren }` for multi-element sequences, not manual delays

## Verification

- **Build**: `bun run build` completes with no motion-related warnings
- **Type check**: `bunx tsc --noEmit` catches any motion prop mismatches
- **Accessibility**: Test with DevTools emulation of `prefers-reduced-motion: reduce` — all motion should disable cleanly
- **Visual**: Smoke test route transitions, dialog entry/exit across 5 breakpoints

## Related

- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/reference/code-patterns#motion-consumer-pattern|Motion Consumer Pattern]]
- [[docs/components/layout|Layout Components]]
- [[docs/components/ui-components|UI Components]]
- [[docs/features/views|Views & Pages]]
