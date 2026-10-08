---
title: Feature - Portfolio Import
type: feature
status: active
date: 2026-10-08
updated: 2026-10-08
last_modified: 2026-10-08
tags:
  [
    feature,
    portfolio,
    import,
    csv,
    xlsx,
    brokerage,
    trades,
    portfolio-import,
    instrument-matching,
    review,
    type-normalizer,
    deduplication,
    fx,
    adr-078,
    adr-074,
    adr-066,
    migration-0040,
    migration-0041,
    migration-0057,
    account-id,
    adr-091,
  ]
aliases: [portfolio-import, portfolio-csv-import, brokerage-import]
description: Multi-statement portfolio history import with automatic detection, reviewed reconciliation, dated custody and unit adjustments, immutable receipts, and retained historical source evidence.
related_code:
  - "apps/node-backend/src/services/portfolioImportPipeline/index.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/stage.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/validate.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/matchInvestments.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/commit.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/portfolioGenericAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/ibkrTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioIbkrPrimaryProof.ts"
  - "apps/node-backend/src/services/portfolioIbkrRepairCandidates.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/kinesisTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/nexoTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/nexoProTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportReconciliationService.ts"
  - "apps/node-backend/src/services/portfolioKinesisYieldGroups.ts"
  - "apps/node-backend/src/services/portfolioKinesisAdoptionScope.ts"
  - "apps/node-backend/src/services/portfolioImportDuplicateRepairService.ts"
  - "apps/node-backend/src/repositories/portfolioImportDuplicateRepairRepository.ts"
  - "apps/node-backend/src/services/portfolio/portfolioAssetTransferService.ts"
  - "apps/node-backend/src/services/portfolio/portfolioCustodyImportScope.ts"
  - "packages/shared-utils/src/portfolioCustody.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/portfolioTypeNormalizer.ts"
  - "apps/node-backend/src/services/importIdentity.ts"
  - "apps/node-backend/src/services/portfolioImportBatchService.ts"
  - "apps/node-backend/src/services/portfolioImportCommitService.ts"
  - "apps/node-backend/src/services/portfolioImportReadinessService.ts"
  - "apps/node-backend/src/repositories/portfolioImportBatchRepository.ts"
  - "apps/node-backend/src/routes/portfolioImportRoutes.ts"
  - "apps/node-backend/src/routes/importBatchRoutes.ts"
  - "apps/node-backend/src/lib/portfolioUpload.ts"
  - "apps/node-backend/src/services/portfolio/fxResolve.ts"
  - "apps/frontend/src/pages/portfolio/PortfolioImportPage.tsx"
  - "apps/frontend/src/pages/portfolio/PortfolioImportSession.tsx"
  - "apps/frontend/src/pages/portfolio/portfolioImportDetection.ts"
  - "apps/frontend/src/pages/portfolio/PortfolioImportReviewPage.tsx"
  - "apps/frontend/src/features/imports/PortfolioCsvColumnMapper.tsx"
  - "apps/frontend/src/features/portfolio/InvestmentCombobox.tsx"
  - "apps/frontend/src/lib/api/portfolioImports.ts"
  - "apps/frontend/src/hooks/usePortfolioParserConfigs.ts"
  - "alembic/versions/0120_portfolio_import_reconciliation.py"
  - "alembic/versions/0121_portfolio_asset_transfers.py"
  - "alembic/versions/0122_portfolio_import_duplicate_repair.py"
  - "alembic/versions/0123_portfolio_asset_adjustments.py"
  - "apps/node-backend/src/services/portfolioPerformanceReferenceEvidence.ts"
  - "apps/node-backend/src/repositories/portfolioAssetAdjustmentRepository.ts"
  - "apps/node-backend/src/services/portfolio/portfolioAssetAdjustmentService.ts"
  - "alembic/versions/0040_add_portfolio_import_staging.py"
  - "alembic/versions/0041_add_parser_config_kind.py"
---

# Feature: Portfolio Import

## Overview

Portfolio Import loads brokerage and exchange history from CSV files and detailed Saxo XLSX
workbooks into portfolio transactions and brokerage cash. It is parallel to the budgeting import
(`/api/import`), with the same stage, validate, match, review, and commit phases. The historical
`/api/portfolio/import/csv/*` endpoint paths accept both supported file types; bank-statement
uploads remain CSV-only.

Key design points:

- **Generic mapping plus maintained presets**: ordinary CSVs use the custom column mapper. The IBKR,
  Kinesis Money, Nexo wallet, Nexo Pro, and Saxo transaction-history presets handle their format-specific framing,
  linked rows, localization, and mixed-currency semantics. Each requires an active broker account.
- **Maintained acceptance targets**: IBKR, Kinesis Money, Nexo wallet, Nexo Pro, and Saxo have format-specific
  adapters and synthetic regression fixtures. Adapter coverage does not prove complete source history. Other brokers may still work through user-defined
  mappings, but are not maintained compatibility targets.
- **Automatic selection**: the upload page detects a maintained source from its header signature
  and chooses a broker account only when the source account or broker uniquely identifies one
  active eligible account. Ambiguous account choices remain explicit.
- **Brokerage review gate**: every maintained preset sets `is_brokerage` and always stops at staged
  review, including exact symbol matches. No preset row reaches the ledger before user confirmation.
  Reviewed commits require complete staging, an unambiguous reconciliation plan, and valid projected
  custody history. Existing source-equivalent trades can be adopted without adding a second trade.
- **Instrument matching**: exact symbol, then explicit price-provider asset alias, then exact name.
  Only one active candidate may resolve a row. No ISIN lookup or fuzzy matching is used.
- **Conservative generic auto-commit**: non-brokerage generic imports commit automatically only when
  there are no name matches, errors, or unresolved rows.
- **Review step for mismatches**: unresolved rows go to `awaiting_review`; the user links each symbol/name to an existing investment or creates a new one.
- **Reuses `portfolioTransactionService.create`**: 2-of-3 unit math, oversell prevention, and asset-class routing shared with manual entry.
- **Saved parser configs**: reuses `custom_parser_configs` table with `kind = 'portfolio'` discriminator (ADR-041 migration 0041) and remembers one optional file-level broker account in the existing JSON config.

Generic mappings also save `number_format`: automatic, decimal point, or decimal comma,
independently of the CSV delimiter. Existing mappings default to automatic. All mapped numeric
columns use it: amount, units, unit price, fees, taxes, and FX rate. Automatic mode rejects
conflicting decimal/grouping interpretations such as `1,234` and `1.234`; the whole file fails
before staging with a data-row and column diagnostic instead of dropping the affected row.
Choose the matching explicit format and retry. Four-decimal precision remains supported.
Maintained broker presets retain their format-specific numeric rules.

Leading rows counts physical lines before the header. The shared decoder accepts UTF-8,
Latin-1/ISO-8859-1 aliases, and Windows-1252; the latter preserves euro and punctuation bytes.
Unsupported encoding values return 400. See [[docs/api/portfolio-imports]].

The header preview and mapping dropdowns use the chosen encoding and physical line offset too;
changing either option refreshes the preview. Failed trade and cash-row inserts roll back and
release their row savepoint before recording the error or continuing with the next row, so a
chunk does not retain failed subtransactions until its final commit.

---

## Pipeline Phases

### 1. Stage

**Module:** [[apps/node-backend/src/services/portfolioImportPipeline/stage.ts]]

Parses an ordinary uploaded CSV using `portfolioGenericAdapter`, which reads `column_mapping` from
the config. The maintained `format` values delegate to IBKR, Kinesis, Nexo wallet, Nexo Pro, or Saxo
transaction-history adapters. Raw rows from every path are stored in `portfolio_import_staging_rows`.
The portfolio upload boundary accepts files up to 50 MiB and inspects their bytes rather than
Multer's extension-free temporary filename. XLSX is supported only with the Saxo format. Its
workbook structure and accounting detail are checked before creating a batch.

Workbook ZIP input is limited to 1,000 entries, 100 MiB of expanded content, and 500,000 parsed
cells. Duplicate or encrypted entries, unsupported archive layouts, invalid expansion sizes, and
non-workbook archives reject. Legacy XLS is unsupported. Parsing does not extract files, execute
macros, evaluate formulas, or follow external links. See [[docs/api/portfolio-imports]].

The IBKR adapter locates the `Transaction History,Header` record instead of treating the statement's
first metadata row as the CSV header. It trims the real column names, reads the Summary base
currency, retains each literal `Transaction History,Data` CSV record in staging `raw_data`, and
applies these format-specific rules:

