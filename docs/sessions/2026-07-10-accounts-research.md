---
title: Session 2026-07-10 — Accounts feature research (budgeting → portfolio)
type: session
date: 2026-07-10
tags: [session, research, accounts, budgeting, portfolio, ux, adr-088, adr-094, adr-103]
description: Four sequential research passes over the accounts epic — budgeting correctness, performance, UI/UX, and a portfolio-extension design — all findings written to TODO.md § "Accounts feature research 2026-07-10".
---

# Session 2026-07-10 — Accounts feature research

Research-only session (no code changed). Four sequential agent passes audited the accounts
epic ([[docs/adr/088-account-entity]]–[[docs/adr/103-per-account-holdings-ui-flag]]) and wrote
everything into `TODO.md` § **🏦 Accounts feature research 2026-07-10 (budgeting → portfolio)**
— that section is the source of truth; this note is only the pointer.

## What was done

1. **Budgeting correctness** — 4 new findings. Headline 🔺: the net-worth headline
   (`infoRepositoryNetWorth.js`) still uses the naive latest-stamped-balance figure and never got
   the [[docs/adr/094-balance-reconciliation-drift|ADR-094]] anchor+delta fix, so it visibly
   disagrees with the by-account table on the same page. Also: merge corrupts the survivor's
   balance with interleaved stamps (⏫), close/archive has no aggregate semantics (⏫),
   `funding_account_id` accepts cycles/self-refs (🔽).
2. **Budgeting performance** — 6 findings. Headline ⏫: backend net-worth caches are never busted
   by account mutations. `mv_bank_balances` confirmed dead (zero readers, rebuilt on every edit);
   missing partial index for stamped-balance probes; AccountsPage eagerly runs the full portfolio
   pipeline for a dead ADR-103 prop.
3. **Budgeting UI/UX (the priority pass)** — diagnosis + 10 findings, live-verified on the demo
   app. Root cause: the UI projects the data model instead of the user's three questions (*what
   do I have / is it right / how do I fix it*); balances carry no provenance, reconciliation is a
   permanent badge instead of a flow, and three surfaces compute+label balances three ways.
   Top-leverage fixes: reconcile-as-a-flow, an "as of {date} + {n} entries since" provenance line,
   one balance definition everywhere.
4. **Portfolio extension design** — recommends **Level 1: broker accounts as tags on trades**
   (grouping/attribution only; cost basis, sell validation, tax stay global — confirmed Belgian
   tax never needs per-custodian basis). ADR-091's per-account cost-basis machinery gets deleted,
   not fixed: ~10 filed bugs become moot. 6 phases; `VITE_ENABLE_PER_ACCOUNT_HOLDINGS` is retired
   in Phase 1, not flipped on. Open questions for the user are listed in the TODO section
   (Q5 — broker-cash-statement imports — decides delete-vs-fix for the brokerage cash-row path).

## Sign-off + plan (same session, later)

The user asked whether the researched direction was the best possible UX; the main-agent
verdict (filed as a §3️⃣ addendum): patch-fixes make the current shape trustworthy but the best
shape needs a **partial remake** — a `/accounts/:id` running-balance ledger route as the
feature's center of gravity plus a grouped hub. **The user signed off** on the look-changing
scope and answered all §4️⃣ open questions (notably: per-broker **P&L will be built** — via
whole-lot broker tagging partitions, overriding the Level-1 ceiling; brokerage cash-statement
imports are **kept and fixed**; per-broker history chart rebuilt later on a persisted side
table; wallets visually distinguished; lots bulk-assigned via nudge).

Decisions recorded as [[docs/adr/107-accounts-budgeting-ux-remake|ADR-107]] (budgeting remake)
and [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]] (portfolio v2). The **operative
implementation plan** — 16 work packages across Track A (backend truth), Track B (budgeting UX
remake), Track C (portfolio v2), with per-WP acceptance criteria and 10 binding guardrails for
implementing agents — is TODO.md § *Accounts feature research 2026-07-10* → **5️⃣ Implementation
plan**. §4️⃣ carries a supersession banner where the decisions overrode it.

## Next steps

Implementation starts at **WP-A1** (unify the balance computation + expose provenance) and
proceeds in the §5️⃣ dependency order. Research phase is closed.
