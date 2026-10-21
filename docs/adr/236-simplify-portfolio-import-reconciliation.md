---
title: "ADR-236: Simplify portfolio import reconciliation"
type: adr
status: accepted
date: 2026-10-21
tags:
  [
    adr,
    portfolio-import,
    reconciliation,
    kinesis,
    ibkr,
    saxo,
    cash,
    in-kind-income,
    migration,
    adr-177,
    adr-188,
    adr-189,
  ]
description: "Accepted on 2026-10-20 by Tor after confirming that his Kinesis, IBKR and Saxo history is fully reconciled. Vision removes the bounded reconciliation scopes, the Kinesis, IBKR, Saxo and Portfolio Performance proof frameworks, plan fingerprints and the trigger-enforced receipt immutability. Kinesis and IBKR cash become ordinary brokerage cash. The in-kind income role and its reporting exclusion, undo of applied adoptions and every journal table stay. Migration 0005 drops seven receipt triggers and their functions. This is a breaking API change. The 2026-10-21 amendment restores the IBKR funding workbook (.xls/.xlsx) and lets Saxo CSV and XLSX, and the IBKR CSV and funding workbook, be imported in any order without double counting, through pairing in the reconciliation plan rather than proofs."
aliases: [adr-236, simplify reconciliation, remove reconciliation scopes]
related_code:
  [
    "db/migrations/0005_simplify_portfolio_reconciliation.sql",
    "db/migrations/0005_simplify_portfolio_reconciliation.down.sql",
    "apps/node-backend/src/services/portfolioImportReconciliationService.ts",
    "apps/node-backend/src/services/portfolioImportCrossFormat.ts",
    "apps/node-backend/src/services/portfolioImportPipeline/ibkrFundingHistoryAdapter.ts",
    "apps/node-backend/src/services/portfolioImportCommitService.ts",
    "apps/node-backend/src/services/portfolioImportLegacyReceipts.ts",
    "apps/node-backend/src/services/portfolioImportPipeline/commit.ts",
    "apps/node-backend/src/services/portfolioImportPipeline/kinesisInKindIncome.ts",
    "apps/node-backend/src/repositories/portfolioIncomeRecognitionRepository.ts",
    "apps/frontend/src/pages/portfolio/PortfolioImportSession.tsx",
    "apps/frontend/src/lib/api/portfolioImports.ts",
  ]
---

# ADR-236: Simplify portfolio import reconciliation

## Status

Accepted on 2026-10-20 (decision by Tor). It supersedes parts of
[[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|ADR-177]] (plan fingerprints,
the bounded adoption and correction scopes, duplicate repair and trigger-enforced receipt
immutability), [[docs/adr/188-proved-in-kind-income-recognition|ADR-188]] (paired income proofs,
the income-only scope and its receipts) and
[[docs/adr/189-proved-brokerage-cash-history|ADR-189]] (the cash-only scope, funding confirmation
and the closed-cash proof). The `included_in_units` income role of ADR-188 and its exclusion from
income totals stay in force, as do the reviewed adoption receipts and the custody ledger of
ADR-177.

Migration numbering: another open change takes migration 0004 and ADR-231. This change uses 0005.

## Date

2026-10-20

## Context

ADRs 177, 188 and 189 added proof machinery so that Kinesis, IBKR and Saxo history could be
reconciled with manually entered history without double counting: four bounded Kinesis scopes
(adopt, correct, record in-kind income, record cash), Kinesis network and yield-group proofs, IBKR
primary-proof, cash-reconciliation and duplicate-repair frameworks fed by a native funding
workbook, Portfolio Performance reference evidence, Saxo companion proofs, a SHA-256 plan
fingerprint that pinned a commit to its preview, and database triggers that made every receipt
immutable. Kinesis fiat cash could only be imported through the cash-only scope.

That history is now fully reconciled. The machinery made every new import slower to review and
hard to change, and it was the only reason for most of the receipt triggers.

## Decision

Simplify fully.

- **Scopes and proofs.** The bounded scopes, NetworkProof, YieldGroups, AdoptionScope and the
  correction-scope proofs are removed, as are the IBKR primary-proof, cash-reconciliation and
  repair-candidate frameworks, Portfolio Performance reference evidence and Saxo companion
  proofs. Every review is a full-history review.
- **Fingerprints.** Preview no longer returns `planFingerprint` and commit no longer takes
  `expected_plan_fingerprint`. Commit locks the selected batches and their accounts and rebuilds
  the plan from current history. An existing transaction that changed or vanished since planning
  is a conflict (`stale_existing_transaction`).
- **Kinesis cash.** The `cash_reconciliation_required` gate is gone. Fiat deposits, withdrawals,
  card payments and trade cash legs are ordinary signed brokerage cash, as for the other brokers.
  The amount is the literal balance movement, so a quoted fee is part of the one cash row and the
  sleeve closes at the statement balance.
- **IBKR cash.** The native funding workbook format (`ibkr_funding_history`, `.xls`) is removed.
  Transaction History deposits and withdrawals are recorded as ordinary cash in the statement base
  currency.
- **Native wallet receipts.** The `native_receipts` detection and preset are removed; the generic
  adapter rejects `asset_fee` and `asset_transfer_witness` rows.
- **In-kind income.** A zero yield-basis Kinesis distribution still stages a `:income` dividend and
  a `:units` gift. The commit inserts the dividend directly with `income_recognition_role =
  'included_in_units'`, its literal amount, zero fees and taxes and no units, price or rate, and
  inserts the gift as an ordinary zero-basis acquisition. A dividend without its gift in the same
  batch fails the commit (`paired_income_units_missing`). Reported income figures do not change.