- `-` symbol, currency, price, quantity, and fee placeholders become missing values.
- Buy/sell units and prices stay in `Price Currency`. The base-currency gross amount is omitted so
  the shared 2-of-3 rule derives `amount = units × price`; base-currency commission is converted
  back with the statement exchange rate. An exported rate is stamped as `fx_rate_to_eur` only for
  an EUR-base statement.
- Dividend, tax, deposit, withdrawal, and adjustment amounts stay in the statement base currency.
  `Foreign Tax Withholding` normalizes to `tax`; signed instrument-less adjustments normalize to a
  deposit or withdrawal. Descriptions remain notes, so a cash-row description cannot masquerade as
  an investment name.
- `Forex Trade Component` rows are skipped and included in `rowsSkipped`. They describe the
  base-currency side of a securities transaction and are not independent portfolio holdings.

Batch configuration retains the literal transaction header, Summary base-currency record, source
file hash, ordered column names and transaction-record hashes as `ibkr_source_context`. Repeated
headers or base-currency records and blank or duplicate trimmed column names reject. A valid
reordered header remains supported. Retained batches without this context cannot supply currency
proof by assuming a historical column layout; a fresh original statement can provide that proof.

Regression coverage uses `tests/fixtures/portfolio/ibkr-transaction-history.csv`, a synthetic file
that preserves the real section framing, exact headers, locale-comma decimals, dash placeholders,
and row kinds without retaining account or transaction data from the supplied export.

The Kinesis adapter validates the real Transactions statement's 18 headers. Kinesis writes the
asset and quote sides of a trade as separate rows with the same `Order_ID`; the adapter collapses
them into one portfolio buy/sell and one real cash-ledger movement. It uses balance deltas for
direction, strips fiat quote codes from instrument matching, converts asset-denominated fees at the
exported trade price, and retains `Transaction_ID` and `HIN` as source and account identity.

Holder and velocity yields are paid in metal, so one source record becomes dividend income plus a
gifted-unit row. Its default basis is the exported value. Explicit `yield_basis_policy='zero'`
instead records those units as source-proven zero-basis yield acquisitions while retaining the
exported income. A negative holder distribution adjustment requires that explicit policy and a
consistent exported amount/balance delta; it removes only remaining eligible zero-basis yield units
through the adjustment ledger. It cannot consume purchased units. Actual `source_columns` remain
in batch configuration so a retained literal record is never reparsed with a guessed column order.
Asset withdrawals use the dated custody ledger:
exported gross units must equal received units plus a fee in the same asset. The transfer debits
the source account and carries the remaining purchase lots to an explicit destination. It creates
no sale, proceeds, income, or cash leg. Asset deposits and positive distribution adjustments have
unresolved original basis; the export's valuation is not invented acquisition cost. They block a
new import unless known original history can be preserved through reviewed reconciliation.
Negative adjustments without proven zero-basis yield policy/history remain review errors. Fiat
deposits, withdrawals, and card payments remain instrument-less cash rows.
Review-time holding creation infers KAU and KAG as `metals`; other Kinesis asset codes use the
preset's `crypto` fallback so mixed statements create the expected asset classes. Kinesis-created
holdings use USD as their valuation currency, including asset-deposit rows that carry no quote
currency.

Full review can select the complete original Kinesis statement together with a complete generic
source receipt CSV. Verified native sender fees use `asset_fee` with carried original basis;
`asset_transfer_witness` retains owned transfer evidence for a unique broker deposit without
creating another movement. A closed group of exactly two distinct incoming native gift receipts,
each bound to literal recorded native basis, can attach one qualified existing manual gift and
insert only the missing gift. This group association does not infer an individual legacy identity.
The existing gift keeps its financial values, date, type, units, note and FX. Strict repeats require
both owned group members and unchanged after-images; incomplete or contested evidence blocks.
This path does not authorize new cash in full history.

Regression coverage uses `tests/fixtures/portfolio/kinesis-transaction-history.csv`, a synthetic
file preserving the real headers, UTC timestamp style, dot-decimal values, paired trade legs,
distributions, fiat rows, noisy currency-code cells, and asset-withdrawal accounting without
retaining the supplied HIN or transaction identifiers.

The Nexo adapter accepts the 11-column Transaction history export. Explicitly rejected records are
skipped. Approved same-fiat wrapper movements, such as EUR to EURX, pair a `Deposit To Exchange`
with `Exchange Deposited On`, or `Exchange To Withdraw` with `Withdraw Exchanged`. A pair must be
unique in both directions, use the same underlying fiat and amounts, and occur on the same UTC
date within 30 minutes. The primary emits one instrument-less deposit or withdrawal, plus a
separate fee when present. Both literal source records remain in its provenance; the companion
increments `rowsSkipped` and creates no second ledger movement. An explicitly approved deposit
with zero output still uses its positive input principal. A withdrawal must reconcile input to
output plus fee. Unpaired, ambiguous, or inconsistent lifecycle rows remain review errors.

Other unambiguous conversions retain the existing portfolio rules.
Cash-like-to-asset conversions become buys, while the reverse direction becomes sells. Conversions
use the exported USD equivalent as amount and unit-price basis; a conversion without one clear
cash-like side remains a review error. A non-zero conversion fee outside USD also remains a review
error rather than being silently discarded. Asset-denominated interest becomes linked income and
gifted-unit rows. Approved fiat interest with equal input/output principal in the same underlying
fiat, positive principal, and zero fee instead creates one instrument-less `Interest` cash row in
that native fiat currency. For example, EURX interest remains EUR cash income. It creates no
acquired portfolio units and does not use the USD equivalent as its amount. Unresolved approval,
principal, or fee evidence remains a blocking review error. An approved fee-free crypto top-up with
an explicit `transfer_origin_account_id` carries basis from that account into Nexo. Without a known
origin, it remains an incoming event with unresolved basis; the exported USD valuation does not
establish purchase cost. Asset withdrawals require an explicit `transfer_destination_account_id`
and a consistent gross/received/asset-fee balance.

Approved same-asset, equal-unit, fee-free Wallet-to-Pro and Pro-to-Wallet movements are internal
annotations within one Vision account. They affect neither holdings nor cash. Review requires a
selected companion Nexo Pro batch with viable matched or settled trades, or a prior complete Pro
batch with settled trades. That companion check does not prove that every Pro execution is present.
Incomplete conversions and inconsistent lifecycle events remain review errors.
The synthetic fixture was cross-checked against a sanitized real export and preserves its 11
headers, currency-decorated USD values, decimal precision, event kinds, UTC timestamps, signs,
linked-row structure, and fee-currency cases without retaining transaction data. Regression
coverage is in [[apps/node-backend/tests/nexoTransactionHistoryAdapter.test.js]].

The Nexo Pro adapter accepts the exact ordered 14-column spot order-history export. It retains
each literal record and uses the immutable `orderId`, `filledAmount`, `executedPrice`, and explicit
`tradingFee`. Requested amounts, limit prices, and trigger prices do not replace executed values.
Completed orders and cancelled orders with partial fills are real transactions; cancelled orders
with no fill and no execution fee are skipped. Non-final orders remain unsupported.

Only fiat-quoted pairs are supported. Quote-asset fees stay separate. A base-asset fee reduces
received buy units or increases debited sell units, and is valued at the executed price. Third-asset
fees and crypto-quoted pairs remain errors because the export does not establish their valuation.
Missing or duplicate order IDs, invalid timestamps, and changed header layouts reject the file.
The date is the literal calendar prefix of the exported timestamp, without a host timezone shift.
The timestamp describes an exported order record and aggregated execution; it is not verified as
an execution timestamp or an individual fill history. Establish that source's timestamp semantics
before treating it as complete dated trade history.

The Saxo adapter accepts localized Transactions CSV exports and detailed XLSX workbooks. It
normalizes ordinary and non-breaking header spaces, reads Dutch and English trade actions, and
reduces `ticker:venue` cells to the ticker. `Bk Record Id` is the preferred immutable source ID;
zero placeholder IDs are not treated as transaction identities.

The canonical detailed workbook requires one `Transacties`, `_Transacties`, and `Bookings` sheet.
Main rows join to execution and booking detail by `(Rekening-ID, Bk Record Id)`. Missing, duplicate,
or orphaned detail, conflicting metadata, invalid booking signs, and totals that fail to reconcile
reject the workbook before staging. Numeric identifier cells outside JavaScript's safe integer
range reject; identifiers stored as text retain their exact text.

