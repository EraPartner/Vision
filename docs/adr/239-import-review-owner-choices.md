---
title: "ADR-239: Import review owner choices"
type: adr
status: accepted
date: 2026-10-21
tags:
  [
    adr,
    portfolio-import,
    imports,
    reconciliation,
    saxo,
    ibkr,
    deduplication,
    number-format,
    bug-sweep,
    adr-236,
  ]
description: "Accepted on 2026-10-21 after the 2026-10-21 bug sweep. Saxo CSV cash rows pair with the workbook on the literal Bk Record Id and by cash direction; nearby history candidates are limited to the row's own account and never carry a different source id of the same export, so regular same-size purchases import; remaining look-alikes get per-row owner choices (row_choices: keep_both or same_transaction); previews report rows already in the ledger as duplicates and commit counts are disjoint; Saxo and IBKR numbers are read in the export's own convention, and trades whose units x price x rate miss the booked amount stage as unsupported rows for review."
aliases: [adr-239, row choices, keep both, import number conventions]
related_code:
  [
    "apps/node-backend/src/services/portfolioImportCrossFormat.ts",
    "apps/node-backend/src/services/portfolioImportReconciliationService.ts",
    "apps/node-backend/src/repositories/portfolioImportReconciliationRepository.ts",
    "apps/node-backend/src/services/portfolioImportCommitService.ts",
    "apps/node-backend/src/routes/portfolioImportRoutes.ts",
    "apps/node-backend/src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.ts",
    "apps/node-backend/src/services/portfolioImportPipeline/ibkrTransactionHistoryAdapter.ts",
    "apps/node-backend/src/repositories/importBatchRepository.ts",
    "apps/node-backend/src/services/importBatchService.ts",
    "apps/frontend/src/pages/portfolio/PortfolioImportSession.tsx",
    "apps/frontend/src/lib/api/portfolioImports.ts",
    "apps/frontend/src/pages/ImportReviewPage.tsx",
  ]
---

# ADR-239: Import review owner choices

## Status

Accepted on 2026-10-21. Amends [[docs/adr/236-simplify-portfolio-import-reconciliation|ADR-236]]
and its 2026-10-21 cross-export amendment.

## Date

2026-10-21

## Context

The 2026-10-21 bug sweep found four import faults:

- A Saxo CSV deposit or withdrawal without a `Bk Record Id` was counted twice after the XLSX of the
  same events. The CSV fell back to its `Booking Id` as identity, which never equals the
  workbook's record id, and cash rows have no portfolio type, so the near-match block never fired.
- A new trade of the same size within seven days of an earlier one, in any account, blocked with
  `existing_assigned_or_imported_history` and no way through. Monthly plans could not import.
- `1,500` in a Saxo action or an IBKR `Quantity` was read as 1.5.
- Previews disagreed with commit: cash rows already in the ledger previewed as `cash`, an adopted
  row counted as both adopted and duplicate, and the bank review showed no duplicate flags.

The ADR-236 rule stands: imports never double count, legitimate rows still import, and ambiguity
is surfaced for the owner instead of being settled by a score.

## Decision

- **Saxo cross-format identity.** Only the CSV's literal `Bk Record Id` pairs a Saxo CSV row with
  the workbook; `Transactie-ID` and `Booking Id` stay the row's own repeat-import identity. Cash
  rows without that id meet the existing `cross_format_identity_missing` block by direction
  (deposit or withdrawal), date, account and amount, and the existing statement policy resolves it.
- **Candidates.** A nearby history candidate is unassigned or on the row's own account. An
  imported candidate whose recorded source id of the same export format differs from the row's is
  a different event and is no candidate.
- **Owner choices.** Preview and commit accept `row_choices`: `keep_both` records the row as a new
  transaction; `same_transaction` (single candidate only) settles it as a duplicate. Plans echo the
  applied `rowChoices`. The portfolio import session offers **Keep both** and **Same transaction**
  on those blockers.
- **Truthful counts.** A cash row whose identity the ledger already holds previews as `duplicate`
  with `cash: true`. Reconciliation commit counts `imported`, `duplicates` and `adopted` disjointly;
  the legacy single-batch commit keeps counting adopted rows among its duplicates. The bank import
  preview flags rows whose import identity the ledger holds (`already_imported`).
- **Number conventions.** IBKR numbers use a decimal point with comma thousands. A Saxo CSV uses
  the separator its unambiguous cells prove; a cell that still reads two ways stages as an
  unsupported row. Workbook actions use the separator that matches the typed execution. A trade
  whose units × price (× multiplier) × rate misses its booked or gross amount beyond tolerance
  stages as an unsupported row for review.

Fuzzy auto-resolution (a similarity score, or the earliest candidate wins) was rejected: it either
double counts or drops a real purchase without telling the owner.

## Consequences

- **Breaking for direct HTTP callers.** Reconciliation commit `duplicates` no longer includes
  adopted rows. The app is updated.
- Regular same-size purchases import without owner action. A look-alike on the same account
  without a distinguishing source id still blocks, now with a way through.
- Rows with numbers that the file cannot settle, or trades whose numbers disagree with their
  booked amount, need the owner to fix and re-export or skip them; they no longer import wrong.
- Bank preview flags cover fingerprinted ledger rows only; pre-fingerprint rows that commit matches
  by fields are not flagged.
- Other adapters (Kinesis, Nexo, bank adapters) still use the heuristic amount parser.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/236-simplify-portfolio-import-reconciliation|ADR-236]]
- [[docs/features/portfolio-import|Portfolio Import]]
- [[docs/api/portfolio-imports|Portfolio import API]]
- [[docs/api/imports|Import API]]
