---
title: "ADR-188: Proved in-kind income recognition"
type: adr
status: accepted
date: 2026-10-08
tags: [adr, portfolio, imports, accounting, receipts, migration]
description: Retain literal income already represented by acquired units separately from ordinary income and gains, with proved source pairs and guarded rollback.
---

# ADR-188: Proved in-kind income recognition

## Status

Accepted. Migration `0124_portfolio_income_recognition` is authored for isolated verification.
Applying it to user data requires explicit approval; this note does not authorize deployment.

## Date

2026-10-07

## Context

A Kinesis metal distribution exports both literal income and acquired units. Existing zero-basis
unit acquisitions already represent that value in realized or unrealized gain. Recording the
paired amount as ordinary dividend income would count the value twice. Omitting that source row
would lose income history. The accounting distinction must remain visible after sale, archive,
reporting, rollback and repeat imports, without inferring tax treatment.

## Decision

Add read-only `portfolio_transactions.income_recognition_role`, default `standard`.
`included_in_units` is permitted only on a dividend. Keep its literal amount, currency, date and
source identity. Exclude that amount from ordinary `totalDividends`, `totalIncome` and gains; expose
separate `totalInKindIncome` in the same reporting currency. The additive
`archivedInKindIncome` projection converts each archived literal income currency on its transaction
date without changing archived ordinary gain or basis. A missing foreign dated subtotal stays
unavailable; the frontend never treats a foreign income amount as investment-native money.
Units, valuation, cost basis and sale
proceeds continue to come from existing acquisition history. Ordinary transactions keep their
current behavior. Older response fields and snapshot role absence mean `standard`.

Provide the optional `record_in_kind_income_only` reconciliation scope with explicit
`preserve_existing`, zero yield basis and the complete original unfiltered Kinesis source. The
server classifies the whole source before selecting literal income paired one-to-one with an
already-proved existing zero-basis acquisition. It revalidates full primary source, provider event,
asset, account, date, occurrence and immutable current acquisition proof. Literal paired income
has a positive raw value rounded without invention at canonical precision (which can be zero),
no units or unit price, zero fees/taxes and unstamped source FX. No new XML is needed; previously
retained correction/group reference context remains bound to the source. Preview and locked commit
warm the normal historical currency cache and require usable stored rates within seven days for
income dates that need conversion. The fingerprint binds this evidence; missing dates defer, and
current rates do not authorize recording. Source FX remains null.
This scope creates income records only. It does not insert acquisitions, change existing financial
records, repair duplicates, drain cash/custody/adjustments or settle other pending events.

Preview uses `record_income` with typed `incomeProof` identifying the paired unit transaction.
Private full source and after-image evidence remain bound by the reviewed fingerprint. Commit
reports `recordedIncome` equal to newly `imported` income rows; both are zero on a settled retry.
Partial commits retain source batches and any reference checkpoint for later review. The scope
adds no caller-selectable row IDs.

Retain immutable `record`/`restore` receipts in
`portfolio_import_income_recognition_journal`. Each receipt binds income and unit after-images,
both staging identities and private source proof. Active pairs prevent changes or deletion of
either canonical image. Batch rollback first validates both images, appends inverse evidence and
removes only owned income records before any dependent acquisition restoration. Changed images
block rollback atomically. Canonical numeric IDs are retained without permanent financial foreign
keys, while batch/staging and previous-receipt relationships restrict pruning.

Keep standard role absent from normalized immutable snapshots. Existing receipts remain unchanged;
absence is interpreted as standard when comparing them. Downgrade refuses any included income or
active pair. Only after guarded application rollback releases those dependencies may downgrade
remove the new column, triggers and restored journal evidence. No existing financial history is
inferred, reclassified or receipt-rewritten by migration.

The role is an accounting statement, not a legal tax classification. Ordinary dividend estimates,
AI income totals and dividend report totals exclude these rows. Transaction history and portfolio
breakdown retain the literal amount and role; tax reporting shows a separate unclassified subtotal.
Explicit source tax facts remain recorded facts. Public create/update bodies reject role writes,
even `standard`; readers validate the two-value role and default absent older responses.

## Consequences

Income history can be complete without increasing holdings or gain twice. The proof is deliberately
bounded: missing, ambiguous, changed or unsettled paired acquisition evidence leaves income pending
or blocks the reviewed scope rather than authorizing another acquisition. Legacy arithmetic and
ordinary manual entry remain unchanged. The added journal and active-pair guards create a recovery
ordering requirement; operators must roll back paired income before changing its acquisition.

## Addendum: existing-install migration registration (2026-10-07)

The guarded runner explicitly registers the exact current revision identifiers for 0120 portfolio
reconciliation, 0121 asset transfers, 0122 duplicate repair, 0123 asset adjustments and 0124 income
recognition. For these existing profiles, ordinary startup/`db:upgrade` advances only to pinned
`0124_portfolio_income_recognition`, without replaying the deferred 0119 maintenance bridge. A
stale head cache cannot skip the extension; later boots at 0124 do not request 0118.

The extension preserves existing financial values, retained legacy objects and old receipt JSON,
adds the default `standard` role and starts an empty journal. Unknown or unregistered successors
refuse automatic upgrade without changing the marker or domain history. Fresh baseline installation
still follows the normal chain. Older 0118 bridge/conversion requirements and the explicit approval
gate for applying this change to user data remain unchanged. See [[docs/guides/migrations]] and
[[docs/guides/native-macos-runtime]].

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/073-shared-portfolio-math-package|Shared portfolio math]]
- [[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|Reviewed reconciliation and custody]]
- [[docs/features/portfolio-import|Portfolio import workflow]]
- [[docs/features/portfolio|Portfolio calculations and display]]
- [[docs/api/portfolio-imports|Reconciliation API]]
- [[docs/api/portfolio-summary|Summary API]]
- [[docs/reference/data-model|Data model]]
- [[docs/features/belgian-tax|Tax overview]]