Workbook trades use the booked account-currency principal, an effective unit price of principal
divided by units, separate commission, and separate exchange tax. Original instrument quotes and
all joined booking rows remain in typed provenance with sheet name, row ordinal, headers, cells,
and a source-file hash. Dividends use gross income and aggregate withholding tax from booking
detail. Each transaction's bookings must reconcile to its net account amount within one cent;
embedded foreign-exchange conversion costs are not added a second time. Deposits and withdrawals
are instrument-less cash rows.

CSV trades retain their instrument-currency units and quoted prices, with account costs converted
when needed. A CSV cash dividend has only a net booking amount and is therefore an explicit review
error directing the user to the detailed workbook. It is not imported as gross income. Unknown
corporate actions and workbook booking kinds also remain review errors. Synthetic regression
coverage is in [[apps/node-backend/tests/saxoTransactionHistoryAdapter.test.js]] and
[[apps/node-backend/tests/portfolioWorkbook.test.js]].

When both Saxo files are selected, a uniquely proved CSV counterpart instead becomes
`duplicate_source` evidence for the detailed workbook event. Proof reparses the literal CSV with
its captured ordered headers, verifies both source hashes and complete workbook joins, and binds
the nonzero source account/booking identity, financial cells, dates and instrument metadata.
Owner labels may differ. The Vision account must match and any resolved CSV investment must agree.
Other errors, missing context, mismatches or ambiguous workbook counterparts remain blockers.

Only those locked-plan companion rows receive a readiness exception. Commit marks them duplicate
before draining financial rows, clears their errors and updates duplicate/error counters atomically.
Their literal net values and unsupported dividend fields remain evidence; no gross dividend is
invented for the CSV. Completed statement cards use the verified commit error counts. A companion-only
rollback changes no financial rows. CSV-only dividend uploads still require detailed evidence.

The transaction and portfolio pipelines share `importStageLifecycle.js` for the staging status
transition, BIGSERIAL batch-id normalization, 500-row chunk loop, persisted total, and progress
sequence. Portfolio parsing and its INSERT column set stay in this module.

Progress event: `{ phase: 'staging', current, total, percent }`

### 2. Validate

**Module:** [[apps/node-backend/src/services/portfolioImportPipeline/validate.ts]]

For each staged row:

- Parses the date using `date_format`.
- Resolves the transaction type via `portfolioTypeNormalizer` (see §Type Normalization below).
- Validates numeric fields (units, price, amount, fees, taxes, fx_rate).
- Validates the row identity used later by commit deduplication. Destination comparison is deferred until commit so repeated rows can be matched by occurrence instead of collapsed by existence.
- Marks invalid rows with `error_detail` without aborting the batch.

Progress event: `{ phase: 'validating', current, total, errors, percent }`

### 3. Match Investments

**Module:** [[apps/node-backend/src/services/portfolioImportPipeline/matchInvestments.ts]]

For each valid staged row, attempts to find an existing `investments` record:

1. **Symbol match** (case-insensitive): match one active `investments.symbol`.
2. **Provider alias**: when there is no exact symbol candidate, derive an explicit asset code from
   the holding's price-provider configuration. Yahoo crypto symbols with a recognized fiat quote
   suffix can resolve their base asset code. Kinesis configured provider symbols or catalogue
   mappings can resolve their denomination; KAU and KAG are never equated with XAU and XAG.
3. **Name match** (case-insensitive, trimmed, exact): match one active `investments.name` only when
   symbol and alias lookup found no candidate.
4. **Unresolved**: no candidate or multiple candidates require review. Ambiguous symbol or alias
   matches block name fallback.

Stored `match_source` is `symbol` for exact symbols and provider aliases, `name_exact` for names,
or `NULL` when unresolved. Response counts use the `unresolved` key for the latter.

> [!info] No ISIN, no fuzzy
> ISIN lookup and fuzzy/Levenshtein matching are explicitly out of scope for this iteration. The review step covers the long tail of unrecognized symbols.

Auto-commit condition for non-brokerage generic imports (checked after this phase):

- All rows matched (`unresolved == 0`)
- No errors (`errors == 0`)
- No name matches (`name_exact == 0`)

If both are true, the generic import continues directly to commit (201 response or `complete` SSE
event). Otherwise, the batch is set to `awaiting_review` (202 response or `review_required` SSE
event). Every maintained preset is a brokerage import and always enters `awaiting_review`, including
when both conditions are true.

Progress event: `{ phase: 'matching', current, total, percent }`

### 4. Review (if needed)

When a batch enters `awaiting_review`, the frontend navigates to `PortfolioImportReviewPage`. For each unresolved group (distinct raw symbol+name), the user chooses one of:

- **Pick an existing investment** via `InvestmentCombobox` → one `POST /api/portfolio/import/batches/:id/rows/investment-override` with the complete group's `row_ids` and `{ investment_id }`.
- **Create a new investment** → the same group endpoint with the complete `row_ids` and `{ create_new: true }`. It creates one investment from the first row's symbol/name/default_asset_class and links the full group atomically.

When all rows are resolved, the user clicks **Commit** → `POST /api/portfolio/import/batches/:id/commit`.
Maintained formats use the reconciliation planner below. Investment-override endpoints reject
cash rows because an instrument selection cannot repair them. Generic missing-account cash rows
can still be retried with an explicit batch account under the batch lock.

### Reviewed reconciliation

**Modules:** [[apps/node-backend/src/services/portfolioImportReconciliationService.ts]],
[[apps/node-backend/src/services/portfolioImportCommitService.ts]], and
[[apps/node-backend/src/repositories/portfolioImportReconciliationRepository.ts]].

A full-history session previews all selected batches together. Pending, validated, unresolved, and
error rows block its commit. The planner checks existing source fingerprints, repeated source identities across
selected statements, and nearby legacy history. A legacy candidate must be uniquely attributable:
the same investment within seven calendar days and plausible units or proven equivalent economics.
Literal Nexo Pro evidence can extend the candidate date window to 31 days only with exact executed
price, exact units or an exact base-fee explanation, and equivalent cash economics. The raw
evidence must also bind the staged date, explicit quote fee, and zero tax. This still
requires an explicit reviewed date correction and does not certify the order timestamp as execution
time. Amount and fee proofs allow only their four-decimal stored representation: the shared
half-even rounding or PostgreSQL staging's ties-away-from-zero rounding. An exact half-decimal
must not lose its base-fee proof and appear as a new acquisition after staging.
A plausible Pro trade with exact net or fee-explained gross units in that extended window blocks
instead of inserting when its economics remain unproven. Literal Portfolio Performance evidence
can identify a unique legacy trade using its recorded minor-unit cash and a cash-consistent legacy
price; the broker execution then supplies the corrected price, fees, date, and currency. A proven
execution in another currency does not establish an exchange rate.
The candidate must also be unassigned and have no import batch or fingerprint. Ambiguous matches,
already assigned/imported candidates, and conflicting per-batch policies remain blockers rather
than choices made by a score. Source corrections additionally require proven economics and
currency conversion; preserving existing values does not silently make those corrections.

Exact financial matches use implicit `exact` adoption. Adoption preserves the existing transaction
ID and notes, stamps its broker account and source identity, and marks the source staging row as a
duplicate. It does not set `import_batch_id` on the adopted transaction. Differences require an
explicit global policy or per-statement override:

- `preserve_existing` keeps the real trade's financial values while adding assignment/provenance.
- `prefer_source` corrects supported financial fields only when the source proves equivalent
  economics. It preserves notes and type. Source-proven Saxo/IBKR dividends can correct an old net
  amount to gross income with separate withholding and a known gross convention. It does not invent
  an exchange rate or use unrelated amounts as proof. Literal Nexo Pro base-fee evidence can explain gross-versus-net unit corrections.

Unknown-basis incoming events cannot manufacture a new acquisition. They can preserve a unique
existing acquisition with positive known basis under `preserve_existing`; otherwise review blocks.

An unchanged prior Saxo workbook adoption can be corrected later with a freshly staged copy of
the same detailed workbook and explicit `prefer_source`. The retained typed source must reparse
successfully, match its literal SHA-256 and staged financial values, and identify exactly one
active adoption receipt. Its original source row and the canonical transaction's full after-image
must still match. This proof supplies booked currency, principal, commission and withholding;
it does not infer an exchange rate from the previously preserved values. Automatic matching and
`preserve_existing` remain duplicates. Changed source, history or receipt context blocks correction.

