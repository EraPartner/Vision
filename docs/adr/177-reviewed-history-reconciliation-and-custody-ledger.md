---
title: ADR-177 Reviewed history reconciliation and dated custody ledger
type: adr
status: accepted
date: 2026-10-04
updated: 2026-10-04
tags: [adr, portfolio, import, reconciliation, custody, cost-basis, fx, migration-0120, migration-0121, migration-0122, migration-0123]
description: Preserve existing history with immutable reconciliation receipts, commit reviewed scope atomically, carry original lots through custody and unit adjustments, and bound secondary XML staging evidence.
aliases: [reviewed portfolio reconciliation, dated custody ledger]
---

# ADR-177: Reviewed history reconciliation and dated custody ledger

## Status

Accepted for implementation. Supersedes the use of whole-lot re-tagging as a representation of dated
partial custody history in [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]]. The broker
partition model, assignment correction, and absence of synthetic trade cash legs remain applicable.
This decision does not certify complete source exports or successful imports in a real installation.

## Date

2026-10-04

## Context

Importing a statement into a portfolio that already contains real individual transactions must not
create another copy of the same trades. Fingerprints safely identify known source reimports but do
not adopt unassigned manual history. A proximity guard can block duplication, yet cannot produce a
reviewable before/after correction or restore it safely.

A custody withdrawal can move only part of an acquisition, occur after earlier sales, and consume a
fee in the asset itself. Re-tagging every historical lot rewrites historical custody. Recording a
sale invents proceeds and realized trade history. Incoming wallet valuations also do not establish
original acquisition basis. Source order timestamps may describe aggregate orders rather than
execution dates, so parsing cannot fill that evidentiary gap.

## Decision

### Review the complete selected scope

`PortfolioImportSession` stages up to 100 maintained CSV/Saxo XLSX statements with automatic source
and unique-account detection. Staging writes source provenance only. Preview combines source
fingerprints, one-to-one existing-history candidates, explicit global/per-batch adoption policies,
companion-Pro evidence, and projected custody history. Missing basis, counterpart accounts,
ambiguous matches, incomplete staging, or proposed corrections with unproven currency economics
block commit.

Exact unique legacy matches use automatic `exact` adoption. Financial differences require
`preserve_existing` or `prefer_source`. The latter can correct only supported source-equivalent
fields, preserving transaction type and notes. No policy invents an exchange rate or missing trade.
A SHA-256 plan fingerprint pins the reviewed state and policies. Explicit-policy commit requires
it; a changed state rejects as stale.

The reviewed scope locks batches and accounts in ID order, then serializes portfolio transaction
and custody writers. New events commit by date, batch ID, and staging row order. The outer
transaction includes adoptions, receipts, trades, cash, custody events, unit adjustments, staging
states, and counters.
A runtime row error rolls back the scope. Generic imports keep their earlier partial behavior.

### Preserve original transactions with receipts

Migration 0120 adds `portfolio_import_reconciliation_journal`. Adoption keeps the existing ID and
notes, sets the broker account and source metadata, and retains `import_batch_id=null`. Its staging
source becomes a duplicate rather than a new financial row. Immutable before/after object snapshots
retain decimal strings and the original provenance/metadata. A restoration appends a second receipt
with swapped images. A compare-and-set check prevents overwriting a trade changed since adoption.
Receipts protect their source batch/staging records from pruning. They are domain receipts, not an
independently anchored audit chain.

### Repair a prior imported duplicate explicitly

A source fingerprint can identify a prior imported copy while one unique nearby unassigned,
unstamped manual candidate remains. Repair requires an explicit reviewed `preserve_existing` or
`prefer_source` policy; automatic review blocks. The imported copy must be unchanged, at the same
investment/account, and linked by exactly one committed fingerprinted pointer to a complete old
import batch with a positive imported count. Changed notes or recurrence metadata cannot be
silently discarded. Ambiguous candidates or missing provenance block.

