---
title: ADR-107 Accounts budgeting UX remake — ledger-centered, one balance definition
type: adr
status: accepted
date: 2026-07-10
tags: [adr, accounts, ux, budgeting, reconciliation, ledger, adr-088, adr-092, adr-093, adr-094, adr-099]
description: Restructure the budgeting accounts surface around a Glance → Overview → Ledger architecture — one balance definition (anchor+delta) on every surface with a provenance line, reconciliation as a first-class flow, a grouped accounts hub, and a new per-account ledger detail route — replacing the summary-card-grid + dialog-dropdown shape.
aliases: [accounts ux remake, ledger view, account detail route, reconcile flow]
---

# ADR-107: Accounts budgeting UX remake — ledger-centered, one balance definition

## Status
Accepted — 2026-07-10 (user signed off on the look-changing scope explicitly).

## Date
2026-07-10

## Context

The accounts epic ([[docs/adr/088-account-entity|ADR-088]]–[[docs/adr/103-per-account-holdings-ui-flag|ADR-103]])
shipped a model-first UI: a flat card grid whose every action is a dialog behind a kebab menu.
A four-pass research session (2026-07-10, findings in `TODO.md` § *Accounts feature research
2026-07-10*) diagnosed why the user is not content with it:

- **Surfaces disagree.** Dashboard widget = naive latest stamp under raw IBAN tails; hub =
  anchor+delta under display names; net-worth headline = a third computation that never got the
  [[docs/adr/094-balance-reconciliation-drift|ADR-094]] fix. Different numbers, names, account
  counts, and warning states for the same accounts.
- **No provenance.** The anchor date is computed in SQL and discarded; balances are naked
  numbers, so anchor+delta behavior reads as unexplained number movement (or non-movement for
  backdated entries).
- **Reconciliation is a badge, not a flow.** The drift badge is permanently red, dateless, and
  its only remedy is Edit → Advanced → two raw fields.
- **No place to answer "is it right?".** Drill-down dead-ends in a bare filtered transaction
  list. The backend's per-account running-balance window (`transactionRepository.js`,
  `include_balance`) has zero frontend consumers.
- Model leaks: `name` vs `display_name` unexplained, four end-of-life verbs (two identical under
  ADR-103), dormant flags in the dialog, misleading €0,00 brokerage shells, no opening-balance
  path for manual accounts.

## Decision

Restructure the budgeting accounts surface around a **three-level architecture** with **one
balance definition everywhere**:

1. **One number.** Every surface (dashboard widget, hub, net-worth headline and by-account,
   drill-down header) uses the ADR-094 anchor+delta computed balance from
   `accountBalanceSql.js`'s lateral, which additionally returns `anchor_date` and
   `post_anchor_count` for provenance. Stamps remain for history series. Naive
   latest-stamp balances are removed from all current-balance displays.
2. **Provenance line.** Balances carry a muted subline: *"as of {date} bank statement + {n}
   entries since"* (stamp-less: *"sum of {n} entries"*). Backdated manual entry (at/before the
   anchor) gets an inline explanation in the add-transaction dialog.
3. **Reconcile as a flow.** Per-account Reconcile action (card, badge click, detail header):
   statement input + date, live drift preview, exits *"re-anchor"* and *"show transactions
   since {date}"*. Drift badge shows the statement date; stale-statement drift renders in
   warning tone, not destructive.
4. **Glance → Overview → Ledger.**
   - *Glance*: dashboard widget, same numbers/names/population as the hub.
   - *Overview*: hub grouped (Cash & Savings · Portfolio accounts · Liabilities · Archived
     collapsed), sorted by display label, per-group subtotals + a Net cash line; portfolio-type
     cards stop showing misleading €0,00 (see [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]]).
   - *Ledger*: new route `/accounts/:id` — header (display name, balance + provenance, drift
     chip → Reconcile, balance sparkline) over a running-balance ledger using the existing
     `include_balance` backend. Account actions (edit/merge/close) relocate here.
5. **Lifecycle cleanup.** One "Close account…" verb (Archive folded in; Delete only offered when
   it can succeed), close flow handles residual balance and net-worth exclusion; merge gets a
   preview (what moves, projected balance) and a receipt with real counts; manual accounts get
   an opening-balance field that mints a visible ledger row instead of a drift badge; dormant
   flags hidden from the dialog while their consumers are off.

The rich visual language (aurora/glass/jewel accents per ADR-105) is untouched; this ADR changes
structure and copy, not the aesthetic.

## Consequences

- Positive: the three user questions (*what do I have / is it right / how do I fix it*) each get
  a surface; cross-surface disagreement — the main trust killer — is eliminated at the
  definition level, not patched per widget; the drift heuristic becomes legible and actionable;
  ~10 of the 2026-07-10 UI/UX findings are resolved structurally rather than individually.
- Negative: a new route and hub restructure is an L-sized frontend effort; the widget's
  historical series semantics need a decision during implementation (stamped vs anchor+delta
  per day) — flagged to the user if the chart visibly shifts; several i18n strings change
  (en+nl).
- Neutral: TransactionsPage keeps its filtered view (gains an Account filter); the interim
  "running-balance column on the filtered list" idea from the research is superseded by the
  detail route.

Implementation plan with work packages: `TODO.md` § *Accounts feature research 2026-07-10* →
*5️⃣ Implementation plan*.

## Related
- [[docs/adr/088-account-entity|ADR-088]] · [[docs/adr/092-liabilities-as-negative-accounts|ADR-092]] · [[docs/adr/093-net-worth-sum-of-accounts|ADR-093]] · [[docs/adr/094-balance-reconciliation-drift|ADR-094]] · [[docs/adr/099-sidebar-navigation-ia|ADR-099]]
- [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]] (portfolio side of the same remake)
- [[docs/adr/index|All ADRs]]
