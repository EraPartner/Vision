---
title: "ADR-047: Tailwind CSS v4 Migration & Dependency Upgrades"
type: adr
status: Accepted
date: 2026-05-03
tags: [adr, tailwind, dependencies, frontend, css, build-tools, migration, sonner, recharts]
description: Upgrade Tailwind CSS from v3 (3.4.19) to v4 (4.2.4) with postcss config refactor; upgrade sonner to 2.0.7 and recharts to 3.8.1 for improved charts and notifications.
aliases: [adr-047, tailwind-v4, css-migration, tailwind-upgrade]
---

# ADR-047: Tailwind CSS v4 Migration & Dependency Upgrades

## Status
Accepted

## Date
2026-05-03

## Context

Three frontend dependencies received significant version updates merged to main:

1. **Tailwind CSS**: 3.4.19 → 4.2.4 (major version bump, breaking changes)
2. **Sonner (toast notifications)**: 1.7.4 → 2.0.7 (new major version)
3. **Recharts (charting)**: 2.15.4 → 3.8.1 (compatible, feature update)

Tailwind v4 introduces a fundamentally different architecture replacing the PostCSS plugin model with a unified build system. The migration required changes to:
- PostCSS config
- CSS entry point (`index.css`) directives
- Component styling (@apply restrictions)

Sonner 2.x and Recharts 3.x bring performance improvements and API refinements needed for modern notification and charting workflows.

## Decision

### 1. Tailwind CSS v4 Migration

**PostCSS Config (`apps/frontend/postcss.config.cjs`):**
- **Old (v3)**: `tailwindcss: { config: './tailwind.config.ts' }` plugin
- **New (v4)**: `'@tailwindcss/postcss': {}` single unified plugin

The v4 architecture consolidates CSS generation into one plugin; config resolution is automatic.

**CSS Entry Point (`apps/frontend/src/index.css`):**
- **Old (v3)**:
  ```css
  @tailwind base;
  @tailwind components;
  @tailwind utilities;
  ```
- **New (v4)**:
  ```css
  @import "tailwindcss";
  @config '../tailwind.config.ts';
  ```

The `@import "tailwindcss"` directive pulls the entire Tailwind layer system; `@config` explicitly points to the configuration file for determinism.

**@apply Restrictions (v4):**
- Tailwind v4 restricts `@apply` to registered utilities only
- Custom alias selectors (e.g., `.glass { @apply ... }`) must merge the declarations directly instead of using @apply
- All custom `.glass*` variants in `index.css` `@layer utilities` now declare full CSS rules rather than relying on @apply

**Font Optimization:**
- Swapped `@fontsource-variable/*` → `@fontsource/*` static weights (400/500/600 latin)
- Reduces font file size; avoids variable font overhead when only fixed weights are used

### 2. Sonner Upgrade (1.7.4 → 2.0.7)

**Benefits:**
- Improved toast positioning and accessibility
- New toast API (`toast.promise()`, better error handling)
- Better TypeScript support

**Backward Compatibility:**
- Existing `toast.success()`, `toast.error()`, `toast.loading()` calls remain unchanged
- No code refactoring required; API extends previous versions

### 3. Recharts Consolidation (2.15.4 → 3.8.1)

**Context:**
- Vision's charting strategy was already consolidated onto visx/d3 per ADR-028
- Recharts is no longer used in active charts (Performance, Net Worth pages)
- Recharts v3.8.1 update maintains API compatibility with any remaining legacy code

**Neutral Status:**
- Recharts retained for backward compatibility but not actively used
- Version bump reduces CVE surface; newer releases may be removed in future consolidation

## Consequences

### Positive

- **Tailwind v4 architecture**: Faster build times, smaller generated CSS footprint (unified plugin)
- **Simpler config**: PostCSS config now minimal (only `@tailwindcss/postcss`)
- **Future-proof**: Align with Tailwind's modern direction; v4 is the current stable release
- **Font optimization**: Static weights reduce payload; no visual regression
- **Notification & chart improvements**: Sonner 2.0 and Recharts 3.8 offer modern APIs and better a11y

### Negative

- **@apply constraints**: Custom aliases must merge CSS declarations directly, making them slightly more verbose
- **Maintenance burden**: Tailwind v4 is a new major; future breaking changes require awareness
- **Font subsetting**: No longer using variable fonts; future design changes requiring multiple weights may require additional font files

### Neutral

- **Vite build unaffected**: Vite continues using PostCSS as-is; no build pipeline changes
- **Recharts status**: Still a transitive dependency but inactive; removal possible in future cleanup phases

## Implementation Details

**Files Modified:**

| File | Change |
|------|--------|
| `apps/frontend/postcss.config.cjs` | Replaced `tailwindcss` plugin with `@tailwindcss/postcss` |
| `apps/frontend/src/index.css` | Replaced `@tailwind` directives with `@import "tailwindcss"` + `@config` |
| `apps/frontend/src/index.css` (`@layer utilities`) | Converted `.glass*` aliases to full CSS (removed @apply) |
| `apps/frontend/package.json` | `tailwindcss` ^3.4.19 → ^4.2.4, `@tailwindcss/postcss` ^4.2.4 added, `sonner` 1.7.4 → 2.0.7, `recharts` 2.15.4 → 3.8.1 |

**Testing & Verification:**

```bash
# Frontend build succeeds
bun run build

# Type checking passes
bunx tsc --noEmit

# Tests pass
bun run test

# CSS generation correct (no @apply errors)
# Visual inspection: all glass variants render correctly
```

**Rollback Plan:**

If critical issues arise post-deployment:
1. Revert `postcss.config.cjs` and `index.css` to v3 config/directives
2. Downgrade `tailwindcss` to 3.4.19
3. Remove `@tailwindcss/postcss` from `package.json`
4. `bun install` and rebuild

## Related

- [[docs/adr/017-liquid-glass-aesthetic-design-system|ADR-017: Liquid Glass Aesthetic]]
- [[docs/adr/020-glass-system-downgrade-liquid-canvas-removal|ADR-020: Glass System Downgrade]]
- [[docs/adr/028-reaffirm-visx-over-recharts|ADR-028: Reaffirm visx over Recharts]]
- [[docs/adr/038-dependency-slim-down-supply-chain-risk|ADR-038: Dependency Slim-Down]]
- [[docs/reference/code-patterns#css-architecture-tailwind-v4-phase-n|CSS Architecture (Code Patterns)]]
- [[docs/index|All ADRs]]