- **Duplicates.** A repeated source identity is a duplicate. A nearby manual twin is left to the
  owner instead of being repaired.
- **Receipts.** Migration `0005_simplify_portfolio_reconciliation` drops seven receipt triggers
  and their functions. No table, column or row is dropped. The application is the only writer of
  the journals; it inserts receipts and never updates them, and rollback checks that an adopted
  transaction still matches its after-image (`adopted_transaction_changed`) before restoring it.
  The `portfolio_income_active_pair_guard` trigger stays and protects pairs recorded before this
  decision.
- **Undo.** Rollback of a batch still restores adoptions, paired income, IBKR cash corrections and
  duplicate repairs that were applied before this decision.
- **API.** `reconciliation_scope`, `cash_funding_policy` and `expected_plan_fingerprint` are
  rejected with 400. Plans lose `planFingerprint`, `selectedRowIds`, `pending`, `complete`,
  `deferredCounts`, `batchProgress` and the proof fields; commit results lose `repaired`,
  `recordedIncome` and `recordedCash`. This is a breaking API change.

## Consequences

- One review flow for every broker. The session page has no scope selector, cash confirmation or
  existing-batch picker.
- IBKR funding keeps only the base-currency amount; the original currency of a deposit is not
  preserved.
- An in-kind dividend imported after 0005 has no pair guard. Deleting its gift by hand leaves the
  dividend excluded from income until the batch is rolled back.
- Readiness no longer exempts Saxo companion rows.
- Rolling back 0005 recreates the triggers. Triggers do not re-check existing rows, but a later
  write to in-kind income imported after 0005 fails the recreated pair check until its batch is
  rolled back.
- Kysely's migrator rejects out-of-order migrations by default, so a database migrated to 0005
  before 0004 exists will refuse to apply 0004 later. Land 0004 first, or migrate only after both
  are present.

## Amendment: cross-export imports (2026-10-21)

Decision by Tor, before this ADR merged: "i want to be able to import the xlsx since you can't
download the csv directly. it shouldn't double count though... I want to be able to import that
though for IBKR as well. I want as much flexibility as possible for importing without the app
breaking or incorrectly importing".

IBKR offers its Transaction Status & History funding list only as an Excel workbook, and a Saxo
history is often available as both CSV and XLSX. Removing the funding format and the companion
handling left two gaps: IBKR deposits lost their own currency, and importing both Saxo exports
either blocked (CSV dividends) or recorded a trade twice (the CSV and XLSX trade fingerprints
differ, because one books instrument currency and the other account currency).

The amendment restores the inputs without restoring the proof frameworks:

- **IBKR funding workbook.** `ibkr_funding_history` is accepted again as `.xls` or `.xlsx`. It
  records each completed deposit and withdrawal as brokerage cash in its own currency; open,
  rejected and cancelled requests are skipped, any funding method is accepted, and masked
  account IDs are kept. SheetJS `xlsx` returns as a dependency because `read-excel-file`, which
  stays for Saxo, cannot read BIFF `.xls`. Changing Saxo's reader would change its stored
  `raw_data` envelope, so the two readers stay.
- **Pairing in the plan.** `portfolioImportCrossFormat.ts` runs inside the reconciliation plan
  and pairs rows that another export of the same history records. A Saxo CSV row pairs with its
  workbook twin by account, source account and `Bk Record Id`, and the facts must agree. An IBKR
  CSV movement pairs with its funding row by type, account, a date within the request–completion
  window and native amount × CSV rate = base amount (within 0.01 or 0.01 %). Twins in one review
  settle as `duplicate_source`; a twin already in the ledger makes the row a `duplicate`; a
  funding row that follows the CSV corrects the CSV's cash transaction to its own amount and
  currency in place. A cash row also adopts a manual entry (no import fingerprint) with the same
  account, currency and signed amount within seven days; a different date needs a policy.
- **Safety.** Indistinguishable candidates pair by count; anything that cannot pair one to one
  blocks (`ambiguous_funding_history`, `ambiguous_cash_history`), and disagreeing twins or a CSV
  deposit edited after import block with `cross_format_source_conflict`. Nothing is dropped: an
  unpaired row imports normally or blocks with a reason. Commit applies these settlements before
  the readiness check and re-reads each cash transaction under lock, so a change since planning is
  `stale_existing_transaction`. The ordinary fingerprint dedup still makes every repeat a no-op.
- **Undo.** Cash adoptions and corrections write the existing cash reconciliation journal
  (`ibkr_native_funding` or `cash_adoption` proofs) and roll back with their batch. A CSV batch
  cannot be rolled back while a funding correction depends on its transaction.
- **Not restored.** No plan fingerprint, bounded scope, receipt-immutability trigger or proof
  framework returns: the pairing is recomputed under the commit's locks, which already guards
  against a stale preview. `native_receipts` stays removed.

Consequences of the amendment: the "IBKR funding keeps only the base-currency amount" and
"Readiness no longer exempts Saxo companion rows" consequences above no longer hold once the
funding workbook or the Saxo XLSX is imported; a Saxo CSV imported alone still blocks on its
net-only dividends. The API change is additive. Real-PostgreSQL coverage is in
`apps/node-backend/tests/portfolioCrossFormatImport.db.test.ts`.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/portfolio-import|Portfolio import]]
- [[docs/api/portfolio-imports|Portfolio imports API]]
- [[docs/reference/api-endpoint-matrix|API endpoint matrix]]
