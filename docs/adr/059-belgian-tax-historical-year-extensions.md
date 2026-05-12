---
title: ADR-059 - Belgian Tax Historical Year Extensions
type: adr
status: accepted
date: 2026-05-12
tags: [adr, belgian-tax, historical-year, snapshots, as-filed, audit-log, comparison, trend-strip]
description: Extends ADR-058's historical year viewer with frozen "as-filed" calculations, a filed soft-lock, snapshot audit log, year-over-year comparison, multi-year trend strip, and CSV export.
aliases: [adr-059, historical-year-extensions, as-filed-snapshots]
---

# ADR-059: Belgian Tax Historical Year Extensions

## Status
Accepted

## Date
2026-05-12

## Context

ADR-058 introduced per-year frozen `BelgianTaxProfile` snapshots and a `viewedYear` UI state so users could view past income years with the inputs they had at the time. That solved the **inputs side** of historical fidelity. It left several gaps the user has now asked us to close:

- **Engine drift.** Calculations were always live-recomputed from frozen inputs. A future bug fix to `computeBelgianPIT` or a new bracket release would retroactively change past-year displayed numbers — even for years the user already filed. ADR-058 flagged this as a v2 candidate ("an 'as filed' calculation snapshot is a possible v2 addition but adds audit-grade complexity for marginal user value"). Two iterations of audit fixes later (ADR-056, ADR-057) plus the user actually filing a return, the value is no longer marginal.
- **No filed-state distinction.** A year viewed historically was indistinguishable from a year the user formally filed. Soft-locking ADR-058's amend warning behind a deliberate filed/unfiled toggle prevents accidental amendments and clarifies which numbers are paper-trail authoritative.
- **No amendment history.** Past snapshots were editable behind an amber warning but the system kept no record of what changed or when. Discovering "did I change my 2024 region last week or did I always have it as Brussels?" had no answer.
- **Comparison ergonomics.** Users compared years by toggling the year switcher back and forth and reading the same cards twice. A side-by-side delta surface is what they actually wanted.
- **At-a-glance trend.** The yearly chart was the only multi-year surface and it was buried beneath the PIT breakdown. A compact header-level strip surfaces the trend without scrolling.
- **No structured export.** Users with multiple residences / multiple sources of income kept paper copies of filed returns elsewhere because Vision didn't emit anything portable.

## Decision

Extend `BelgianTaxProfileContext` with a sibling sparse meta store, add new context mutators for freeze/file/audit operations, and ship four new components plus a pure CSV export module. The existing snapshot shape (`BelgianTaxProfileSnapshots = Record<number, BelgianTaxProfile>`) stays untouched so no migration is needed; meta is opt-in per-year.

### Data model

New persisted setting `belgian_tax_profile_snapshot_meta_v1` (JSONB), shape:

```ts
type BelgianTaxProfileSnapshotMetas = Record<number, {
    frozenCalculation?: BelgianTaxCalculation;  // captured at freeze/file time
    filing?: { filedAt: string; reference?: string };
    history?: SnapshotAuditEntry[];             // append-only, bounded
}>;
```

`SnapshotAuditEntry` records `{ at, kind, changes?, reference? }` where `kind` is one of `created | patched | frozen | unfrozen | filed | unfiled`. Patches store only the diff (`Partial<BelgianTaxProfile>`), not the full snapshot — keeps the JSONB bounded. The log is trimmed at `MAX_HISTORY_ENTRIES_PER_YEAR = 200` from the head to cap pathological growth.

Meta is **sparse**: years without freeze/file/edits have no entry. Existing users see no change until they freeze, file, or amend.

### Provider surface additions

`BelgianTaxProfileContext` gains:

| Member | Purpose |
|---|---|
| `snapshotMetas` | Raw map of per-year meta. |
| `metaForYear(y)` | Returns the meta entry or `null`. |
| `isYearFiled(y)` | `true` iff `meta.filing` is set. |
| `getFrozenCalculation(y)` | Returns `meta.frozenCalculation` or `null`. |
| `displayCalculationForYear(y)` | Returns frozen if present, else live `calculationForYear(y)`. Use this on read sites. |
| `getSnapshotHistory(y)` | Audit log entries, newest last. |
| `freezeCalculation(y)` / `unfreezeCalculation(y)` | Toggle the frozen calc. Appends `'frozen'` / `'unfrozen'`. |
| `markYearAsFiled(y, ref?)` / `unmarkYearAsFiled(y)` | Toggle the filing record. Filing implies freezing — if no frozen calc exists, one is captured. Pre-existing frozen calcs are **preserved** so a deliberate earlier freeze wins over auto-freeze-on-file. |

