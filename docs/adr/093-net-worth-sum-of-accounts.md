---
title: ADR-093 Net Worth = Σ Accounts
type: adr
date: 2026-06-18
tags: [adr, net-worth, accounts, liabilities, cash-sleeve, adr-064, adr-061, adr-088]
description: Redefine net worth as the sum over in-net-worth accounts (cash ledger + holdings − debt), superseding ADR-064's bank-balances-plus-portfolio composition. The aggregate is realized by the account foundation; the per-account breakdown and snapshot-engine supersession are the analytics follow-on.
aliases: [net worth sum of accounts, net worth redefinition]
---

# ADR-093: Net Worth = Σ Accounts

## Status
Accepted — 2026-06-18 (analytics follow-on realized; see note below)

## Date
2026-06-18

## Context

ADR-064 composed net worth as *bank balances (statement `balance`) + portfolio summary*, with
liabilities unmodelled. With accounts now first-class (ADR-088), typed with `in_net_worth`
(ADR-089), holding cash sleeves (ADR-090), and able to be negative liabilities (ADR-092), net
worth should be **one rule: the sum over accounts** — no bank-vs-portfolio special-casing, debt
included.

## Decision

**Net worth = Σ over `in_net_worth=true` accounts of (cash ledger balance + holdings market value
− debt).** Liabilities contribute negative balances; cash sleeves contribute their ledger balance;
holdings contribute market value.

**The aggregate is already realized by the foundation** and needs no further code to be correct at
the total level:

- The net-worth bank side sums **`in_net_worth` accounts only** (ADR-089, wired into
  `infoRepositoryNetWorth`), which includes liability accounts as **negative** balances (ADR-092)
  — so debt nets in.
- The holdings side is the portfolio summary total (ADR-044).
- Cash-sleeve balances are real ledger rows (ADR-090), counted once on the cash side; holdings are
  counted once on the portfolio side → no double-count.

So today's net-worth total already equals Σ accounts including debt.

**Deferred to the analytics follow-on (depends on ADR-091's per-account holdings + runtime
verification):**

- A **per-account net-worth breakdown** (each account's cash + its holdings at market), which
  requires the per-account portfolio summary (ADR-091 analytics).
- **Fully superseding ADR-064's snapshot composition** so the persisted daily snapshots and the
  net-worth page are expressed natively as Σ accounts, with **ADR-061 parity tests** locking the
  snapshot outputs across the cutover.

## Consequences

**Positive**
- One definition of net worth (Σ accounts) that already nets debt and cash sleeves correctly at
  the total level.
- No special-casing; new account types automatically participate via `in_net_worth`.

**Negative / cost**
- The per-account breakdown and the snapshot-engine rewrite are non-trivial and are sequenced
  after ADR-091 analytics + a runtime parity pass (ADR-061), to avoid silently shifting the
  historical net-worth series.

**Risks / mitigations**
- *Shifting the historical series* on cutover → keep the existing snapshot engine until the
  account-native rebuild is parity-tested (ADR-061).
- *Double-counting cash vs a "savings" investment* → prevented by ADR-090's single-source-of-truth
  sleeve (cash is the ledger, never also an investment).

## Analytics follow-on realized (2026-06-18)

The two deferred items are now shipped via [[docs/adr/100-net-worth-account-native-holdings|ADR-100]]:

- **Per-account net-worth breakdown:** each `in_net_worth` account's cash (computed ledger balance via ADR-094) is combined with its holdings from the `byAccount` split of `getPortfolioSummary` (ADR-091 + ADR-100). `NetWorthPage` renders a "By Account" table (cash + holdings + total per account). Frontend hook: `useAccountNetWorth`.
- **Snapshot-engine supersession (partial):** the *live* aggregate and the current-day per-account breakdown are now expressed natively as Σ accounts. Historical snapshot series is **deliberately retained** — no per-account daily history exists yet; the ADR-061 parity risk of shifting the series was avoided. See ADR-100 for the full decision.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/100-net-worth-account-native-holdings|ADR-100]] (realizes the per-account + parity follow-ons)
- [[docs/adr/064-net-worth-current-value-live-overlay|ADR-064: Net Worth composition]] (superseded composition)
- [[docs/adr/061-snapshot-valuation-parity|ADR-061: Snapshot parity]] (parity discipline for the cutover)
- [[docs/adr/092-liabilities-as-negative-accounts|ADR-092]] · [[docs/adr/090-cash-sleeve-trades-as-transfers|ADR-090]] · [[docs/adr/089-account-typed-model|ADR-089]]