Migration 0122 adds `portfolio_import_duplicate_repair_journal` with full before/after snapshots of
both financial rows, original staging, and old batch/counters. Commit retains/adopts the manual ID
and notes, removes the exact imported copy, clears its old staging pointer, and moves one old
imported count to duplicate. Referenced old batches join the sorted lock scope and retention guard.
Rollback validates all after-images and projected remaining history first, then restores the removed
copy's original ID/timestamps, manual financial/provenance values, pointers/statuses, and counters.
A changed image returns `duplicate_repair_changed`. Restore appends an inverse receipt rather than
editing the repair. Only automatic retained-row/staging `updated_at` is normalized in the inverse
receipt constraint; application equality checks remain strict.

Source-proven Saxo/IBKR gross dividends can correct net amounts with separate withholding and the
existing gross amount convention. Literal Nexo Pro evidence can expand the nearby date window to
31 days only for exact executed price, exact units or a proven base-fee difference, and equivalent
cash economics. Raw evidence also binds the staged date, explicit quote fee, and zero tax.
Both corrections remain explicit and ambiguity-blocked; order timestamp evidence
does not independently certify an execution date.

### Replay dated partial custody

Migration 0121 adds `portfolio_asset_transfers` and staging `asset_transfer_details`. Each transfer
stores an investment, distinct source/destination accounts, calendar date, gross units, asset fee,
and source identity. IDs share the trade sequence for deterministic same-day ordering. Nexo top-ups
use an explicit origin; Nexo/Kinesis withdrawals use an explicit destination. Unknown origins or
original basis remain blockers.

Shared custody replay carries remaining purchase lots through temporary transfer legs under FIFO,
LIFO, and weighted average. It preserves acquisition IDs/dates, native basis, and original purchase
FX. The source loses gross units; the destination receives gross minus fee units. Per-method fee
basis allocations explain the lots consumed by fees. Transfers create no sale, proceeds, income,
or cash leg. Missing original FX remains unresolved. Summaries and snapshots replay these canonical
events rather than resetting cost at the transfer date.

Writes and rollback validate the full projected custody and account unit history. An edit or
assignment correction cannot orphan a later custody event or create/worsen a partition oversell.
Ledger updates are forbidden; validated import rollback is the removal path.

### Keep yield reversals and asset fees distinct

Migration 0123 adds `portfolio_asset_adjustments`, `portfolio_asset_adjustment_sources`, and nullable
staging `asset_adjustment_details`. The `asset_adjustment` route has no financial transaction type.
A positive removed-unit event is either `yield_reversal`/`zero_yield_only` or `asset_fee`/`carried`.
It shares the trade ID sequence and history locks, creates no sale or cash, and counts as imported
when newly written. Preview exposes the adjustment kind and its separate summary count.

Kinesis zero-yield interpretation is explicit, never a default inferred from a small value.
`yield_basis_policy='zero'` retains exported income while marking yielded gifted units as
source-proven zero basis. A consistent negative holder adjustment can consume only those remaining
eligible lots. Retained actual source columns are required for later literal-record reparsing.
Purchased units cannot satisfy a yield reversal. An asset fee instead consumes original basis.
Each method stores acquisition IDs/dates, hashes, units, native basis/currency, and original-FX EUR
basis. Missing original FX remains unresolved.

Ledger UPDATE is forbidden. Evidence-link UPDATE and direct DELETE are forbidden; parent rollback
can cascade links after projected-history validation. Restrictive source links pin the original
yield evidence in older batches. Both tables are retained by pruning rules and covered by backup.

### Apply secondary XML evidence to staging

One optional original Portfolio Performance XML is accepted through a separate 10 MiB UTF-8
boundary. Document type and entity declarations are forbidden; depth, node, text, and reference
limits bound the object graph. Literal asset/units/date/currency/wallet context and consistent
paired facts must resolve. Primary broker execution facts control source economics; recorded
secondary native basis and explicit zero-placeholder policy can resolve supported missing basis.
Unknown origins, unsupported currency/basis, ambiguous anchors, and coverage gaps remain blockers.
No reference request writes canonical financial rows or certifies complete history.

A terminal IBKR import is reviewed only when explicitly selected and its retained source is
complete. The service creates a fresh managed review clone and returns its relation to the original,
full effective scope, supplemental metadata, blockers, and optional coverage diagnostics. The old
canonical import stays unchanged, avoiding rollback of unrelated history. Same XML/scope/routing
retries return the same managed result. Changed XML/scope requires fresh primary staging and a new
managed clone; account routing changes conflict. Frontend scope and policy changes discard the old
managed review, preserve explicit original selection, and require a new preview/fingerprint.

