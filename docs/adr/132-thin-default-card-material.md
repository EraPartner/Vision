---
title: "ADR-132: Thin default Card material"
type: adr
status: Accepted
date: 2026-09-08
tags:
  [
    adr,
    frontend,
    design-system,
    glass,
    performance,
    card,
    adr-070,
    adr-075,
    adr-105,
  ]
description: Makes glass-thin the default Card material while preserving explicit elevated and chrome cards, reducing per-card blur cost without flattening Vision's glass hierarchy.
aliases: [adr-132, thin default card, card blur budget]
---

# ADR-132: Thin default Card material

## Status

Accepted

## Date

2026-09-08

## Context

[[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070]] set a bounded glass budget, with
dense surfaces staying opaque and selected cards using richer materials. A later role-based
broadening made `glass-regular` the base `<Card>` material. That made every ordinary content,
chart, form, and state card pay for a 20px backdrop blur. The current tree has more than 160 Card
call sites, so card-dense pages can create many concurrent blur regions even when no card needs
regular-tier emphasis.

[[docs/adr/105-apple-refined-visual-pass|ADR-105]] requires differentiated materials rather than a
flat visual system. The performance correction therefore needs to keep the aurora, saturation,
frame, jewel accents, and elevated hero treatment while making the common case cheaper.

## Decision

The base `<Card>` owns `glass-thin` and `premium-frame`.

- Ordinary content, chart, form, and state cards use the 12px thin material by default.
- Deliberately promoted hero and summary cards keep explicit `glass-elevated` treatment.
- Administrative and navigation surfaces that intentionally match application chrome keep
  explicit `glass-chrome` treatment.
- Floating overlays remain `glass-thick`; this decision does not change overlay primitives.
- Call sites do not repeat `glass-thin`, `glass-regular`, `premium-frame`, or `micro-lift` on a
  Card. The Card primitive owns its baseline material and frame.
- `variant="interactive"` remains independent of material. It adds hover, press, and reduced-motion
  behavior but does not promote blur depth.
- The Card also owns a semantic `card-material` marker. Under macOS native vibrancy this marker
  disables the Card's local web blur, while small transient `glass-thin` controls retain theirs.

The existing reduced-transparency and visual-effects-tier fallbacks continue to apply to every
glass tier. No token values or theme colors change.

## Consequences

**Positive**

- Ordinary cards use a 12px rather than 20px backdrop blur, reducing the default GPU cost on
  card-dense pages.
- Vision keeps its rich material hierarchy. Elevated hero cards, chrome, overlays, aurora, and
  premium frames remain distinct.
- One primitive-level default covers existing and future ordinary Cards without class duplication.

**Negative**

- Ordinary cards are visually lighter than under the June role-based broadening.
- Screenshots and tests that used `.glass-regular` as a structural selector must use semantic
  queries or the new `.glass-thin` baseline.
- A future card that genuinely needs stronger emphasis must choose an explicit higher tier.

**Neutral**

- Card geometry, shadows defined by each glass class, colors, typography, and interaction motion
  are unchanged.
- This narrows the later role-based broadening of ADR-070. It does not rewrite ADR-070 or ADR-105.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/070-liquid-glass-v2-premium-frontend|ADR-070: Liquid Glass v2]]
- [[docs/adr/075-visual-effects-tiers-display-adaptation|ADR-075: Visual-effects tiers]]
- [[docs/adr/105-apple-refined-visual-pass|ADR-105: Apple-refined visual pass]]
- [[docs/adr/129-native-vibrancy-substitutes-persistent-web-blur|ADR-129: Native vibrancy blur substitution]]
- [[docs/components/ui-components|UI Components]]
- [[docs/reference/code-patterns|Code Patterns]]
