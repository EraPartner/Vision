---
title: Calm information hierarchy
type: adr
status: accepted
date: 2026-09-27
tags: [adr, frontend, design-system, accessibility]
description: Reserve visual emphasis for primary totals while keeping supporting information quiet and readable.
---

# ADR-172: Calm information hierarchy

## Context

The shared stat tile promoted every metric with elevated glass, a full-card color wash, a glowing icon and hover motion. Repeating that treatment across summaries made scanning difficult and suggested that static figures were clickable. Net Worth also placed one short headline beside three full-height tiles, leaving an empty column.

## Decision

Preserve the emerald and champagne palette, display typography, glass materials, atmosphere, chart colors and accessible state indicators. Refine the emphasis policy from [[docs/adr/105-apple-refined-visual-pass|ADR-105]] and [[docs/adr/132-thin-default-card-material|ADR-132]]:

- Shared `StatCard` defaults to a supporting thin surface with a small muted icon, readable body label and restrained value size. `emphasis="primary"` explicitly promotes a page total with elevation and an accent border.
- Card interaction is independent of emphasis. Only a linked stat card receives the interactive variant; static figures and containers with internal chart controls do not move as if their whole surface were a button.
- Keep deliberate hero treatments on Dashboard Net Summary and Portfolio Total Value. Remove repeated corner ornaments from ordinary dashboard chart panels, Monthly Rhythm and the planned-payment strip.
- Use sentence-case body typography for metric labels, badges and table headings. Keep serif page and section headings, with section titles subordinate to page titles. Navigation grouping labels retain their existing eyebrow role.
- Reduce resting card shadows and page-header icon emphasis without weakening text, focus, warning or selected-state contrast.
- Net Worth places its headline beside a single compact definition-list breakdown, stacking in reading order on small screens. No metrics or percentages are removed.

## Consequences

Pages that consume shared primitives gain the hierarchy consistently, including research, portfolio, budgeting and settings. Explicit severity variants, gain/loss values, links, disclosures, charts and data operations retain their behavior. Primary emphasis is a deliberate exception rather than a default for every metric. This is presentation-only and adds no preference or API change.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/components/ui-components|UI components]]
- [[docs/components/dashboard|Dashboard components]]
- [[docs/features/net-worth|Net Worth]]
- [[docs/architecture/frontend-architecture|Frontend architecture]]