### Respect source limits

Nexo wallet/Pro movements can become account-internal annotations only with a usable companion Pro
trade history. That is a structural dependency check, not proof of complete executions. The Pro
adapter uses filled units, executed prices, explicit base/quote fees, literal ordered headers, and
raw records. Its calendar date preserves the exported order timestamp prefix. It does not certify
that timestamp as an execution date or expand an aggregate order into individual fills. Crypto
quotes, third-asset fees, and unknown lifecycle events remain unsupported.

## Migration blast radius and recovery

| Migration | Upgrade effect | Guarded downgrade |
| --------- | -------------- | ----------------- |
| [[alembic/versions/0120_portfolio_import_reconciliation.py|0120]] | Empty immutable journal and source-retention FKs; no financial rewrite | Refuses active adoptions. Restore through application rollback first; then journal removal loses receipts but leaves restored trades unchanged |
| [[alembic/versions/0121_portfolio_asset_transfers.py|0121]] | Empty custody ledger, nullable staging metadata, expanded route check; no holding rewrite | Refuses a populated ledger. Roll back dependent custody imports first; then drops ledger/metadata and marks retained new-route staging rows as errors |
| [[alembic/versions/0122_portfolio_import_duplicate_repair.py|0122]] | Empty immutable dual-row repair journal and retention FKs; no financial rewrite | Refuses active repairs. Restore via application rollback first; journal removal loses receipts but retains restored history |
| [[alembic/versions/0123_portfolio_asset_adjustments.py|0123]] | Empty adjustment/evidence tables, nullable staging metadata, expanded route check; no holding rewrite | Refuses populated adjustments. Validated application rollback removes events/evidence first; empty downgrade drops metadata and marks retained adjustment staging as errors |

Use the approved maintenance and backup procedure in [[docs/guides/migrations]]. A migration
upgrade/downgrade check in a disposable database does not authorize changes to user data. All new
receipt, custody, adjustment, and adjustment-source tables are backup-covered. Downgrade must proceed in reverse migration order, after dependent
history has been rolled back through the application. If later edits or transfers prevent a safe
rollback, retain the schema/history and resolve that dependency rather than bypassing its guard.

## Validation boundary

Synthetic adapter and session tests cover source detection, filled-order economics, policy review,
and stale/unknown outcomes. PostgreSQL tests cover adoption/restoration snapshots, projected custody
and oversell conflicts, atomic failure, and immutable migration guards. Relevant suites include
[[apps/node-backend/tests/portfolioImportReconciliation.db.test.js]],
[[apps/node-backend/tests/portfolioImportReconciliationMigration.db.test.js]],
[[apps/node-backend/tests/portfolioImportDuplicateRepairMigration.db.test.js]],
[[apps/node-backend/tests/portfolioAssetTransfer.db.test.js]], and
[[apps/node-backend/tests/portfolioAssetTransferReplay.test.js]],
[[apps/node-backend/tests/portfolioAssetAdjustment.db.test.js]],
[[apps/node-backend/tests/portfolioAssetAdjustmentReplay.test.js]], and
[[apps/node-backend/tests/portfolioPerformanceXmlParser.test.js]]. Current implementation verification
must report those results separately from schema application and real native-app import acceptance.

## Consequences

- Existing real transactions keep their IDs and notes while source provenance becomes reviewable.
- Custody history can change over time without double-counting assets or inventing a sale.
- Broader writer locks serialize short history mutations and prevent preview/commit races.
- Source-retention FKs keep referenced provenance beyond the ordinary terminal-batch sweep.
- Exactness, source gaps, timestamp meaning, missing FX/basis, and native acceptance remain separate
  evidence questions. Adapter and disposable database tests alone do not prove a real import.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/portfolio-import|Portfolio Import]]
- [[docs/api/portfolio-imports|Portfolio Imports API]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/architecture/backend-architecture|Backend Architecture]]
- [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]]
- [[docs/adr/134-versioned-import-identity-and-exact-provenance|ADR-134]]
- [[docs/adr/074-fx-attribution-historical-rates|ADR-074]]
