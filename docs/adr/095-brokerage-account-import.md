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
Proposed

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

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/078-portfolio-csv-import|ADR-078: Portfolio CSV Import]] (pipeline reused)
- [[docs/adr/090-cash-sleeve-trades-as-transfers|ADR-090: Trade cash legs]]
- [[docs/adr/091-per-account-positioning|ADR-091: Per-account lots]]
- [[docs/adr/066-saved-custom-csv-parsers|ADR-066: Custom parsers]]
