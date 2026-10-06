---
title: "ADR-178: Design-system role tokens"
type: adr
status: accepted
date: 2026-10-05
tags:
  [
    adr,
    frontend,
    design-system,
    tokens,
    typography,
    motion,
    accessibility,
    adr-105,
    adr-172,
  ]
description: Adds role-named type, label, corner, elevation, focus and spring tokens beside the existing design system, as the first stage of a staged Apple-like refinement. Additive only; primitives and screens adopt them in later changes.
aliases: [adr-178, role tokens, label hierarchy, type ramp, spring tokens]
---

# ADR-178: Design-system role tokens

## Status

Accepted

## Date

2026-10-05

## Context

Vision's visual system is deliberate: glass tiers, aurora, Fraunces over Inter, a parity-tested
curve table ([[docs/adr/105-apple-refined-visual-pass|ADR-105]],
[[docs/adr/132-thin-default-card-material|ADR-132]],
[[docs/adr/172-calm-information-hierarchy|ADR-172]]). The owner wants the app to feel more
premium, calm and self-explaining, in an Apple-like way, without a redesign.

An audit of `apps/frontend/src` on 2026-10-05 (non-test TSX) found that the layer between tokens
and screens is still chosen per call site:

- Type: no semantic roles; `text-xs` (736 uses) and `text-sm` (728) carry most hierarchy, and
  tracking is one value per family regardless of size.
- Text colour: 13 opacity suffixes on `foreground`/`muted-foreground` across 75 sites. ADR-105
  deferred a label hierarchy.
- Corners: Card uses an arbitrary 12px between scale steps; other arbitrary radii remain; there
  is no nesting rule.
- Elevation: each glass class hand-writes its shadow stack.
- Focus: the base `:focus-visible` outline and 101 `ring-2 ring-offset-2` call sites are two
  mechanisms.
- Motion: Framer has a spring (`springs.snappy`) that CSS cannot express, so the dialog entrance
  approximates one with an overshooting bezier.

## Decision

Add role-named tokens and utilities next to the existing ones. Nothing existing is renamed or
retuned in this change, so the rendered app is unchanged until call sites adopt them.

| Role      | Tokens (`styles/tokens.css`)                                                                      | Utilities                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Type ramp | (values in the utilities)                                                                         | `type-large-title`, `type-title-1..3` (Fraunces), `type-headline`, `type-body`, `type-callout`, `type-footnote`, `type-caption` (Inter) |
| Labels    | `--label-{primary,secondary,tertiary,quaternary}-alpha` over `--foreground`                       | `text-label-*` (any colour utility)                                                                                                     |
| Corners   | `--radius-chip` 6px, `--radius-control` = `--radius`, `--radius-card` 14px, `--radius-sheet` 22px | `rounded-chip/control/card/sheet`, `corner-continuous`                                                                                  |
| Elevation | `--elevation-1..4`, light and dark                                                                | `shadow-elevation-1..4`                                                                                                                 |
| Focus     | `--ring`, `--focus-ring-alpha`                                                                    | `focus-ring`                                                                                                                            |
| Springs   | `--spring-{snappy,smooth,bouncy}` (`linear()`), `--spring-*-duration`                             | `ease-spring-*`, `duration-spring-*`                                                                                                    |

Rules:

- Type utilities are prefixed `type-`, not `text-`, so tailwind-merge never treats a role as a
  text colour. Tracking tightens as size grows.
- Label levels are alphas over `--foreground`. Each theme variant declares its own three alphas in
  `styles/themes.ts` (the default palette's live in `tokens.css`), because one alpha over a
  lower-contrast foreground falls under the floors: at the default values Nord light tertiary
  reads 2.7:1 and Solarized light secondary 2.9:1. Secondary stays at 4.5:1 or more on
  background, card and muted (Solarized light cannot reach it at any alpha, since its full
  foreground reads 4.4:1 on its card, and is held to 4:1); tertiary at 3:1 or more and is the
  placeholder level; quaternary is for disabled text only.
- Corners nest concentrically: inner radius equals outer radius minus the padding between them.
  `corner-continuous` applies `corner-shape: squircle` only where supported.
- Elevation levels read `--glass-shadow` and `--glass-highlight`; glass materials are unchanged.
- `focus-ring` is a translucent 3px outline that follows the element's radius and leaves its
  box-shadow untouched; high-contrast mode uses the full ring colour. Its alpha is
  `--focus-ring-alpha`, declared per palette in `styles/themes.ts` (default 0.76 light, 0.5
  dark; Nord dark needs 0.92) so the ring reads at 3:1 or more against the canvas, card and
  muted surfaces (WCAG 1.4.11); a fixed 0.45 read at 1.95:1 in the default light palette.
- Every spring in `lib/motion.ts` has a sampled CSS twin. Use each easing with its duration.

## Consequences

**Positive**

- Call sites can choose a role instead of a size, opacity or shadow stack.
- Contract tests hold the label and focus-ring contrast floors in every theme variant and mode,
  plus the Tailwind exposure (`styles/designSystemTokens.contract.test.ts`), and re-simulate
  every spring (`lib/__tests__/springTokenParity.test.ts`).

**Negative**

- Two vocabularies coexist until primitives and screens migrate.
- `corner-continuous` support in the packaged Electron runtime is unverified.

**Neutral**

- Planned follow-ups: primitives adopt the tokens (with before and after screenshots), then one
  change per screen, then removal of superseded aliases with lint rules. Each will record its own
  visual decisions.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/105-apple-refined-visual-pass|ADR-105: Apple-refined visual pass]]
- [[docs/adr/132-thin-default-card-material|ADR-132: Thin default Card material]]
- [[docs/adr/172-calm-information-hierarchy|ADR-172: Calm information hierarchy]]
- [[docs/components/ui-components|UI Components]]