Existing mutators (`createSnapshotFromLive`, `updateSnapshot`, `updateProfile` auto-rollover) now also append the appropriate audit entries. `updateSnapshot` strips `taxYear` from the recorded diff (it's coerced server-side and not meaningful for history).

### Behavioral rules

- **Filing implies freezing.** When a year is filed, its calculation is frozen — engine changes can no longer alter the "as-filed" numbers.
- **Unfiling does *not* unfreeze.** Removing a filing tag is a clerical correction (user marked the wrong year filed); the user may still want the frozen calc preserved.
- **Soft lock, not hard lock.** Filed years are editable behind an explicit "Amend this filed year" confirmation in the profile dialog. Matches ADR-058's preference for escape hatches over audit-grade immutability.
- **Display selector precedence.** All read sites use `displayCalculationForYear` which prefers `frozenCalculation` over a live recompute. The bar chart's `pitForGross` helper also respects the frozen calc by scaling proportionally to the bar's gross income — historical filed bars stay aligned with the as-filed total.
- **Banner priority order.** `filed > frozen > snapshot > estimate` — codified in `resolveHistoricalBannerMode` and shared between the Tax Overview and Portfolio Tax pages.

### New UI surfaces

- **`MultiYearTrendStrip`** — compact strip of clickable year tiles showing PIT, effective rate, and a normalized bar. Clicking switches `viewedYear`. Renders only when at least two years are available.
- **`YearComparisonCard`** — side-by-side delta table comparing the viewed year against another year (picked via a dropdown, defaults to the immediately preceding tracked year). Surfaces gross income, total PIT, effective rate, net take-home with absolute + percent change. Color codes deltas by "favourable for the user."
- **`YearActionsMenu`** — dropdown next to the year switcher with freeze/unfreeze, mark/unmark filed, view history, export year as CSV.
- **`MarkAsFiledDialog`** — collects an optional free-text reference (Tax-on-Web id, paper return code) before marking a year filed.
- **`SnapshotHistoryDialog`** — newest-first list of audit entries with kind badge, timestamp, optional reference, and a one-line patch summary.
- **`HistoricalYearBanner`** — extended with `filed` and `frozen` modes (in addition to the existing `snapshot` and `estimate`). The filed banner surfaces the user's filing reference inline.

### CSV export

`exportTaxYearCsv` is a pure frontend module that serialises a year's profile + calculation to a three-section CSV (metadata header, profile inputs, calculation breakdown). It sources its values via `displayCalculationForYear`, so filed/frozen years export their frozen numbers verbatim. Triggered from `YearActionsMenu` via the shared `downloadBlob` helper — no backend involvement.

### Widget visibility

The Tax Overview adds two new widget IDs: `trendStrip` and `yearComparison`. Both default to visible. Users can hide them via the existing widget visibility dialog — no breaking change to the persisted widget map (unknown IDs default to `defaultVisible`).

## Consequences

### Positive

- **Engine drift solved for filed years.** Future bracket fixes, ADR corrections, and bug fixes can no longer retroactively shift filed numbers. Frozen calculations are byte-stable.
- **Audit trail for amendments.** Users can answer "what changed and when" for any year they've touched. Append-only log doubles as a self-check ("did I really change my dependents in 2024?").
- **Comparison and trend ergonomics.** Year-over-year deltas surface without scrolling between two views. The trend strip makes "how have my taxes evolved?" answerable in one glance.
- **Portable paper trail.** CSV export gives users a structured backup keyed to the year they filed it for — useful as a tax-return companion.
- **No new endpoints, no migrations.** All state rides on the generic Settings JSONB API. Existing users see no behavior change until they explicitly freeze/file/edit a year.

### Negative / known limits

- **Meta-store growth.** A full `BelgianTaxCalculation` blob is ~2 KB. With one frozen calc per year stored, ten years of filing is ~20 KB. Audit log entries are smaller (just diffs) and trimmed at 200 per year. Still negligible in the context of the Settings JSONB.
- **Exchange rates are still not point-in-time.** Foreign-currency transactions continue to convert at today's FX rates. Calling this out again — it's the largest remaining historical fidelity gap and the natural successor to this ADR.
- **No notification on engine drift.** If `computeBelgianPIT` changes such that a *non-frozen* historical year would now compute differently, the user is not told. We considered a "law-change advisory" banner (option #9 in the design exploration) but deferred it — calls back to the same v3 bucket as point-in-time FX.
- **Soft lock remains soft.** A filed year can still be amended, just with a more deliberate gesture. This is intentional — users want escape hatches, not bureaucracy — but it does mean the audit log is the only honest record of past state, not the snapshot itself.
- **CSV is not a return.** The export is a structured paper trail, not a fileable document. Users who want to import into Tax-on-Web still need to re-enter values there.

### Neutral

- Existing tests for `BelgianTaxProfileContext`, `useAvailableTaxYears`, and the historical viewer all pass with extended assertions for the new fields. Twelve new context tests cover the freeze/file/audit code paths.
- The `tax.history.kind.*` translation keys exist in both en and nl. Other affected translation surfaces (`tax.trendStrip.*`, `tax.comparison.*`, `tax.yearActions.*`, `tax.markFiled.*`, `tax.historical.filedLock.*`, `tax.yearSwitcher.{filed,frozen}*`) are mirrored across locales.

## Related
- [[docs/adr/058-belgian-tax-historical-year-snapshots|ADR-058]] — original historical year viewer (this ADR extends it)
- [[docs/adr/057-belgian-tax-audit-followup-pwc-may-2026|ADR-057]] — engine drift these frozen calcs protect against
- [[docs/adr/056-belgian-tax-audit-fixes-ay2026|ADR-056]] — earlier engine fixes that motivated the freeze concept
- [[docs/features/belgian-tax|Belgian Tax feature]]
- [[docs/features/portfolio-tax|Portfolio Tax feature]]
- [[docs/adr/index|All ADRs]]
