---
title: "ADR-189: Proved brokerage cash history"
type: adr
status: accepted
date: 2026-10-08
tags: [adr, imports, cash, transfers, receipts, migration]
description: Record complete proved broker cash chains with source-owned transfer classification, literal fee spending and guarded repeat/rollback.
---

# ADR-189: Proved brokerage cash history

## Status

Accepted for isolated implementation and verification. Applying migration
`0125_brokerage_cash_origin` to user data requires separate explicit approval; this decision
neither applies the schema nor records cash history.

## Date

2026-10-07

## Context

A complete Kinesis export contains trade quote movements, funding and card payments alongside
portfolio events. Trade quotes are asset/cash conversions. User-confirmed funding moves between
owned accounts. Treating them as ordinary income or spending would inflate cash-flow totals.
A counterpart bank leg cannot be invented from the broker export. Existing automatic/manual
pair cleanup also cannot own the classification of this proved single broker leg. Excluding a
gross funding withdrawal would hide its literal quoted fee expense.

## Decision

Provide optional `record_cash_only` with explicit `preserve_existing` and source-bound
`cash_funding_policy='own_account_transfer'`. Require complete original unfiltered Kinesis capture,
active routing, literal source identity and closure of every source cash balance chain. Select all
cash group members atomically or no new cash; overlapping selected sources, partial chains,
ambiguity or changed evidence do not authorize partial recording.
The account-wide active ledger must contain only validated same-original-source main/fee
components; unrelated dates, currencies or opening-origin rows block the scope.
The zero-opening source also requires no routed-account `account_statement_balances` reading,
even a zero reading. Those rows are read, fingerprint-bound and locked alongside ledger proof;
a new or changed statement reading invalidates the reviewed plan. No source-row picker, derived
CSV or XML application is added. Retained source/reference context remains eligible.
Ordinary direct full commit refuses new Kinesis cash until explicit bounded confirmed cash-only
review, while already-owned exact repeat settlement remains compatible. Funding ownership is
never hardcoded for unknown or changed sources; the source-bound confirmation must match their
current routing and complete capture.

Normal historical rate preparation runs automatically. Required stored date rates within seven
days are fingerprint-bound; missing readiness defers the whole group and source FX stays unstamped.

Each selected `cash`, `duplicate` or `settled` action has typed `closed_kinesis_cash` proof binding
full-file hash, group/event identity, classification, source member count and one/two component
count. New signed `cashValues` retain date/currency/account. Trade quotes and confirmed funding
are transfers; card spending remains an expense including its fee. A separately quoted
same-currency funding-withdrawal fee is a second negative expense component and the primary
transfer amount is net of that fee. Their sum equals the literal gross debit. No fee is added
again to card spending, opposite leg invented or peer guessed.

Add `transfer_source='brokerage'` to the existing CHECK. All source-owned components, including
false-transfer card/fee expenses, use this origin and a null peer. Automatic pairing excludes
source-owned origins, and orphan cleanup clears only ordinary auto/manual origins. Real account
movements remain in balances; internal quote/funding flows are excluded from ordinary income and
expenses by the existing transfer flag. This does not infer a bank match or tax classification.

`summary.cash` counts source actions; `imported` and `recordedCash` count newly recorded ledger
components. New portfolio, income, adoption, repair, custody and adjustment counts remain zero.
Source-row counters and duplicate counts continue to count settled source events rather than
components. Same-batch settled and fresh duplicate reviews reprove retained source and every
component image, with no new cash. Other source rows remain pending; every partial batch stays
awaiting review and no general event drain runs.
Successful new cash commit and guarded cash rollback refresh ordinary statistics caches. Failures
and no-op repeats do not schedule that refresh.

Store typed immutable cash envelopes in existing staging `raw_data`. The source row retains
primary committed ID and, when present, the fee ID; a deterministic derived fee fingerprint
prevents another fee insertion. Guarded rollback compares all owned after-images before removing
components atomically, retains original source/receipt evidence, and allows a fresh full source
recording afterward. Migration 0125 protects typed version-one closed-cash envelopes without
rewriting unrelated raw payloads, old receipts or financial rows. Warmup pruning excludes
all typed cash receipt owners so immutable source evidence survives maintenance. Downgrade refuses remaining
brokerage-origin rows; application rollback must release owned records first.

Extend the exact reviewed successor registration with 0125 and pin those existing-install
upgrades to `0125_brokerage_cash_origin`. Older 0118/0119 maintenance remains separately deferred,
unknown successors fail closed, and fresh baseline installation follows the normal chain. This
supersedes only ADR-188's pinned 0124 target; its accounting-role, historical receipt and approval
contracts remain unchanged.

Persist queued session mode, policy and matching funding confirmation with source/account routing
and exact batch identities. Source changes invalidate preview and clear stale confirmation.
Remount retains the bounded mode and needs fresh review. Older or invalid checkpoints use existing
full-history/automatic defaults; the settings checkpoint stores no financial source payload.

## Consequences

Cash history is retained without inflating ordinary flows, hiding quoted fee spending or changing
holdings. Closure, origin ownership and immutable component images make the scope deliberately
bounded. A wrong or changed source cannot be solved by selecting a convenient subset. Recovery
must account for both components of a fee-bearing source event, while the schema extends an
existing origin CHECK rather than adding another ledger or inferred bank counterpart.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/188-proved-in-kind-income-recognition|Income recognition and reviewed migration target]]
- [[docs/adr/083-internal-transfer-detection|Ordinary paired transfers]]
- [[docs/features/portfolio-import|Reviewed import workflow]]
- [[docs/features/transfers|Transfer classification]]
- [[docs/api/portfolio-imports|Cash scope API]]
- [[docs/reference/data-model|Data model]]
- [[docs/guides/migrations|Schema application and rollback]]
