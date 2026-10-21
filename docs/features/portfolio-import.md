---
title: Feature - Portfolio Import
type: feature
status: active
date: 2026-10-21
updated: 2026-10-21
last_modified: 2026-10-21
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
    adr-236,
  ]
aliases: [portfolio-import, portfolio-csv-import, brokerage-import]
description: Multi-statement portfolio history import with automatic detection, one full-history reconciliation review, cross-export deduplication for Saxo CSV/XLSX and the IBKR CSV/funding workbook, ordinary broker cash, in-kind income, dated custody and unit adjustments, and reversible adoption receipts.
related_code:
  - "apps/node-backend/src/services/portfolioImportPipeline/index.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/stage.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/validate.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/matchInvestments.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/commit.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/portfolioGenericAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/ibkrTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/kinesisTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/nexoTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/nexoProTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/ibkrFundingHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportReconciliationService.ts"
  - "apps/node-backend/src/services/portfolioImportCrossFormat.ts"
  - "apps/node-backend/src/repositories/portfolioImportCashRepository.ts"
  - "apps/node-backend/src/services/portfolioImportDuplicateRepairService.ts"
  - "apps/node-backend/src/repositories/portfolioImportDuplicateRepairRepository.ts"
  - "apps/node-backend/src/services/portfolioImportLegacyReceipts.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/kinesisInKindIncome.ts"
  - "apps/node-backend/src/repositories/portfolioIncomeRecognitionRepository.ts"
  - "db/migrations/0005_simplify_portfolio_reconciliation.sql"
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
  - "apps/node-backend/src/services/portfolioImportPipeline/uploadSupport.ts"
  - "apps/node-backend/src/services/portfolio/fxResolve.ts"
  - "apps/frontend/src/pages/portfolio/PortfolioImportPage.tsx"
  - "apps/frontend/src/pages/portfolio/PortfolioImportSession.tsx"
  - "apps/frontend/src/pages/portfolio/portfolioImportDetection.ts"
  - "apps/frontend/src/pages/portfolio/PortfolioImportReviewPage.tsx"
  - "apps/frontend/src/features/imports/PortfolioCsvColumnMapper.tsx"
  - "apps/frontend/src/features/portfolio/InvestmentCombobox.tsx"
  - "apps/frontend/src/lib/api/portfolioImports.ts"
  - "apps/frontend/src/hooks/usePortfolioParserConfigs.ts"
  - "db/migrations/0001_baseline.sql"
  - "apps/node-backend/src/repositories/portfolioAssetAdjustmentRepository.ts"
  - "apps/node-backend/src/services/portfolio/portfolioAssetAdjustmentService.ts"
---

# Feature: Portfolio Import

## Overview

Portfolio Import loads brokerage and exchange history from CSV files, detailed Saxo XLSX
workbooks and the IBKR funding workbook (XLS or XLSX) into portfolio transactions and brokerage
cash. It is parallel to the budgeting import (`/api/import`), with the same stage, validate,
match, review, and commit phases. The historical `/api/portfolio/import/csv/*` endpoint paths
accept all supported file types; bank-statement uploads remain CSV-only.

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
Multer's extension-free temporary filename. Detailed Saxo XLSX and the IBKR funding workbook are
supported only with their maintained formats. Workbook structure and accounting detail are
checked before creating a batch. The backend keeps two workbook readers: `read-excel-file` for
Saxo XLSX, whose literal cell envelope is stored in `raw_data`, and SheetJS `xlsx` for the IBKR
funding workbook, because only SheetJS reads the legacy BIFF `.xls` that IBKR exports.

Workbook ZIP input is limited to 1,000 entries, 100 MiB of expanded content, and 500,000 parsed
cells. Duplicate or encrypted entries, unsupported archive layouts, invalid expansion sizes, and
non-workbook archives reject. Legacy XLS is accepted only for the IBKR funding workbook. Parsing does not extract files, execute
macros, evaluate formulas, or follow external links. See [[docs/api/portfolio-imports]].

