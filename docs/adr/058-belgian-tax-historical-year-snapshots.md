---
title: ADR-058 - Belgian Tax Historical Year Snapshots
type: adr
status: accepted
date: 2026-05-11
tags: [adr, belgian-tax, tax-overview, historical-year, snapshots, viewer]
description: Adds a historical year viewer for the Belgian Tax Overview and Portfolio Tax pages, backed by auto-rollover profile snapshots and live recomputation.
aliases: [adr-058, historical-tax-snapshots, tax-year-viewer]
---

# ADR-058: Belgian Tax Historical Year Snapshots

## Status
Accepted

## Date
2026-05-11

## Context

The Belgian Tax Overview (`/tax`) and Portfolio Tax (`/portfolio/tax`) surfaces both read a single `taxYear` field off the live `BelgianTaxProfile`. Switching that year mutates the persisted profile, which means the user cannot meaningfully view a past year — the profile inputs that drove that year's numbers are already gone. Belgian tax law is also year-specific (brackets, exemptions, regional credits, ETF TOB rates, Reynders / Arizona CGT all shifted between IY 2024–2026 per ADR-053…057), so reconstructing a historical view requires the inputs the user had **at the time**, not today's profile.

The user asked for: click the year badge → dropdown of relevant years → see the same overview reconstructed for that year. Past years should be locked in so they reflect what was projected/recorded at the time; only the current year stays freely editable. Portfolio fees, taxes, and the projected PIT should all be visible for past years.

## Decision

Introduce a frozen per-year `BelgianTaxProfile` snapshot store and a transient `viewedYear` UI state, both owned by `BelgianTaxProfileContext`. The tax surfaces read year-aware versions of the profile and calculation, while the dialog gains a historical-edit mode for amending past snapshots behind a warning banner.

### Data model

- New persisted setting `belgian_tax_profile_snapshots_v1` (JSONB): `Record<number, BelgianTaxProfile>`, keyed by income year. The existing `belgian_tax_profile` setting continues to hold the **live, active** profile and always represents the user's current income year.
- The provider exposes:
  - `viewedYear: number` — non-persisted UI state; defaults to the live profile's `taxYear`.
  - `snapshots: BelgianTaxProfileSnapshots` — loaded from preload.
  - `profileForYear(year)`, `calculationForYear(year)` — resolve snapshot-or-fallback and recompute live via `computeBelgianPIT`.
  - `snapshotExistsForYear`, `createSnapshotFromLive`, `updateSnapshot`, `isViewingHistorical`.

### Snapshot lifecycle

1. **Auto-rollover.** When `updateProfile({ taxYear })` advances the live profile's year from Y to Y′ > Y, the outgoing profile (with `taxYear = Y`) is archived into `snapshots[Y]` atomically — but only if no snapshot for Y already exists, so subsequent year-toggling never clobbers a real historical record.
2. **Backfill.** If the user views a year that has no snapshot but appears in the dropdown (because of transactions), the page shows an estimate banner and a CTA to seed a snapshot from the current live profile.
3. **Edit-past.** The profile dialog accepts a `targetYear` prop. When `targetYear !== liveYear` and a snapshot exists, the dialog reads/writes via `snapshots[targetYear]`, strips `taxYear` from incoming patches (so the snapshot's year stays pinned), and renders an amber warning alert at the top.

### Year list

A new `useAvailableTaxYears()` hook produces the union of: snapshot years, years with portfolio transactions carrying `taxes`/`fees` (or `type === 'tax' | 'fee'`), years with transactions in user-configured taxable-income categories, plus the live year. Years are sorted descending. The hook returns flags (`isCurrent`, `hasSnapshot`, `hasTransactions`) so the switcher can label each row.

### Surface integration

- `TaxYearSwitcher` (dropdown styled like the prior year badge) and `HistoricalYearBanner` (snapshot/estimate alert) are dropped into both `/tax` and `/portfolio/tax`. Both pages share the provider's `viewedYear`, so switching on one surface reflects on the other.
- Pages alias `profile`/`calculation` to the year-aware getters so existing read sites keep working unchanged. `liveProfile` is retained for the empty-state / "is the user set up at all" guard.
- `TaxOverviewPage` scopes the monthly reserve chart to months *within* the viewed year when historical (otherwise trailing 12 months, as before).
- The yearly chart's `pitForGross` now resolves each bar's base profile via `profileForYear(y.year)`, so historical bars reflect the snapshot's inputs when available and fall back to the live profile otherwise.

## Consequences

### Positive
- Past years can be viewed without disturbing the live profile.
- Snapshots capture the user's intent at the time (region, employment, dependents, deductions, taxable-income category mapping).
- No new endpoints — uses the generic Settings API.
- Tax law year-keyed tables and per-year portfolio adjustments / classifications (`portfolio_tax_adjustments_v1`, `portfolio_tax_classifications_v1`) compose cleanly with `viewedYear` without storage changes.

### Negative / known limits
- **Engine drift.** Calculations are recomputed live from frozen inputs. If `computeBelgianPIT` changes (bug fix or new bracket release), past-year displayed numbers shift retroactively. An "as filed" calculation snapshot is a possible v2 addition but adds audit-grade complexity for marginal user value.
- **Exchange rates are not point-in-time.** Both pages still convert historical foreign-currency transactions using today's rates. Out of scope here.
- **Soft lock.** Past snapshots remain editable behind a warning banner rather than a hard immutability barrier; this matches the user's preference for an escape hatch over a strict audit-grade lock.
- **Default empty snapshot store.** Existing users have no snapshots until they next advance `taxYear`. Viewing past years before that renders the estimate banner with a "Create profile for {year}" CTA.

### Neutral
- Settings JSONB blob grows by roughly one `BelgianTaxProfile` (~1 KB) per stored year. Negligible at expected cardinality.

## Related
- [[docs/features/belgian-tax|Belgian Tax feature]]
- [[docs/features/portfolio-tax|Portfolio Tax feature]]
- [[docs/adr/055-belgian-tax-income-source-filtering|ADR-055]] — taxable income source filtering (per-year impact)
- [[docs/adr/056-belgian-tax-audit-fixes-ay2026|ADR-056]] — year-aware audit fixes that the live recompute benefits from
- [[docs/adr/057-belgian-tax-audit-followup-pwc-may-2026|ADR-057]] — year-aware suggested deductions + per-residence centimes override
- [[docs/adr/index|All ADRs]]
