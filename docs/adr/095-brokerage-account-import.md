---
title: ADR-095 Brokerage Account Import
type: adr
date: 2026-06-18
tags: [adr, import, brokerage, portfolio, cash-sleeve, dedup, leg-linking, adr-078, adr-090, adr-091]
description: A unified importer that splits one brokerage statement into cash transactions and portfolio trades, links each trade to its auto-created cash leg, and dedups both sides — building on the ADR-078 portfolio import pipeline and the ADR-090 cash-sleeve plumbing.
aliases: [brokerage import, unified statement import, trade + cash import]
---

# ADR-095: Brokerage Account Import

## Status
Implemented — 2026-06-19 (fan-out core + mixed-row staging + review UI all built and tested; see the
2026-06-19 update at the end of "Implementation status"). Originally logged Partially implemented
2026-06-18.

## Date
2026-06-18

## Context

A brokerage statement interleaves **two kinds of rows**: cash movements (deposits, withdrawals,
dividends, interest, fees, taxes) and **trades** (buys/sells). Today the budgeting importer
(ADR-066) only makes `transactions` and the portfolio importer (ADR-078) only makes
`portfolio_transactions`; neither produces both from one file, and nothing links a trade to its
cash effect. With per-account lots (ADR-091) and trade cash legs (ADR-090) in place, one statement
can now populate both sides coherently. This is the originally-flagged **"dangerous" part** —
routing rows to the right target, leg-linking, dedup, and avoiding double-counting are where it
goes wrong.

## Decision

A brokerage importer that, for a chosen brokerage **account**, splits one parsed statement:

- **Routing.** Each parsed row is classified into a target by its kind:
  - cash movement (deposit/withdrawal/dividend/interest/fee/tax) → a `transactions` row on the
    account's sleeve;
  - trade (buy/sell) → a `portfolio_transactions` row on the account (ADR-091), **plus its
    auto-created cash leg** (ADR-090) — so a buy's cash debit is the trade's leg, **not** a second
    standalone cash row. This is the key double-count guard: a trade contributes exactly one cash
    movement (its leg), never two.
- **Leg-linking.** The trade and its cash leg are linked via `portfolio_transaction_id` (ADR-090);
  created together so the import is internally balanced.
- **Dedup on both sides.** Cash rows dedup via the existing `tx_hash` partial-unique (ADR, race
  safe); trades dedup on (account, investment, date, type, units, amount). Re-importing the same
  statement is a no-op.
