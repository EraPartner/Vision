---
title: ADR-121 Belgian Tax Zustand Slice
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags: [adr, frontend, zustand, belgian-tax, performance, settings]
description: Keep Belgian tax profile state in the shared settings store, with selector-based consumers and a side-effect-only compatibility provider.
aliases: [adr-121, belgian-tax-zustand]
---

# ADR-121: Belgian Tax Zustand Slice

## Status

Accepted

## Context

`BelgianTaxProfileContext` owned a large persisted domain model, transient year state, derived
calculations, and every mutation. Its broad context value made all consumers render for every
field edit. The multi-year strip then ran the complete Personal Income Tax (PIT) calculation for
up to eight years on each wizard keystroke. The module also re-exported pure tax types and
constants, hiding their real owner.

## Decision

Add a Belgian-tax slice to the shared Zustand settings store. The slice owns the live profile,
snapshots, audit metadata, viewed year, current calculation, and atomic actions. Production
consumers select only the state they use. `BelgianTaxProfileProvider` remains as a compatibility
and lifecycle boundary, but it only hydrates and persists the slice.

Pure tax types and constants are imported directly from `lib/belgianTax`. The current-year live
calculation remains immediate. The comparison strip debounces its profile input before performing
the bounded multi-year calculations, so rapid form input is coalesced without delaying the main
preview. Hydration establishes a persistence baseline and does not write preloaded values back.

## Consequences

- Snapshot rollover and audit updates occur in one store transition.
- Unrelated tax-state changes do not render narrow selector consumers.
- Multi-year comparisons update shortly after typing settles; the primary preview remains live.
- The three existing settings keys and their JSON shapes remain unchanged.
- The compatibility provider-scope error remains available to catch invalid hook placement.

## Related

- [[apps/frontend/src/stores/settingsStore.ts|Settings store]]
- [[apps/frontend/src/stores/belgianTaxStore.ts|Belgian tax slice]]
- [[apps/frontend/src/contexts/BelgianTaxProfileContext.tsx|Hydration compatibility boundary]]
- [[docs/features/belgian-tax|Belgian Tax]]
