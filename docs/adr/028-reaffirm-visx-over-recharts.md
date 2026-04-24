---
title: ADR-028 Reaffirm visx/d3 over recharts
type: adr
status: Accepted
date: 2026-04-24
tags: [adr, charting, frontend, visx, recharts, phase-10]
description: Reaffirm visx/d3 as the canonical chart primitive stack; supersede TODO proposal to swap back to recharts
aliases: [adr-028, reaffirm visx, visx stays]
---

# ADR-028: Reaffirm visx/d3 over recharts

## Status
Accepted

## Date
2026-04-24

## Context

A backlog entry in `TODO.md` proposed swapping `@visx/*` + `d3` back to `recharts`, claiming a ≥80kb gzipped bundle reduction and citing "10 visx packages" as evidence of bloat.

Re-examining the claim against [[docs/adr/018-visx-d3-chart-migration|ADR-018]]:

1. ADR-018 explicitly justified the migration as a **bundle reduction** of ~35kb (recharts ~50kb → visx+d3 ~15kb), not an increase.
2. The "80kb smaller" figure in the TODO is unsubstantiated — no measurement, no flamegraph, no build-report diff.
3. visx packages are a constellation of tiny, tree-shakeable primitives; package count is not a proxy for bundle weight.
4. `apps/frontend/src/components/charts/` consists of ~2100 LOC across 12 primitives + 22 consumer surfaces, heavily integrated with framer-motion (compositor-only animations), design-token-driven palette, reduced-motion branches, and custom axis/legend/tooltip renderers.
5. No Playwright or visual-regression safety net exists in the repo. A port of this surface area without visual diffs would ship regressions silently.
6. recharts lacks the low-level primitive surface the current charts rely on (custom `<defs>`, gradient overlays, reference lines, stacked series with token palette, bespoke interaction). Porting would require reintroducing abstractions the visx migration deliberately removed.

## Decision

Keep visx + d3 as the chart primitive stack. Mark the TODO proposal as superseded.

Scope of this ADR:
- Do **not** migrate any chart primitive or consumer back to recharts.
- Remove installed-but-unused visx sub-packages (`@visx/hierarchy`, `@visx/text`, `@visx/tooltip`) as a hygiene win — see the follow-up unit in the implementation plan.
- Revisit only if a measured, reproduced bundle-size analysis demonstrates a material regression against ADR-018's 35kb savings, **and** a visual-regression safety net exists.

## Consequences

### Positive
- Zero chart-consumer risk.
- Preserves the design-token integration and reduced-motion posture ADR-018 bought.
- Unblocks removal of three unused visx sub-packages for a small bundle win with no behavior change.

### Neutral
- `TODO.md` "Viz library dedupe" block removed; this ADR is the canonical record of the decision.
- Future contributors proposing the swap must provide measured bundle evidence + a visual-regression plan before reopening.

### Negative
- None known.

## Related

- [[docs/adr/018-visx-d3-chart-migration|ADR-018: visx/d3 Chart Migration from Recharts]]
- [[docs/adr/index|All ADRs]]