The correction preserves the original transaction ID, type and notes and writes a new adoption
receipt in the fresh batch. The old batch, its receipts and its cash records stay unchanged.
Original adoption batches join the sorted lock scope and receipt/source context joins the plan
fingerprint. Rolling back the correction restores its previous after-image. Rolling back the old
adoption while that correction is active rejects because its after-image has changed.

Preview returns actions, blockers, counts, and a SHA-256 `planFingerprint` covering the selected
batches, source rows, policies, relevant current history, and companion-Pro evidence. Commit of an
explicit policy requires that reviewed fingerprint. Any relevant state change makes it stale.
Each adoption writes immutable before/after snapshots into
`portfolio_import_reconciliation_journal` in the same transaction as the adoption. Receipts are
reversible domain evidence, not an independently anchored audit chain.

After the locked complete projection passes, the reviewed writer drains source events in date, batch,
and row order. Custody writes use [[apps/node-backend/src/services/portfolio/portfolioCustodyImportScope.ts]]
to bind each approved event to the same transaction client and source signature. Each event allocates
lots from persisted history through its own date. This permits an earlier withdrawal and later return
to be inserted around an already recorded sale without treating the temporary partial timeline as
complete. Before commit, the writer validates complete persisted history for every affected custody
investment under all three basis methods and checks that every approved custody event retained its
exact source and financial facts. A changed event, invalid final history, or row failure rolls
back the entire selected scope. Ordinary custody writes still validate full history.

### Attach proven Kinesis source records

The optional **Attach proven source records** scope links a safe, server-derived subset of a fresh
full Kinesis statement to existing history under `preserve_existing`. It keeps existing financial
values, dates, type and notes while adding assignment and source provenance. An ordinary uniquely
proved buy or gift needs the exact existing date and eight-decimal quantity. A buy's
literal principal, currency, price, fees and taxes must also match stored financial values.
Meaningful gifts require matching literal original basis and currency. Source
financial mismatches and missing basis remain pending even under `preserve_existing`.
Financial qualification comes before repeat-receipt validation. A unique repeated record that
fails it stays pending even if its older receipt lacks complete source context. Qualifying repeated
source records settle only when one active adoption receipt, retained source proof and the full
canonical after-image still agree. An ambiguous eligible record remains a blocker.

[[apps/node-backend/src/services/portfolioKinesisAdoptionScope.ts]] verifies the complete literal
CSV capture, SHA-256, ordered headers/events, identities, account and occurrence context before
any selection. Skipped rows, asset filters, old captures without this context, or changed staging
evidence prevent a ready plan. The full source is classified first; callers cannot provide row IDs
or asset filters to select records within that staged statement. This proves the uploaded statement
context, not that the broker export contains every historical event.

The selected actions are `adopt`, receipt-proven `duplicate`, and already `settled`. The writer
returns before the ordinary drain and inserts no trades, income, cash, custody or adjustments. It
does not repair an imported duplicate. Proven existing zero-basis yield-unit acquisitions can be
attached when the recorded amount, unit price, fees and taxes are also zero, without changing any
recorded values.

Already-retained complete original-document evidence can prove a closed yield group between independent
meaningful deposit receipts. [[apps/node-backend/src/services/portfolioKinesisYieldGroups.ts]]
requires complete primary, reference and canonical interval membership, a same-file settled yield
anchor, and globally unique eight-decimal unit pairing. It does not choose a subset by quantity or
infer an individual date. All eligible members are reviewed together or blocked together. Each
new adoption joins one distinct source-unit row to one distinct existing record; an already-settled
anchor remains a duplicate or settled action. Attachment keeps the original recorded dates even
when the broker payment date differs. Quantities, financial values, types, notes and IDs also stay
unchanged. Fresh repeats require retained group proof and unchanged full-image receipts.

New yield acquisitions and paired new income remain pending in this attachment scope. The
separate bounded in-kind income scope can record proven paired income without adding units again. Other excluded events remain unsettled for a
later review;
the preview reports their event kinds and counts separately from selected actions.

The commit is atomic for its selected records. `pending` counts excluded unsettled rows;
`complete` means that this count is zero. If any source remains pending, all selected batches stay
`awaiting_review` without completion timestamps, even when one batch's own progress is complete.
Existing immutable adoption/restore receipts provide guarded rollback; a changed after-image
blocks restoration. This mode adds no schema or journal.

Full-history review can compose literal paired income with its one zero-basis Gift insertion or
proved existing acquisition. The preview shows **Record paired income** separately from the Gift
action. `incomeProof.unitRowId` binds the selected Gift in the same batch, investment and payment
date; existing units also have `unitTransactionId`. The atomic writer proves the actual unit before
recording its informational income, so units and gains are not counted twice. Repeated income and
already-owned cash create no new records. Full `recordedIncome` and `recordedCash` are subtotals of
all imported records. This adds no mode, row picker or upload workflow; the bounded income choice
below continues to record only income against already-existing proved units.

### Record proven in-kind Kinesis income

**Record proven in-kind income** uses `record_in_kind_income_only` with `preserve_existing` and
zero yield basis. Choose it before staging the complete original Kinesis CSV; the UI sends the zero
policy automatically. It also reviews retained complete source batches without another file upload,
while preserving stored historical source proof.

The server proves each literal income event against an already-proved existing zero-basis unit
acquisition using the full source, unique event/asset/account/date/occurrence identity and current
receipt after-images. It records only the paired income. The preview distinguishes **zero new
acquisitions** from new income records, displays the literal source amount and read-only accounting
role, and reports excluded pending event counts. There is no row picker, custom source file or
manual accounting-role choice.

Historical currency conversion is prepared automatically for proved income dates. Missing usable
stored rates leave those events pending, while independently ready events can proceed. The reviewed
fingerprint binds dated rate evidence; current rates never authorize recording, and the original
source FX remains unstamped.

New rows remain visible in active and archived transaction history as **Income included in acquired
units**. Their separate `totalInKindIncome` subtotal does not increase ordinary dividend/income totals,
units, value, cost basis or gain again. It does not imply tax status. Ordinary dividend tax estimates
and ordinary dividend/AI report totals exclude it; literal history and a separate unclassified tax
subtotal remain available. See [[docs/features/portfolio]] and [[docs/features/belgian-tax]].

The atomic commit reports `recordedIncome` equal to newly `imported` income rows, with no new
acquisitions, corrections, duplicate repairs, cash, custody or adjustments. Repeat review records no
new income. Other events remain pending; partial batches and reference context stay queued on remount.
Same-batch settled retries and freshly staged duplicates retain their paired-income proof and
existing income identity. Review accepts those proved repeats without claiming new income or
acquisitions; unrelated proofs and duplicate pair claims remain invalid.
Immutable paired record/restore receipts in migration 0124 guard both canonical after-images. Income
rollback releases the pair before dependent acquisition changes; changed images block rollback.
Older standard-role receipt images remain valid without rewriting. See
[[docs/adr/188-proved-in-kind-income-recognition|ADR-188]] and [[docs/api/portfolio-imports]].

### Record proven Kinesis cash history

New Kinesis cash in ordinary full-history commit is rejected before writes with `cash_reconciliation_required`;
use the confirmed cash-only scope to record it. Already-owned unchanged settled cash repeats remain
compatible with full review. Ownership confirmation is not assumed for future unclassified funding.

**Record proven cash history** uses `record_cash_only`, explicit `preserve_existing` and the
complete original unfiltered Kinesis CSV. Confirm that the source's funding deposits and withdrawals
are transfers between your own accounts. The confirmation is bound to source/account routing;
changing sources, routing or filters invalidates review and clears stale confirmation. Stage/review
requires the confirmed complete source. No XML, source-row picker or handmade CSV is needed.
Retained source batches and their stored historical proof remain available.

The server proves all source cash balance chains and selects every member together.
Unrelated active ledger rows anywhere on the routed account block the scope; existing owned
components qualify only with their complete unchanged original-source proof.
The zero-opening source also requires no routed-account cash statement reading,
even a zero reading. Those rows are read, fingerprint-bound and locked alongside ledger proof;
a new or changed statement reading invalidates the reviewed plan.
It prepares historical conversion automatically; missing usable dated rates defer the complete
group, while the reviewed fingerprint binds readiness. No current rate authorizes recording. Review shows
signed amounts, dates, currencies, broker accounts and source classifications. Trade quotes and
confirmed funding are internal transfers; card spending remains an expense. A separately quoted
funding-withdrawal fee stays a distinct expense, while its transfer component is net of the fee.
Card spending already includes its quoted fee. Every source-owned cash component uses brokerage
origin with no guessed peer or invented opposite bank transaction. These classifications survive
ordinary transfer reconciliation without automatic re-pairing or orphan clearing.

