---
title: "ADR-260: Ledger card material on a childless pseudo-element"
type: adr
status: accepted
date: 2026-10-28
tags: [adr, performance, gpu, compositing, glass, css, macos, mac-optimisation, phase-g, adr-255, adr-257, adr-259]
description: "The VirtualDataTable card (material-host) draws its fill, inset highlight and backdrop filter on a childless ::before under the rows, so scrolling no longer re-renders and re-filters a card-sized backdrop surface. Measured on the Mac (standard, Full effects on): ledger scroll GPU -24%, sustained GPU -22%. Other cards, the sidebar rail and the top bar keep the box material, because converting them all doubled the compositor layers. The ledger card's border ring changes by up to 15/255; approved by Tor. The mac-baseline window-scroll segment now bounces on short pages."
aliases: [adr-260, material host, i1, ledger card material]
related_code:
  [
    "apps/frontend/src/index.css",
    "apps/frontend/src/components/shared/VirtualDataTable.tsx",
    "scripts/lib/mac-baseline/segments.ts",
    "scripts/lib/mac-baseline/variants.ts",
    "scripts/mac-baseline-variants/glass-blur.css",
  ]
---

# ADR-260: Ledger card material on a childless pseudo-element

## Status

Accepted on 2026-10-28. Tor approved the revised version and its border-ring change after the Mac
runs of 2026-10-27 and 2026-10-28. It supersedes the line of
[[docs/adr/257-ledger-scroll-and-squircle-clips|ADR-257]] that rejected moving card blur to a
pseudo-element, for the ledger card only.

## Context

An element with `backdrop-filter` renders its whole subtree into its own surface. The ledger rows
change on every scroll frame, so the card-sized surface was redrawn and re-filtered each frame.
A first version (I1) moved the material of every Card, the sidebar rail and the top bar to a
`::before`. On the Mac it cut standard-tier ledger scroll GPU by 26%, but window scroll cost 7 to
30% more and idle renderer CPU rose 13 to 17%. Headless Chromium showed why: each converted box
becomes a `::before` layer plus a content layer, so `/` went from 25 to 45 compositor layers and
every frame had more to draw. A `:has()` exclusion also added style work on each ledger row insert.

## Decision

- Only Cards with the `material-host` class draw their material on a childless `::before`
  (`z-index: -1`, `isolation: isolate` on the box, radius and corner shape inherited). The
  `VirtualDataTable` Card sets it.
- Every material, tier, vibrancy, reduced-transparency and print rule also sets
  `--material-fill`, `--material-backdrop` and the inset and outer shadow variables, so the
  pseudo shows whatever wins on the box, including ADR-255's saturate-only cards, ADR-257's
  opaque reduced fills and ADR-259's declaration order.
- The `mac-baseline` window-scroll segment scrolls back and forth until the full distance is
  travelled; before, short pages stopped after 1595 px (`/`) and 714 px (`/statistics`).

## Consequences

- Measured on the Mac on 2026-10-28 (M1 Air, standard, Full effects on, two launches each,
  alternating): ledger scroll GPU 2169-2254 to 1530-1829 mW (-24%), sustained GPU -22%,
  sustained package power -18%. Window scroll, chat streaming and idle GPU are flat. Window-scroll
  renderer CPU is 6 to 11% higher on `/` and `/statistics`, which have no ledger; not explained.
- Look: the 1 px border ring of the ledger card now sits over the unfiltered backdrop, up to
  15/255 darker in dark mode; the material is within 4/255. All other screens are unchanged.
- A new host must justify its extra compositor layers with a measurement.