**Output contract (ADR-193):** `parseWithConfig` in `portfolioGenericAdapter.ts` checks the result
of the generic mapper and of every maintained format once, against `parsedPortfolioRowsSchema`
(rows of `parsedPortfolioRowSchema`, plus the optional `skipped` and `sourceColumns`). The row
schema is strict: an unknown key, a NaN number or a date that is not UTC midnight fails. A `null`
date is allowed, because Validate reports it as a row error. Formats count unreadable rows as
`skipped`, so a contract failure is an adapter bug. It goes through `checkDataContract`, which throws in every environment
(`PRODUCTION_DATA_CONTRACT_MODE` is `"throw"`; the owner chose to block, 2026-10-09), so the import
fails with a server error naming issue paths, never values. It is never a 400. See
[[docs/adr/193-zod-runtime-contracts|ADR-193]].

The IBKR adapter locates the `Transaction History,Header` record instead of treating the statement's
first metadata row as the CSV header. It trims the real column names, reads the Summary base
currency, retains each literal `Transaction History,Data` CSV record in staging `raw_data`, and
applies these format-specific rules:

- `-` symbol, currency, price, quantity, and fee placeholders become missing values.
- Numbers use IBKR's decimal point with comma thousands, so `1,500` is 1500. A cell that is only
  valid with a decimal comma, such as `4,25`, keeps that single reading. A buy or sell whose
  quantity × price × `Multiplier` × exchange rate misses its base-currency gross amount by more
  than 1 % (at least 0.01) stages as `Unsupported IBKR event: <type>` for review instead of
  importing.
- Buy/sell units and prices stay in `Price Currency`. The base-currency gross amount is omitted so
  the shared 2-of-3 rule derives `amount = units × price`; base-currency commission is converted
  back with the statement exchange rate. An exported rate is stamped as `fx_rate_to_eur` only for
  an EUR-base statement.