The preview distinguishes source-event count from resulting cash-ledger component count. Commit
reports `recordedCash` equal to newly `imported` ledger components, while duplicate counts remain
source-row settlement counts. Holdings, ordinary/in-kind portfolio income, custody, basis and units
stay unchanged. Other source events remain pending; no general event drain runs. Same-batch settled
and fresh-file duplicate reviews require complete cash proof and unchanged component images, with
zero new cash records. Successful new cash recording and cash deletion refresh ordinary statistics
caches; failed operations and no-op repeats do not schedule that refresh. Guarded rollback checks every owned component before deletion and retains
immutable source evidence. See [[docs/adr/189-proved-brokerage-cash-history|ADR-189]].

Queued session settings now retain reconciliation scope, existing-facts policy and matching cash
confirmation across reloads. The checkpoint binds selected batch identities and source/account
routing, retains reference state, and requires fresh review after remount. Invalid or older settings
use the existing full-history/automatic defaults. No financial source payload is copied into the
settings checkpoint.

### Correct proven existing Kinesis records

The optional **Correct proven existing records** scope uses `correct_existing_only` and explicit
`prefer_source` to repair proven financial differences or closed yield-group payment dates in unique
existing buys/gifts.
It uses the same complete fresh unfiltered Kinesis primary proof and server-derived selection.
Ordinary financial corrections retain dates, types, quantities, notes and transaction IDs. Their
allowed corrections are principal, unit price, fees, taxes, currency and original FX. Literal source
fees replace recorded fees; no fee is added a second time.

A separately proved complete zero-basis yield group can use the literal broker payment date.
Every changed member is corrected together with a typed `dateProof` and only `date` in its
corrections. The same independent deposit boundaries, settled yield anchor, unique unit pairing
and interval closure prove membership. Quantities, financial values, type, notes and transaction
IDs stay unchanged. An unchanged anchor is proof context rather than a new correction. The preview
shows the recorded and payment dates and counts only changed existing records. Ordinary financial
corrections still retain dates; this is not a general date-editing rule.

Meaningful gift basis/currency require already-retained validated recorded-native evidence bound
to the primary event and exact account/asset/date/quantity. No public reference upload can add or
enrich that evidence. Original identities, selected source IDs and immutable receipts stay unchanged.
An existing zero or nominal gift basis is not promoted into a financial basis correction.

Currency corrections without literal original FX use automatic historical backfill. Preview and
locked commit require a usable stored rate on or before the transaction date, no more than seven
days earlier. Source FX stays unstamped, and today's rate cannot authorize the correction. If a
gift's historical rate is unavailable, its correction remains pending while independent proved
fee corrections can proceed. The selected rate evidence is bound to the reviewed fingerprint.
Startup warms historical rate caches for these records but does not stamp canonical FX on rows
with an import batch, source hash or duplicate fingerprint. Both candidate selection and the locked
update protect that provenance, preserving source facts and immutable receipt after-images.

Review shows zero new transactions, the existing correction count, and excluded pending events.
Only proven `adopt` corrections and strict receipt-proven `duplicate`/`settled` retries are
selected. Commit performs no insertion, duplicate repair, cash movement, custody transfer or
adjustment, and returns before the ordinary source drain. Partial source checkpoints
and the `awaiting_review` lifecycle remain intact. The same immutable receipt and after-image
rollback guards restore only the corrected originals, including their original recorded dates for
group date corrections. Complete group evidence and all before/after dates are bound into the
preview fingerprint and rechecked under commit locks.

### Repair an already imported duplicate

If source identity finds a previously imported same-account/same-investment copy while one unique
unstamped, unassigned manual candidate also exists, review can produce `repair_duplicate`. Its
original import batch must be complete with a positive imported count and exactly one committed
staging pointer matching the fingerprint. Imported date, financial values, and provenance must
still match the staged source. Changed imported notes or recurrence metadata block repair so no
annotations are discarded. An old dividend convention can be corrected only through supported
source evidence; other imported financial changes block.

Repair always requires `preserve_existing` or `prefer_source` plus the reviewed fingerprint;
automatic matching reports `duplicate_repair_policy_required`. Preview exposes the retained manual ID,
the removed imported ID, original batch, and both financial images. Commit adopts the manual ID
and notes, removes the exact imported copy, changes its old staging pointer to null/duplicate, and
moves one old batch count from imported to duplicate. The new source also becomes a duplicate.
Both rows' full images, old staging snapshots, and batch counters are retained in the immutable
`portfolio_import_duplicate_repair_journal` (0122). Relevant old batches join the sorted lock scope.

IBKR repairs can use authenticated literal statement context to prove native trade currency and
principal, base-currency commission conversion, and dividend gross versus separately exported
withholding. The proof rechecks literal hashes, ordered columns, statement currency and staged
precision. A unique same-date economic claim narrows overlapping imported-copy candidates before
one-to-one usage checks. A different proved imported copy remains a duplicate; it cannot become
an insertion. Unproved or multiple claims remain blocked. The same proof can identify a standalone
legacy sale with a copied currency label. It does not widen the ordinary seven-day match window or
the separate Nexo Pro proof rule. Dividend adoption clears embedded withholding only when the
unique separate source tax proves it, so withholding is recorded once.

Rollback validates every after-image and the complete projected history before any mutation. It
restores the imported copy's original ID/timestamps, the manual financial/provenance values, old
staging pointers/statuses, and counters. A changed row or provenance returns
`duplicate_repair_changed` and leaves the operation untouched. Restore appends an inverse receipt;
timestamp-trigger changes on retained rows do not replace the financial equality checks.

### Dated custody and original basis

**Modules:** [[apps/node-backend/src/services/portfolio/portfolioAssetTransferService.ts]] and
[[packages/shared-utils/src/portfolioCustody.ts]].

`portfolio_asset_transfers` stores one dated, source-identified event for a whole or partial custody
move. The source and destination must be different active brokerage, exchange, or wallet accounts.
Nexo incoming transfers use `transfer_origin_account_id`; outgoing Nexo and Kinesis transfers use
`transfer_destination_account_id`. An unknown origin, destination, acquisition basis, unresolved
investment, or insufficient dated source holdings blocks the plan.

Replay orders trades and transfers by date and a shared ID sequence. It derives temporary inbound
and outbound legs rather than persisting fake trades. FIFO, LIFO, and weighted-average methods carry
remaining purchase lots with their original acquisition IDs/dates, native cost, and purchase FX.
Transfers do not use transfer-date FX to reset basis. Same-asset withdrawal fees leave the portfolio:
the source loses gross units and the destination receives gross units minus fees. The stored
method-specific `fee_basis_allocations` explain the original lots and native/EUR basis consumed by
those fee units. Missing original FX remains unresolved rather than being invented.