- **Mandatory staged review** (reuse ADR-078's stage → validate → match → review → commit): the
  user confirms the routing (which rows are trades vs cash, instrument matching) before commit.
  Conservative — unresolved rows block commit rather than guess.
- **Reuse, not fork.** Built on the ADR-078 portfolio import pipeline + ADR-066 custom parsers; a
  brokerage parser kind emits classified rows; the commit step fans out to both repos.

## Consequences

**Positive**
- One import keeps cash and holdings consistent; a buy debits the sleeve by exactly its cost.
- Re-import is idempotent (dedup both sides); review prevents silent mis-routing.

**Negative / cost**
- The commit fan-out (trade + leg + cash rows) must be transactional and idempotent — the highest
  data-integrity bar in the epic.
- Per-broker parsing/classification rules; the review step is essential, not optional.

**Risks / mitigations** (this is the flagged danger area)
- *Double-counting a buy's cash* → the cash debit is the trade's **leg only**; the importer never
  also emits a standalone cash row for a trade. Verified by a balance test on a sample statement.
- *Mis-routing* (a fee read as a trade) → staged review; unresolved rows block commit.
- *Duplicate on re-import* → `tx_hash` (cash) + trade dedup key; both checked at commit.
- *Partial commit* → fan-out in one DB transaction; all-or-nothing per row group.

## Implementation status (2026-06-18)

**Built:** the previously-dead `brokerageRouting.js` is now wired into a tested fan-out service at
`apps/node-backend/src/services/importPipeline/brokerageFanout.js`, exporting `planBrokerageFanout`
and `commitBrokerageFanout`. The core correctly routes one statement into the cash ledger + trades +
ADR-090 cash legs, deduplicates both sides, and enforces the double-count guard (a trade's only cash
movement is its leg; no standalone cash row is emitted for a buy).

`portfolio_import_batches.account_id` (migration 0057, authored, not applied) wires the destination
brokerage account through to committed lots.

**Not yet built (remaining surface):**
- The brokerage **parser kind** — the mixed-row CSV parser that classifies rows as cash vs trade
- **Mixed-row staging** — the staging schema changes to hold both row kinds in one batch
- **Review UI integration** — the portfolio import review page does not yet show per-row cash/trade routing choices

Until those are built, the fan-out service is wired and tested but is not reachable from the import UI.

### Update 2026-06-19 — remaining surface is now built (and was already, when this was re-checked)

All three "not yet built" items above are in fact implemented; the 2026-06-18 note was superseded by
migrations `0057`/`0060` and the import UI work that landed afterward:

- **Mixed-row staging** — migration `0060_brokerage_import_routing` adds
  `portfolio_import_batches.is_brokerage` + `portfolio_import_staging_rows.route`; `0057` adds the
  batch `account_id`. `validate.js` sets `route` ('cash' | 'portfolio') per row via
  `classifyBrokerageRow`; `commit.js` fans cash rows + ADR-090 trade legs out inline within the
  staged flow (it does NOT call the standalone `brokerageFanout.js` — that service is an equivalent,
  separately-tested implementation of the same algorithm).
- **Parser kind** — satisfied by the generic adapter emitting `type_raw`, classified at validate
  time. No dedicated "brokerage parser kind" was needed; the design moved classification one stage
  later (validate) than the original sketch (parse).
- **Review UI** — `PortfolioImportPage` exposes the brokerage toggle + sleeve-account picker;
  `PortfolioImportReviewPage` renders the cash group separately and commits with the chosen account;
  `prepareImport` forces every `is_brokerage` batch through staged review before any fan-out.

Tested by `brokerageRouting`, `brokerageFanout`, `portfolioImportCommit`, and `tradeCashLegService`
(39 passing). One deliberate non-feature: the review UI shows the per-row cash/trade routing
read-only (it is deterministic from the row kind; unknown kinds error and block commit) — there is
no user-facing override to flip a row's route. That would be a separate, optional enhancement.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/078-portfolio-csv-import|ADR-078: Portfolio CSV Import]] (pipeline reused)
- [[docs/adr/090-cash-sleeve-trades-as-transfers|ADR-090: Trade cash legs]]
- [[docs/adr/091-per-account-positioning|ADR-091: Per-account lots]]
- [[docs/adr/066-saved-custom-csv-parsers|ADR-066: Custom parsers]]

> [!note] 2026-06-20 — Brokerage UI gated by ADR-103
> The brokerage-routing **frontend surfaces** introduced by this ADR (brokerage toggle + sleeve-account picker on `PortfolioImportPage`; per-row cash/trade routing display + account picker on `PortfolioImportReviewPage`) are hidden by default behind `VITE_ENABLE_PER_ACCOUNT_HOLDINGS=false` (ADR-103). Standard portfolio CSV import (non-brokerage) is unaffected. The `brokerageFanout` service and `tradeCashLegService` backend code are retained and go dormant. See [[docs/adr/103-per-account-holdings-ui-flag|ADR-103]] for the flag details.

---

## Addendum (2026-07-10): Instrument-less rows route as signed cash rows (D6)

### Context

Account-level dividend/interest/fee rows without a resolvable instrument — sleeve interest, fund
distributions the symbol matcher can't map, custody fees — currently have **no representable
path**: `brokerageRouting.js` routes them `'portfolio'` and `commit.js` errors every one with
"unresolved instrument", so a real brokerage statement can never fully import (filed finding;
prerequisite 7 of the [[docs/adr/103-per-account-holdings-ui-flag|ADR-103 addendum]] gate).
Decision 2026-07-10 (accounts-rewrite round 2): **signed cash row**, per this ADR's own routing
philosophy — an instrument-less money movement *is* a cash movement.

### Decision

Rows classified dividend/interest/fee/tax that resolve **no instrument** route `'cash'` instead
of `'portfolio'`: one signed `transactions` row on the batch's sleeve account (positive for
interest/distributions, negative for fees/taxes), auto-categorized by row kind (interest income /
investment fees), deduplicated by the existing cash-side `tx_hash` path. Rows that *do* resolve
an instrument keep today's trade + ADR-090 cash-leg path unchanged — this addendum only gives the
instrument-less remainder somewhere to go.

**Accepted trade-off:** these amounts live in the *ledger*, not in portfolio analytics — an
account-level distribution won't count toward per-instrument dividend-income surfaces
(ADR-096). Category-based reporting covers them. If per-account cash yield reporting is ever
wanted inside portfolio analytics, that's a separate enhancement, not a rerouting.

### Consequences

- Brokerage statements import completely; the "unresolved instrument" error remains only for
  rows that *should* have matched (true trade rows), where it is a correct signal.
- The review UI's read-only routing display gains a third visible outcome
  (cash-from-instrument-less) — still deterministic from the row, still no user override.
- No schema change; ships inside the accounts-rewrite Phase E work.