- Dividend, tax, deposit, withdrawal, and adjustment amounts stay in the statement base currency.
  Deposits and withdrawals commit as ordinary brokerage cash in that currency. The CSV does not
  state a funding movement's own currency; import the funding workbook as well to record it (see
  [[#IBKR funding workbook]]).
  `Foreign Tax Withholding` normalizes to `tax`; signed instrument-less adjustments normalize to a
  deposit or withdrawal. Descriptions remain notes, so a cash-row description cannot masquerade as
  an investment name.
- Newly committed IBKR and detailed Saxo dividends retain the proven `gross` amount convention.
  Generic imports do not infer a convention. Saxo withholding stays inline; IBKR withholding stays
  in its separately exported tax event.
- An `Adjustment` whose trimmed description is exactly `FX Translations P&L` is skipped and
  included in `rowsSkipped`. It reports a base-currency valuation change rather than a cash
  movement. Other signed cash adjustments remain deposits or withdrawals.
- `Forex Trade Component` principal and quantities are not independent portfolio holdings.
  Explicit commissions and transaction fees become a single instrument-less cash fee in the
  statement base currency, with literal source identity for repeat-import deduplication.
  Zero-charge rows are skipped. Invalid charges or positive fee credits reject for review.

Batches staged before [[docs/adr/236-simplify-portfolio-import-reconciliation|ADR-236]] may still
carry an `ibkr_source_context` block in their configuration. It is no longer written or read for
proof.

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
deposits, withdrawals, card payments and trade cash legs are ordinary signed brokerage cash, as for
the other brokers. Each amount is the literal balance movement, so a quoted fee is part of the one
cash row and the sleeve closes at the statement's closing balance. ADR-236 removed the former
`cash_reconciliation_required` gate and cash-only scope.

Under `yield_basis_policy='zero'`, a distribution stages a `:income` dividend and a `:units` gift
from one source record. The commit inserts the dividend with `income_recognition_role =
'included_in_units'`, its literal amount, zero fees and taxes and no units, price or exchange
rate, beside the zero-basis gift. The role keeps the value out of ordinary income totals because
the units already carry it ([[docs/adr/188-proved-in-kind-income-recognition|ADR-188]]). A dividend
whose gift is not staged in the same batch fails the commit with `paired_income_units_missing`.
Both rows repeat as duplicates and roll back with their batch.
Review-time holding creation infers KAU and KAG as `metals`; other Kinesis asset codes use the
preset's `crypto` fallback so mixed statements create the expected asset classes. Kinesis-created
holdings use USD as their valuation currency, including asset-deposit rows that carry no quote
currency.

Native wallet receipt files (`asset_fee` and `asset_transfer_witness` rows) are no longer
supported; the generic adapter rejects them and asks for the Kinesis transaction history instead.

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
coverage is in [[apps/node-backend/tests/nexoTransactionHistoryAdapter.test.ts]].

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

### IBKR funding workbook

IBKR does not offer the Transaction Status & History funding list as CSV, only as an Excel
workbook (`.xls`, sometimes `.xlsx`). The `ibkr_funding_history` format reads its `Deposit` and
`Withdrawal` sheets with their exact headers. Each completed request (Available, Sent, Completed,
Processed, Received, Credited or Disbursed) becomes one brokerage cash row in its own currency,
parsed from `Amount` text such as `USD 1,000.00` (up to eight decimals), dated by the request date
and identified by the account ID and reference number. Any funding method is accepted, a masked
account ID (`U***1234`) is kept as written, and a blank received or processed date falls back to
the request date. Pending, rejected, cancelled and other open requests are skipped and counted.
An unknown status, changed headers, formulas, hidden sheets, duplicate references or a second
account reject the file. The literal cells of each row are kept in `raw_data` with the
`ibkr_funding_workbook_row` schema.

The Transaction History CSV reports the same movements in the statement base currency, with the
exchange rate it used. Reconciliation pairs the two exports in any order, so each movement is
recorded once (see [[#Cross-export imports]]). The 2026-10-20 removal of this format by ADR-236 is
reversed by its [[docs/adr/236-simplify-portfolio-import-reconciliation#Amendment: cross-export imports (2026-10-21)|amendment]].

The Saxo adapter accepts localized Transactions CSV exports and detailed XLSX workbooks. It
normalizes ordinary and non-breaking header spaces, reads Dutch and English trade actions, and
reduces `ticker:venue` cells to the ticker. `Bk Record Id` is the preferred immutable source ID;
zero placeholder IDs are not treated as transaction identities.

A Saxo CSV does not name its decimal separator, so the adapter reads it from the file: cells whose
two readings differ in validity (`-181.63`, `1.234,56`) prove a separator, and when they all prove
the same one, the whole file uses it, so `Koop 1,500 @ 20.00 USD` is 1500 units. A file without
that proof, or with both, reads each cell on its own, and a cell that still reads two ways
(`1,500`, `1.500`) stages as an unsupported row naming the value. A CSV trade whose units × price ×
`Omrekeningskoers` misses its booked amount by more than its costs plus 1 % (at least 1) also
stages as unsupported for review. Workbook actions are read in the separator that matches the
typed `Traded Quantity` and `Prijs`.

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
error directing the user to the detailed workbook, unless the workbook record of the same booking
is in the reviewed scope or already imported. It is not imported as gross income. Unknown
corporate actions and workbook booking kinds also remain review errors. Synthetic regression
coverage is in [[apps/node-backend/tests/saxoTransactionHistoryAdapter.test.ts]] and
[[apps/node-backend/tests/portfolioWorkbook.test.ts]].

A CSV and a detailed workbook of the same period can both be imported, in either order or
together, and overlapping periods are allowed; see [[#Cross-export imports]].

### Cross-export imports

[[apps/node-backend/src/services/portfolioImportCrossFormat.ts]] runs inside the reconciliation
plan. It recognises rows that another export of the same broker history already records, so
neither file double counts the other. It uses the reviewed scope, the settled rows of earlier
batches that still own a ledger transaction, and unowned manual cash.

| Pair | Matched by | Outcome |
| ---- | ---------- | ------- |
| Saxo CSV and XLSX in one review | account, source account and `Bk Record Id`; date, type, instrument, units and cash must agree | the CSV row is `duplicate_source`, the workbook row is recorded |
| Saxo CSV after the XLSX (or the reverse) | the same key against the earlier batch's ledger row | `duplicate` of the existing transaction |
| IBKR CSV and funding workbook in one review | type, account (masks allowed), CSV date within the request–completion window, native amount × CSV rate = base amount within 0.01 or 0.01 % | the CSV row is `duplicate_source`, the funding row is recorded in its own currency |
| IBKR CSV after the funding workbook | the same test against the funding row's ledger transaction | `duplicate` |
| IBKR funding workbook after the CSV | the same test against the CSV row's unedited ledger transaction | cash `adopt`: the transaction keeps its ID, comment and category and takes the native amount and currency |
| Any cash row and a manual entry | same account, currency and signed amount within seven days, entry without import fingerprint | cash `adopt` (exact date), or `policy_required` |

Only the Saxo CSV and XLSX trade fingerprints differ, because the CSV books instrument currency and
the workbook account currency; cash rows and IBKR rows already share fingerprints across files.
When several candidates are indistinguishable, rows pair by count; a partial overlap that cannot
be paired one to one blocks with `ambiguous_funding_history` or `ambiguous_cash_history` rather
than guessing. A Saxo pair that disagrees, or a CSV deposit edited after import, blocks with
`cross_format_source_conflict`: the edit is neither overwritten nor duplicated. Rows that no other
export records import normally, so a partial workbook only settles what it covers.

A near match never imports silently. An IBKR CSV movement whose type, account and native × rate
value match a funding movement, but whose date is up to ten days outside the request–completion
window, blocks with `funding_date_mismatch`. A Saxo CSV and XLSX row without a booking record id
on one side (the workbook always has one, since it joins its sheets on it) blocks with
`cross_format_identity_missing` when route, type, instrument, units, cash and date agree; a
deposit or withdrawal, which has no portfolio type, pairs by direction. Only the CSV's literal
`Bk Record Id` is that identity: a CSV row that keeps only a `Transactie-ID` or `Booking Id` uses
it for its own repeat imports, not to pair with the workbook. A committed CSV batch that kept no
source columns (an older import) cannot show which column its id came from: its id counts as the
booking record only when it equals the workbook row's record id and that record id is none of the
workbook row's own `Transactie-ID` or `Booking Id` values; otherwise the pair blocks as above. The
statement policy "Use detailed source facts" (`prefer_source`) resolves either by recording them as
one event, by the same outcome as the strict pair in the table above. A `funding_date_mismatch`
also resolves with "Preserve existing facts" (`preserve_existing`), which keeps both. A
`cross_format_identity_missing` row does not: keeping both could count one event twice, so a
statement-wide choice made for other rows never decides it. The owner answers that row in the
review instead: **Same transaction** records the pair once, and **Keep both** records both
without offering the other export's transaction as a likely copy again (with several look-alikes,
only **Keep both** applies). A repeat import of a paired row settles as a duplicate without asking
again.

Cash adoptions and corrections are written to the cash reconciliation journal and restored by
rolling back their batch. A CSV batch cannot be rolled back while a funding correction depends on
its transaction. Settled companion rows clear their error counters, and commit applies these
settlements before the readiness check.

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
instead of inserting when its economics remain unproven. A proven execution in another currency
does not establish an exchange rate.
A candidate is either unassigned or on the row's own account; a transaction on another account is
never the row's copy. An imported candidate whose source id differs from the row's, in the same
specialized export format, is a different event, so a regular same-size purchase (for example a
monthly plan) imports beside the earlier one. Ids of another export format, and ids from a generic
CSV mapping that different tools share, never rule a candidate out. Only an unassigned candidate without an import batch or fingerprint
can be adopted. A remaining assigned or imported candidate (`existing_assigned_or_imported_history`)
or an ambiguous match (`ambiguous_history`) blocks until the owner answers that row in the review:
**Keep both** (`keep_both`) records it as a new transaction, and **Same transaction**
(`same_transaction`, single candidate only) settles it as a duplicate of the existing one.
Conflicting per-batch policies remain blockers rather than choices made by a score. Source corrections additionally require proven economics and
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

A repeated source identity is a duplicate. An imported copy of a manual transaction is no longer
repaired; the owner resolves such a twin by hand.

Preview returns actions, blockers and counts. Commit locks the selected batches and their accounts
and rebuilds the plan from current history in the same transaction, so it adopts the history as it
stands at commit time. An existing transaction that changed or disappeared since planning rejects
the commit with `stale_existing_transaction`. ADR-236 removed the SHA-256 plan fingerprint and the
bounded scopes. Each adoption writes before/after snapshots into
`portfolio_import_reconciliation_journal` in the same transaction as the adoption. Receipts are
reversible domain evidence. The application only inserts receipts; since migration 0005, no
trigger enforces that.

After the locked complete projection passes, the reviewed writer drains source events in date, batch,
and row order. Custody writes use [[apps/node-backend/src/services/portfolio/portfolioCustodyImportScope.ts]]
to bind each approved event to the same transaction client and source signature. Each event allocates
lots from persisted history through its own date. This permits an earlier withdrawal and later return
to be inserted around an already recorded sale without treating the temporary partial timeline as
complete. Before commit, the writer validates complete persisted history for every affected custody
investment under all three basis methods and checks that every approved custody event retained its
exact source and financial facts. A changed event, invalid final history, or row failure rolls
back the entire selected scope. Ordinary custody writes still validate full history.

### Receipts written before ADR-236

The bounded scopes (attach, correct, record in-kind income, record cash) and duplicate repair are
removed. Receipts they wrote stay in their journals and are never rewritten:

- rolling back a batch restores adoptions from `portfolio_import_reconciliation_journal` after
  checking that each adopted transaction still matches its after-image
  (`adopted_transaction_changed` otherwise);
- paired income from `portfolio_import_income_recognition_journal` is closed by an inverse
  `restore` receipt before its rows are deleted; the `portfolio_income_active_pair_guard` trigger
  still protects those legacy pairs from direct edits;
- IBKR cash corrections and duplicate repairs are restored from their receipts, and the batches
  they depend on stay locked during rollback.

See [[apps/node-backend/src/services/portfolioImportLegacyReceipts.ts]].

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

Portfolio Performance XML upload and reference application are unavailable, and stored reference
evidence is no longer read for proof. The import UI accepts supported original broker CSV or Saxo
XLSX files. Historical transactions and their receipts are unchanged.

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

Tests: `tests/portfolioImportInstrumentlessCash.db.test.ts` (full pipeline, signs, configured categories, rollback, non-brokerage unchanged), `tests/brokerageRouting.test.ts` (D6 classification), `tests/portfolioImportCommit.test.ts` (pinned cash INSERT SQL + D6 sign/configured-active-category params).

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

The fingerprint includes currency, so a Saxo CSV trade in instrument currency and its XLSX
representation in account currency have different fingerprints. The cross-export planner pairs
them by booking record instead ([[#Cross-export imports]]); both representations can be imported.

Rollback removes batch-owned trades, cash rows, and custody events, restores adopted trades, and
reverses duplicate repairs applied before ADR-236 from their journal snapshots. An adopted transaction must still equal its recorded after-image;
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
- POST/PATCH bodies and stored rows share one schema per kind (`lib/parserConfigSchema.ts`). The
  repository re-checks each stored config on read as a data contract
  ([[docs/adr/193-zod-runtime-contracts|ADR-193]]).

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

`PortfolioImportSession` accepts up to 100 maintained CSV, Saxo XLSX or IBKR funding XLS/XLSX
statements. A detected funding workbook stages with its own parser and hides the asset scope
field. Blocked cross-export rows show their reason in the review. It detects each
source and automatically chooses an account only when one candidate is unambiguous. Each statement
can set an account, transfer counterpart, and policy override; a global adoption policy applies to
statements without an override. Nexo's other-custody-account control configures both incoming origin
and outgoing destination. Kinesis's control configures the outgoing destination.

Files stage sequentially through the existing POST SSE upload. Each returned batch ID is saved
before preview loading; stopping waits for the current upload to finish and retains its batch.
Only staged batch metadata is kept in tab-scoped `sessionStorage`, never file bytes. Restaging
retains earlier batch IDs visibly. Staging alone creates no history.

The combined review displays actions, existing/source values, corrections, policy, transfer
units/fees/accounts, adjustment kind/basis policy and the income role of in-kind income.
Configuration changes invalidate review. Commit requires a ready plan for the current complete
scope. Unknown or malformed commit outcomes are shown as unverified. The session does not prove
that supplied exports contain every historical trade or that an order timestamp is an execution
timestamp.

There is one full-history review. ADR-236 removed the scope selector, the cash funding
confirmation and the existing-batch picker. Kinesis uploads always send
`yield_basis_policy='zero'`. A session stored by an older version that included an existing batch
restores without it. Complete sessions clear the queued metadata.

### Single-file upload and mapping layout

The upload page starts with a CSV/XLSX/XLS dropzone and **Detect automatically** selected. Header
signatures select IBKR, IBKR funding history, Kinesis, Nexo wallet, Nexo Pro or Saxo only when one
signature matches. Detection reads the complete file within the 50 MiB upload limit, so CSV account selection includes
all records rather than a preview prefix. Malformed CSV quotes fail instead of being repaired.
Workbook detection first reads the file with SheetJS and recognises the IBKR funding workbook
(its exact Deposit/Withdrawal headers, literal text cells, no formulas or hidden sheets, one
account), then requires one maintained Saxo header signature for other XLSX files; unsupported or
unreadable workbooks disable upload. The server independently enforces the workbook contract. Unknown CSVs remain available for custom mapping. Automatic detection is a
frontend convenience; API callers supply the required mapping fields and `portfolio_format` only for specialized adapters.

Account selection first tries one exact exported account identity against active broker account
names or display names, then one recognized broker institution/name. Multiple source accounts or
ambiguous candidates remain unassigned for explicit selection. An automatically chosen account is cleared if a later account-list update makes the match
ambiguous or unavailable. Explicit manual choices are preserved for the current file. Replacing a
file clears its automatic preset/account, and stale detection results cannot apply to the new file.
Saved parsers and explicitly chosen presets retain their reusable settings across uploads.
The multi-statement session stages Kinesis yield units with explicit zero basis; their literal
income is recorded with the in-kind role. Other broker presets and the backend's default yield
policy are unchanged.

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
| `PortfolioImportSession`   | Stages multiple maintained statements and reviews one full-history reconciliation plan  |
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
- Included in the whole-database `pg_dump` backup

**`portfolio_import_staging_rows`** — mirrors `import_staging_rows` with portfolio-shaped columns:

- `type`, `symbol`, `name`, `units`, `price`, `amount`, `fees`, `taxes`, `currency`, `fx_rate`
- `resolved_investment_id` FK → investments (set by matchInvestments phase)
- `user_override_investment_id` FK → investments (set by investment-override endpoint)
- `match_source` TEXT (`symbol` | `name_exact` | `NULL` when unresolved)
- `route`: cash, portfolio, asset transfer, asset adjustment, or account-internal annotation
- `asset_transfer_details` JSON retains direction, gross/fee units, and basis status (migration 0121)
- `asset_adjustment_details` JSON retains adjustment kind, account, basis policy, and eligible yield hashes (0123)
- Included in the whole-database `pg_dump` backup

Migrations 0120–0123 add immutable adoption/duplicate-repair receipts, the dated custody ledger,
and the adjustment ledger with restrictive source links. All new tables are backup-covered and
have guarded downgrade conditions; upgrading does not rewrite existing holdings. See [[docs/reference/data-model|Data Model Reference]] for field-level schema and
[[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|ADR-177]] for recovery limits.

Migration 0124 adds the default `standard` income role and an empty paired-income receipt journal;
it does not create income history or rewrite prior financial values or receipt JSON. Migration 0125 adds source-owned brokerage cash origin and typed source receipt protection; it
creates no cash records or transfer peers during upgrade.
These historical Alembic migrations (0120–0128) are part of `db/migrations/0001_baseline.sql`
([[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]). See
[[docs/guides/migrations|Database Migration Guide]] and
[[docs/adr/188-proved-in-kind-income-recognition|ADR-188]].

Migration 0005 (`0005_simplify_portfolio_reconciliation`) drops seven receipt-guard triggers and
their functions. It drops no table, column or row; the custody ledger triggers and the active
income-pair guard stay. Its down migration recreates the triggers from the baseline. See
[[docs/adr/236-simplify-portfolio-import-reconciliation|ADR-236]].

---

## Related

- [[docs/features/index|Features Index]]
- [[docs/api/portfolio-imports|Portfolio Imports API]] — full endpoint reference
- [[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|ADR-177: Reviewed reconciliation and dated custody]]
- [[docs/adr/236-simplify-portfolio-import-reconciliation|ADR-236: Simplify portfolio import reconciliation]]
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

A statement may be staged with comma-separated asset symbols. Empty scope imports the whole statement. The original file and literal source records are retained. Unselected parsed rows are outside the batch; their count is saved as `custom_config.scope_excluded_rows`, separately from parsing errors. Cash legs are included only when their literal record also has a selected asset leg. Unknown selected symbols reject staging. Changing the scope invalidates the staged review and requires staging again.

Complete same-day Kinesis withdrawal groups may cover separate net transfers and repeated fee deliveries with up to 0.0000001 unit of rounding per entry; the broker quantities and fees remain unchanged. Additional or materially different fee deliveries block review.

Weighted-average custody allocation assigns the final eligible lot the exact remaining requested units. This prevents Decimal proportional-allocation residuals from falsely blocking a later fee that consumes the exact wallet remainder; real unit overdraws remain rejected.

## File selection presentation

Portfolio import uses the shared page header and a full-width file drop zone. The same accessible
file input supports browsing or dropping multiple accepted statement files; account selection,
review, reconciliation and commit retain their existing staged workflow. Plain-language labels
explain those steps without changing batch statuses or review requirements.