Historical snapshots preserve calendar-date and shared-ID order for investments with custody or
adjustments, keeping amounts and account unit balances in Decimal. A later same-day acquisition
cannot cover an earlier transfer. Invalid source holdings or incomplete assignment rejects replay
before stored performance snapshots are replaced. See
[[docs/features/portfolio#Custody and adjustment snapshots (October 2026)|snapshot replay guarantees]].

Manual trade edits, broker re-tags, commits, and rollback validate the complete projected history
under shared writer locks. A change cannot introduce a broken custody chain or a new/worse account
oversell. Whole-lot re-tagging remains an assignment correction; it no longer represents dated
partial custody movement. See [[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|ADR-177]].

### Unit adjustments and consumed basis

**Modules:** [[apps/node-backend/src/services/portfolio/portfolioAssetAdjustmentService.ts]] and
[[packages/shared-utils/src/portfolioCustody.ts]].

`portfolio_asset_adjustments` stores dated positive unit removals as `yield_reversal` with
`zero_yield_only` basis, or `asset_fee` with carried basis. These rows use the `asset_adjustment`
staging route and leave financial `type` null. They create no sale, proceeds, or cash movement.
A reversal requires explicit Kinesis zero-basis policy and enough remaining source-proven yield
units. A fee consumes remaining original lots. Neither event can invent missing acquisition basis.

Replay uses FIFO, LIFO, and weighted average. Each event stores `basis_allocations` for all three
methods with original acquisition IDs/dates, source hashes, units, native currency/basis, and EUR
basis from original purchase FX. Unresolved FX remains unresolved. The separate
`portfolio_asset_adjustment_sources` links pin the yield provenance, including source records in
older batches. Adjustments share the trade ID sequence and full-history writer locks. Preview
exposes `adjustment` actions and `summary.adjustment`; newly written adjustments count as imported.

Snapshot replay uses the weighted-average consumed lots to remove asset-fee principal and its
original purchase FX from neutral-value weights. It preserves the principal share when canonical
basis also includes purchase fees/taxes. Yield reversals consume only proven zero-basis lots;
neither adjustment creates a capital flow or sale. Missing proof, invalid policy, or insufficient
holdings rejects computation before any performance-snapshot deletion or insertion.

Ledger updates are forbidden. Source-link updates and direct deletes are forbidden; validated
parent-event rollback removes links by cascade after projected-history checks. Retention and backup
include the ledger and its evidence links. See [[docs/reference/data-model]] and
[[docs/guides/migrations]] for schema and guarded downgrade details.

### Retained historical evidence

Portfolio Performance XML upload and reference application are unavailable. The import UI accepts
supported original broker CSV/Saxo XLSX files. Existing stored original-document context remains
readable for strict historical source matching, repeats and rollback. It does not authorize a new
upload, supplemental history, managed clone or alteration of immutable receipts. Removing the
workflow leaves all historical transactions and proof intact. The XML parser, reference planner
and reference write repository are removed; only stored JSON proof validation remains.

### 5. Commit

**Module:** [[apps/node-backend/src/services/portfolioImportPipeline/commit.ts]]

For each valid, resolved staged row:

- A reviewed session schedules all selected batches by date, then batch ID, then source
  `row_index`. Newest-first files do not sell before older acquisitions. Same-day source order is
  stable; an unknown intraday execution order is not invented. Provenance and fingerprints remain
  tied to the original source records.
- Calls `portfolioTransactionService.create` (shared with the manual transaction entry path), which enforces 2-of-3 unit math (units × price ≈ amount), oversell prevention, and asset-class routing.
- **Account assignment:** if the batch has `account_id` set (migration 0057), each committed `portfolio_transaction` inherits that `account_id` so all lots from this import belong to the specified brokerage account.
- **FX auto-resolution**: if the trade currency is not EUR and no `fx_rate` was mapped or present in the row, calls `fxResolve` ([[apps/node-backend/src/services/portfolio/fxResolve.ts]]) to look up the historical EUR rate for the trade date (ADR-074 semantics).
- **Occurrence-aware deduplication**: each trade identity includes `(investment, date, type, amount, units, account, currency)`. The i-th occurrence in the uploaded statement is paired with the i-th matching destination row. This preserves legitimate identical fills on first import, makes a complete reimport a no-op, and inserts only missing occurrences after a partial import. As in budgeting imports, every row also gets a hash derived from its retained source record. Portfolio commit deliberately uses occurrence matching instead of collapsing equal hashes because a broker statement may contain two legitimate byte-identical fills.
- Maintained reviewed commits and session commits use one outer transaction for adoption, trades,
  cash, custody events, adjustments, staging states, and counters. Any runtime row failure aborts the whole scope.
  Generic imports retain their earlier partial-commit behavior. Cache invalidation occurs only
  after the outer transaction succeeds.

Progress event: `{ phase: 'committing', current, total, imported, duplicates, errors, percent }`

**Post-commit navigation (Aug 2026):** on success, `PortfolioImportReviewPage` navigates to `/portfolio` with `{ replace: true }` instead of a normal push — the reviewed batch is consumed, so Back skips the review URL rather than re-inviting a commit of an already-committed batch. Same fix applied to the budgeting-side `ImportReviewPage` → `/import` (see [[docs/features/import#4-commit-commitbatch|Import Feature: Commit]]).

---

## Brokerage cash routing and the double-count rule (WP-C2, Aug 2026)

On an `is_brokerage` batch, `validate.js` stamps each row's `route` via
`classifyBrokerageRow` ([[apps/node-backend/src/services/importPipeline/brokerageRouting.ts]]):

- **`route='cash'`** — external deposits/withdrawals, **and (D6, [[docs/adr/095-brokerage-account-import|ADR-095 addendum 2026-07-10]]) dividend/interest/fee/tax rows that carry no instrument reference at all** (no symbol, no name — sleeve interest, custody fees, account-level distributions). Each commits as ONE signed row in `transactions` on the batch's sleeve account: staging magnitudes are absolute, the sign comes from the row's canonical type (dividend/interest → `+`, fee/tax → `−`; deposits `+`, withdrawals `−`). The Behavior setting `brokerage_cash_category_ids` optionally maps each D6 kind to an active category ID. Import reads one mapping snapshot per commit, resolves active IDs only, and never creates or reactivates a category. An unset, missing, or inactive mapping commits the row uncategorized. External deposits/withdrawals always stay uncategorized because they are transfers, not income or expense. The payee is the broker (sleeve account `institution`, falling back to `name`).
- **`route='asset_transfer'`** — dated custody event with carried original acquisition lots.
- **`route='account_internal'`** — same-account Wallet/Pro annotation with a required Pro companion; no canonical financial row.
- **`route='portfolio'`** — buys/sells, and dividend/interest/fee/tax rows that DO name an instrument. These commit to `portfolio_transactions` only; an unresolved instrument on such a row is a correct blocking error, repairable in review (pick/create holding, then re-commit).

The routing is deterministic from the row and decided at validate time; a statement row lands on **exactly one side, never both**.

### The double-count rule

**Ledger cash is the only cash truth.** Cash from a brokerage statement enters net worth exclusively through the `transactions` rows the import creates (the per-currency anchor+delta balance SQL, ADR-094/WP-A1). Portfolio-side `dividend`/`interest`/`fee`/`tax` rows in `portfolio_transactions` remain the **current per-instrument and Belgian-tax statistics source** and **never enter net worth**: snapshot valuation is `units × price` plus the non-unit formulas, and income/dividend/fee/tax rows explicitly do not alter invested capital or value (`snapshotBuilder.js`, "income / dividends / fees / taxes: don't alter invested capital"). The portfolio-level income and FIRE coverage surface proposed by [[docs/adr/096-dividend-income-fire|ADR-096]] is deferred and is not a current consumer. So an instrument-attached dividend is counted once (portfolio stats, not cash), an instrument-less one is counted once (ledger cash, not portfolio stats) — they can never both enter net worth.

**Accepted trade-off** (per the ADR-095 addendum): D6 cash rows live in the ledger, not in portfolio analytics — an account-level distribution does not count toward current per-instrument income statistics or the portfolio-side tax figures; category-based ledger reporting covers it. Conversely, an instrument-attached dividend's cash does not appear in the ledger (ADR-090 synthetic legs were deleted per ADR-108) — reconciliation of the sleeve's true cash balance for trade-driven flows is WP-C4 territory.

**Cash-row dedup identity:** a cash row dedups on `(account, date, signed amount, currency, memo)` by **occurrence matching**, not existence — a statement may legitimately repeat one identity (e.g. two identical per-exchange custody fees on one date whose descriptions weren't mapped into `note`), so the i-th occurrence in a batch is a duplicate only if the ledger already held more than i matching rows before the run; both fees land on first import, and a re-import of the same statement is still a complete no-op. The legacy absolute-amount branch (recognizing pre-sign-fix positive withdrawals) applies only to untyped deposit/withdrawal rows — D6 rows match the signed amount only, so a new −10 fee never dedups against an unrelated +10 row sharing date and memo.

**Rollback** treats D6 rows exactly like other cash rows: `route` travels with `committed_txn_id`, so `rollbackBatch` deletes them from `transactions` (never the portfolio table) and resets staging to `matched`.

Tests: `tests/portfolioImportInstrumentlessCash.db.test.js` (full pipeline, signs, configured categories, rollback, non-brokerage unchanged), `tests/brokerageRouting.test.js` (D6 classification), `tests/portfolioImportCommit.test.js` (pinned cash INSERT SQL + D6 sign/configured-active-category params).

---

## Type Normalization

**Module:** [[apps/node-backend/src/services/portfolioImportPipeline/portfolioTypeNormalizer.ts]]

Converts raw CSV type strings → canonical `portfolio_txn_type` values:

**Resolution order:**

1. User-provided `type_mapping` (e.g. `{"Koop":"buy","Verkoop":"sell"}`).
2. Built-in alias table (covers common English and NL/DE variations):

| Canonical  | Aliases recognized                 |
| ---------- | ---------------------------------- |
| `buy`      | buy, purchase, koop, kauf, aankoop |
| `sell`     | sell, sale, verkoop, verkauf       |
| `dividend` | dividend, div, dividende           |
| `fee`      | fee, commission, kosten, gebühr    |
| `tax`      | tax, withholding, belasting        |
| `interest` | interest, rente, zinsen            |

3. If the type string is non-empty but unknown after both steps → **row error** (not a silent default). The error detail names the unrecognized value.
4. If no `type_column` is mapped at all → `default_type` from the config is used (default `buy`).

> [!warning] Unknown type = row error
> A row with a present but unrecognized type string is rejected, not silently cast to the default. This prevents misclassified trades from polluting the portfolio.

---

## Deduplication

Portfolio and budgeting imports now share `importIdentity.js`; see
[[docs/adr/134-versioned-import-identity-and-exact-provenance|ADR-134]]. Every row stores a
byte-sensitive, non-unique `source_record_hash` separately from its versioned
`dedup_fingerprint`. The fingerprint prefers an immutable provider transaction ID. Otherwise it
uses normalized trade or cash fields plus a one-based occurrence ordinal.

The identity includes currency, route, and source account identity, but not the selected adapter.
When the source does not provide an account, the destination account's stable
`accounts.import_identity` UUID is used. This keeps cross-account and cash-versus-trade rows
separate while allowing the same export to move between parser paths. Repeated identical fills
receive different fingerprints, while a full re-import reproduces the same fingerprint set.

Commit first checks the exact fingerprint. Historical rows without migration 0103 metadata use the
previous occurrence-count field match. The canonical partial unique fingerprint index is the race
guard for concurrent imports.

Source identity and reviewed reconciliation have separate jobs. Fingerprints make known source
reimports a no-op. The planner can adopt a unique legacy trade with a full before/after receipt;
it does not silently infer missing executions, transfer destinations, or original acquisition cost.

The fingerprint includes currency. A common provider ID alone does not guarantee deduplication
between a CSV trade in instrument currency and its XLSX representation in account currency. Use
the detailed Saxo workbook as the canonical source rather than importing both representations.

Rollback removes batch-owned trades, cash rows, and custody events, restores adopted trades, and
reverses reviewed duplicate repairs from their journal snapshots. An adopted transaction must still equal its recorded after-image;
otherwise rollback returns a conflict. It also validates the projected remaining history, so a
later transfer or sale cannot be orphaned. Restore receipts append to the journal; original IDs and
notes survive. Receipt- and custody-ledger foreign keys retain their referenced batch/staging
provenance instead of allowing the ordinary terminal-batch sweep to remove it. See the guarded
migration rollback plans in [[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger]].
The session's collapsed import history exposes whole-statement rollback for completed batches,
including adoption-only batches. Its confirmation distinguishes restoring adopted records from
removing newly created records. Cancellation leaves history unchanged; a conflict remains visible
without discarding the statement. Successful rollback invalidates the current review and refreshes
portfolio, account, cash, and import history views before a fresh import.

---

## Saved Portfolio Parser Configs

Reuses the `custom_parser_configs` table with a `kind` column (migration 0041):

```sql
ALTER TABLE custom_parser_configs ADD COLUMN kind TEXT NOT NULL DEFAULT 'transaction';
DROP INDEX uq_custom_parser_configs_name;
CREATE UNIQUE INDEX uq_custom_parser_configs_name_kind
  ON custom_parser_configs (name, kind);
```

The `kind` discriminator (`'transaction'` | `'portfolio'`) means:

- Transaction parsers and portfolio parsers are stored in the same table but kept separate.
- Uniqueness is per-kind: a parser named "My Bank" can exist as both a transaction parser and a portfolio parser simultaneously.
- `GET /api/portfolio/import/parsers` filters `WHERE kind = 'portfolio'`.
- `GET /api/import/parsers` filters `WHERE kind = 'transaction'` (or `kind` IS NULL for rows predating migration 0041, handled by the DEFAULT).
- A portfolio parser may store `accountId`. Selecting that parser restores the broker choice and
  stages the whole file with that account. The upload edge rejects missing, archived, or
  non-portfolio accounts before staging.
- Review always discloses the routing as “N trades to Broker” or “N trades to Unassigned”. If a
  saved account became unavailable, commit stays disabled until the user selects a replacement.

**Frontend:** `usePortfolioParserConfigs` hook, `PortfolioCsvColumnMapper` component, `portfolioImports` API client module.

---

## Frontend

### Navigation

Portfolio Import is accessible under **Portfolio → Tools → Import portfolio history** at route
`/portfolio/import`.

### Pages

| Page                        | Route                               | Purpose                                                                               |
| --------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `PortfolioImportPage`       | `/portfolio/import`                 | Multi-statement session, reviewed reconciliation, and custom mapping or saved parsers |
| `PortfolioImportReviewPage` | `/portfolio/import/:batchId/review` | Investment resolution for unmatched rows                                              |

### Multi-statement session

`PortfolioImportSession` accepts up to 100 maintained CSV or Saxo XLSX statements. It detects each
source and automatically chooses an account only when one candidate is unambiguous. Each statement
can set an account, transfer counterpart, and policy override; a global adoption policy applies to
statements without an override. Nexo's other-custody-account control configures both incoming origin
and outgoing destination. Kinesis's control configures the outgoing destination.

Files stage sequentially through the existing POST SSE upload. Each returned batch ID is saved
before preview loading; stopping waits for the current upload to finish and retains its batch.
Only staged batch metadata is kept in tab-scoped `sessionStorage`, never file bytes. Restaging
retains earlier batch IDs visibly. Staging alone creates no history.

The existing-import picker adds only the completed IBKR source batch the user selects. Retained
queued broker batches can be reviewed directly without reattaching file bytes. Stored server proof
remains subject to the same validation; the session has no XML chooser or reference upload call.

The combined review displays actions, existing/source values, corrections, policy, transfer
units/fees/accounts, and adjustment kind/basis policy. Duplicate repair displays both the retained
manual and removed imported snapshots with their separate counts. Configuration changes invalidate review. Commit requires a ready plan for the
current complete scope and sends its fingerprint. Unknown or malformed commit outcomes are shown
as unverified. The session does not prove that supplied exports contain every historical trade or
that an order timestamp is an execution timestamp.

**Full history** remains the default. **Attach proven source records** is available only when the
session contains complete Kinesis statements, no asset filters, and no source-preferred statement
policy. Choosing it sets the global policy to `preserve_existing` and invalidates any earlier
review. Choose this scope before staging: Kinesis uploads then explicitly send
`yield_basis_policy='zero'`, so already recorded zero-basis yield receipts can
be proved without changing their financial values. New acquisitions and income remain pending.
Choosing attachment scope after full-history staging does not reinterpret its staged events.
Already-retained complete original-document proof can establish closed grouped yield matches. Their recorded dates stay unchanged
in attachment mode; broker payment dates remain source evidence. Adding an incompatible source keeps the chosen scope visible and disables staging/review
until the conflict is resolved or the user explicitly chooses full history; it never broadens the
scope automatically.

**Correct proven existing records** requires the same complete Kinesis-only source set with no
asset filter or contrary preserving statement policy. Choosing it sets the global policy to
`prefer_source`, invalidates the review, and explicitly sends the zero basis policy before fresh
staging. Financial differences and proved group date changes are shown for review; quantities,
types, notes and IDs are retained. Ordinary financial corrections retain dates. Historical queued
sources keep their batch IDs and can use their already-stored proof without source reupload.

Before confirmation, attachment review shows zero new transactions, existing records to attach,
and pending event counts. It sends the same scope and reviewed fingerprint on commit. A partial
response keeps every staged statement in tab-scoped storage, including batches with zero individual
pending rows. Matching source/routing/batch checkpoints retain scope, policy and funding confirmation
on reload and require fresh review. Old or invalid settings use full-history/automatic defaults.
Complete sessions clear the queued metadata. Partial attachment does not complete the full import.

### Single-file upload and mapping layout

The upload page starts with a CSV/XLSX dropzone and **Detect automatically** selected. Header
signatures select IBKR, Kinesis, Nexo wallet, Nexo Pro, Saxo, or native wallet receipts only when one signature matches. Detection reads the complete file within the 50 MiB upload limit, so CSV account selection includes
all records rather than a preview prefix. Malformed CSV quotes fail instead of being repaired.
XLSX detection requires one Saxo header signature across workbook sheets; unsupported or unreadable
workbooks disable upload. The server independently enforces the workbook contract. Unknown CSVs remain available for custom mapping. Automatic detection is a
frontend convenience; API callers supply the required mapping fields and `portfolio_format` only for specialized adapters.

Account selection first tries one exact exported account identity against active broker account
names or display names, then one recognized broker institution/name. Multiple source accounts or
ambiguous candidates remain unassigned for explicit selection. An automatically chosen account is cleared if a later account-list update makes the match
ambiguous or unavailable. Explicit manual choices are preserved for the current file. Replacing a
file clears its automatic preset/account, and stale detection results cannot apply to the new file.
Saved parsers and explicitly chosen presets retain their reusable settings across uploads.
Native receipts require exactly the ten unique `Date`, `Type`, `Symbol`, `Units`, `Amount`,
`Currency`, `Source_ID`, `Source_Account`, `Note` and `Receipt_JSON` headers and supported native
receipt types. Their generic preset omits the specialized format and fixes decimal-dot numbers,
ISO calendar dates and source identity mappings. Physical sender addresses never select an account;
only one exact active logical CoolWallet name/display-name alias can auto-resolve, otherwise the
wallet account must be selected explicitly. The multi-statement session stages Kinesis yield units
with explicit zero basis in full history as well as bounded scopes; literal paired income remains
separate. Other broker presets and the backend's default yield policy are unchanged.

Custom column mappings appear
only after a file is selected. **CSV format options** keeps delimiter, date and number formats,
encoding, and skipped-row settings in a collapsed disclosure; the parser choice remains visible.

The mapper shows eight core columns: date, transaction type, symbol, name, units, price, amount,
and currency. Fees, taxes, exchange rate, and note are available under **Additional columns**.
Defaults and transaction-type value mapping remain available alongside the core mappings.
**Save this setup for reuse** separately expands the saved-parser controls. These disclosures
change presentation only; they preserve the configured values and import validation.

### Atomic group resolution

The review page resolves a complete unmatched instrument group through one
`POST /api/portfolio/import/batches/:id/rows/investment-override` request. Picking an existing
holding sends the group's staging-row ids with `investment_id`; creating a holding sends the same
ids with `create_new: true`. The backend locks the batch and complete row set before looking up or
creating a holding, then applies the set in one transaction. If the batch is not reviewable, one id
is missing, belongs to another batch, is no longer reviewable, or a create-new retry finds an
existing user override, no staging row changes and no new holding remains. This replaces the
previous serialized one-request-per-row flow, which could issue thousands of requests and stop
after a partial group update.

See [[docs/api/portfolio-imports#POST /api/portfolio/import/batches/:id/rows/investment-override|the bulk review endpoint contract]].

> [!info] Brokerage import after ADR-108 / WP-C1
> ADR-108 deleted the ADR-103 build flag and the old trade cash-leg fan-out path. Brokerage import
> classification and assignment to an account remain supported without a frontend build flag;
> WP-C1 deliberately retained those import fields. See
> [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108]] and
> [[docs/adr/095-brokerage-account-import|ADR-095]].

### Components

| Component                  | Purpose                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `PortfolioImportSession`   | Stages multiple maintained statements and reviews one fingerprinted reconciliation plan |
| `PortfolioCsvColumnMapper` | Maps core and additional CSV columns; the parent page owns the preview                  |
| `InvestmentCombobox`       | Searchable combobox for picking or creating an investment during review                 |

### i18n

New `portfolioImport.*` keys in `i18n/source/en.json` and `i18n/source/nl.json`.

---

## FileHeadersPanel Integration

`PortfolioImportPage` owns the shared `FileHeadersPanel` above the parser controls. After a file
is selected for generic mapping, the panel offers its column names and sample rows in a collapsed preview and
highlights mapped columns. `PortfolioCsvColumnMapper` reads the same preview data to populate its
mapping controls for CSV files. A detected workbook uses its maintained preset rather than the
generic column mapper. The budgeting `TransactionImportCard` uses the same panel. See
[[docs/features/import#file-headers-preview-panel|Import Feature — FileHeadersPanel]].

---

## Database

Migration 0040 introduced the two portfolio import tables:

**`portfolio_import_batches`** — mirrors `import_batches` with portfolio-specific defaults:

- Standard status lifecycle (`pending → staging → … → complete | failed | aborted | awaiting_review`)
- `default_asset_class` and `default_type` columns store batch-level config defaults
- `account_id` FK → `accounts` (nullable) — destination brokerage account; committed lots inherit this value (**migration 0057**)
- Included in `BACKUP_COVERED_TABLES`

**`portfolio_import_staging_rows`** — mirrors `import_staging_rows` with portfolio-shaped columns:

- `type`, `symbol`, `name`, `units`, `price`, `amount`, `fees`, `taxes`, `currency`, `fx_rate`
- `resolved_investment_id` FK → investments (set by matchInvestments phase)
- `user_override_investment_id` FK → investments (set by investment-override endpoint)
- `match_source` TEXT (`symbol` | `name_exact` | `NULL` when unresolved)
- `route`: cash, portfolio, asset transfer, asset adjustment, or account-internal annotation
- `asset_transfer_details` JSON retains direction, gross/fee units, and basis status (migration 0121)
- `asset_adjustment_details` JSON retains adjustment kind, account, basis policy, and eligible yield hashes (0123)
- Included in `BACKUP_COVERED_TABLES`

Migrations 0120–0123 add immutable adoption/duplicate-repair receipts, the dated custody ledger,
and the adjustment ledger with restrictive source links. All new tables are backup-covered and
have guarded downgrade conditions; upgrading does not rewrite existing holdings. See [[docs/reference/data-model|Data Model Reference]] for field-level schema and
[[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|ADR-177]] for recovery limits.

Migration 0124 adds the default `standard` income role and an empty paired-income receipt journal;
it does not create income history or rewrite prior financial values or receipt JSON. Normal startup
recognizes the exact registered 0120–0125 profiles and advances only to pinned additive 0125.
Migration 0125 adds source-owned brokerage cash origin and typed source receipt protection; it
creates no cash records or transfer peers during upgrade.
Older 0118 bridge/conversion maintenance stays deferred, and unknown successor revisions refuse
automatic upgrade. See [[docs/guides/migrations|Migration target policy]] and
[[docs/adr/188-proved-in-kind-income-recognition|ADR-188]].

---

## Related

- [[docs/features/index|Features Index]]
- [[docs/api/portfolio-imports|Portfolio Imports API]] — full endpoint reference
- [[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|ADR-177: Reviewed reconciliation and dated custody]]
- [[docs/adr/078-portfolio-csv-import|ADR-078: Portfolio CSV Import Architecture]]
- [[docs/features/import|Import Feature]] — budgeting import pipeline (parallel)
- [[docs/features/portfolio|Portfolio Feature]]
- [[docs/adr/108-portfolio-accounts-v2-broker-tags|ADR-108: Portfolio accounts v2]] — retires the ADR-103 flag and synthetic trade cash legs
- [[docs/adr/103-per-account-holdings-ui-flag|ADR-103: Per-account holdings UI flag]] — historical decision, superseded by ADR-108
- [[docs/adr/095-brokerage-account-import|ADR-095: Brokerage Account Import]] — batch-level account and cash-row routing retained by ADR-108
- [[docs/adr/066-saved-named-custom-csv-parsers|ADR-066: Saved Named Custom CSV Parsers]] — original parser-config design
- [[docs/adr/074-fx-attribution-historical-rates|ADR-074: FX Attribution]] — fxResolve semantics used by commit phase
- [[docs/reference/data-model|Data Model Reference]] — `portfolio_import_batches`, `portfolio_import_staging_rows`, `custom_parser_configs`

### Explicit asset scope

A statement may be staged with comma-separated asset symbols. Empty scope imports the whole statement. The original file and literal source records are retained. Unselected parsed rows are outside the batch; their count is saved as `custom_config.scope_excluded_rows`, separately from parsing errors. Cash legs are included only when their literal record also has a selected asset leg. Unknown selected symbols reject staging. Changing the scope invalidates the staged review and requires staging again. Portfolio Performance coverage for explicitly scoped source accounts is restricted to those selected investments, while earlier external custody dependencies remain in scope.

Literal Kinesis deposits may identify a unique existing gift with six-decimal rounding only when the retained primary record, exact Portfolio Performance gift, account, date, asset and original basis all agree. The original transaction ID is adopted. Complete same-day Kinesis withdrawal groups may cover separate net transfers and repeated fee deliveries with up to 0.0000001 unit of rounding per entry; the broker quantities and fees remain unchanged. Additional or materially different fee deliveries block review.

Weighted-average custody allocation assigns the final eligible lot the exact remaining requested units. This prevents Decimal proportional-allocation residuals from falsely blocking a later fee that consumes the exact wallet remainder; real unit overdraws remain rejected.
