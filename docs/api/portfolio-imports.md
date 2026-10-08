---
title: API - Portfolio Imports
type: endpoint
method: POST, GET, PATCH, DELETE
path: /api/portfolio/import
description: Portfolio CSV/Saxo XLSX staging, reviewed reconciliation, immutable receipts, and dated custody/unit adjustments with original basis
date: 2026-10-08
updated: 2026-10-08
last_modified: 2026-10-08
tags:
  [
    api,
    portfolio,
    import,
    csv,
    xlsx,
    portfolio-import,
    portfolio-parser,
    brokerage,
    trades,
    review,
    adr-078,
    account-id,
    adr-091,
    migration-0057,
  ]
status: active
aliases: [portfolio-imports-api, portfolio-csv-import, brokerage-import]
related_code:
  - "apps/node-backend/src/routes/portfolioImportRoutes.ts"
  - "apps/node-backend/src/routes/importBatchRoutes.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/index.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/stage.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/validate.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/matchInvestments.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/commit.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/ibkrTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioIbkrPrimaryProof.ts"
  - "apps/node-backend/src/services/portfolioIbkrRepairCandidates.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/kinesisTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/nexoTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/nexoProTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportReconciliationService.ts"
  - "apps/node-backend/src/services/portfolioKinesisYieldGroups.ts"
  - "apps/node-backend/src/services/portfolioImportDuplicateRepairService.ts"
  - "apps/node-backend/src/repositories/portfolioImportDuplicateRepairRepository.ts"
  - "apps/node-backend/src/repositories/portfolioImportReconciliationRepository.ts"
  - "apps/node-backend/src/services/portfolio/portfolioAssetTransferService.ts"
  - "apps/node-backend/src/services/portfolio/portfolioAssetAdjustmentService.ts"
  - "apps/node-backend/src/repositories/portfolioAssetAdjustmentRepository.ts"
  - "apps/node-backend/src/services/portfolioPerformanceReferenceEvidence.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportBatchService.ts"
  - "apps/node-backend/src/services/portfolioImportCommitService.ts"
  - "apps/node-backend/src/services/portfolioImportReadinessService.ts"
  - "apps/node-backend/src/repositories/portfolioImportBatchRepository.ts"
  - "apps/node-backend/src/services/customParserConfigService.ts"
  - "apps/node-backend/src/lib/portfolioUpload.ts"
  - "apps/node-backend/src/services/portfolio/fxResolve.ts"
  - "apps/frontend/src/pages/portfolio/PortfolioImportPage.tsx"
  - "apps/frontend/src/pages/portfolio/PortfolioImportSession.tsx"
  - "apps/frontend/src/pages/portfolio/portfolioImportDetection.ts"
  - "apps/frontend/src/pages/portfolio/PortfolioImportReviewPage.tsx"
  - "apps/frontend/src/features/imports/PortfolioCsvColumnMapper.tsx"
  - "apps/frontend/src/lib/api/portfolioImports.ts"
  - "apps/frontend/src/hooks/usePortfolioParserConfigs.ts"
---

# Portfolio Imports API

## Overview

The Portfolio Imports API accepts CSV history and detailed Saxo XLSX workbooks. It imports trades
into `portfolio_transactions`, routes brokerage cash to `transactions`, and stores dated custody
events in `portfolio_asset_transfers` and unit removals in `portfolio_asset_adjustments`. Reviewed
adoption keeps the original transaction ID. Previously stored Portfolio Performance context remains secondary
staging evidence. The API is parallel to budgeting import (`/api/import`) and uses stage, validate,
match, review, and commit phases.

Exact source records remain internal staging provenance. Versioned occurrence fingerprints provide
race-safe duplicate identity across generic and built-in adapters and are not exposed in API
responses. See [[docs/adr/134-versioned-import-identity-and-exact-provenance|ADR-134]].

The import path provides a generic user-configured mapper plus built-in IBKR, Kinesis Money, Nexo
wallet, Nexo Pro, and Saxo transaction-history formats with format-specific regression fixtures.
Source support does not establish completeness of the supplied historical exports.
Kinesis Money import is distinct from Vision's existing Kinesis market-price provider. Users may
configure other broker mappings, but those formats are not maintained compatibility targets.

All routes are mounted at `/api/portfolio/import` with `importRateLimiter`.

> [!info] Auto-commit policy
> Non-brokerage generic imports auto-commit (return 201) only when there are zero errors, unresolved
> rows, or name matches. Exact symbol and explicit provider-alias matches use `match_source='symbol'`.
> Every maintained preset is a brokerage import
> and always enters `awaiting_review` (return 202), even when every symbol matches exactly.

---

## Upload Endpoints

### POST /api/portfolio/import/csv/custom

One-shot portfolio history import. The existing endpoint path accepts CSV and supported Saxo XLSX.
It runs the pipeline synchronously and returns 201 if committed or 202 if review is required.

Every mapping, adapter, format, brokerage, and account option is accepted only as a multipart
field. Query fields are ignored. This is a breaking request-contract change under
[[docs/adr/136-same-release-http-import-and-navigation-contract|ADR-136]].

**Content-Type:** multipart/form-data

**Form Data:**

| Field                             | Type    | Required | Description                                                                                                                                                                                 |
| --------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`                            | File    | Yes      | CSV or detailed Saxo XLSX file (max 50 MiB); XLSX requires `portfolio_format=saxo_transaction_history`                                                                                      |
| `adapter_name`                    | string  | No       | Display label for the import source (written as `bank_account` on portfolio_transactions)                                                                                                   |
| `portfolio_format`                | string  | No       | Specialized parser: `ibkr_transaction_history`, `kinesis_transaction_history`, `nexo_transaction_history`, `nexo_pro_spot_history`, or `saxo_transaction_history`. Omit for generic mapping |
| `date_format`                     | string  | No       | Python strptime format; default `%Y-%m-%d`                                                                                                                                                  |
| `separator`                       | string  | No       | Single-character CSV delimiter; default `,`                                                                                                                                                 |
| `encoding`                        | string  | No       | File encoding; default `utf-8`                                                                                                                                                              |
| `skip_rows`                       | integer | No       | Header rows to skip; default `0`                                                                                                                                                            |
| `date_column`                     | string  | Yes      | CSV header name for the trade date                                                                                                                                                          |
| `type_column`                     | string  | No       | CSV header name for the transaction type (buy/sell/dividend/…)                                                                                                                              |
| `symbol_column`                   | string  | No*      | CSV header name for the ticker symbol                                                                                                                                                       |
| `name_column`                     | string  | No*      | CSV header name for the instrument name                                                                                                                                                     |
| `units_column`                    | string  | No       | CSV header name for number of units                                                                                                                                                         |
| `price_column`                    | string  | No       | CSV header name for unit price                                                                                                                                                              |
| `amount_column`                   | string  | No       | CSV header name for total amount                                                                                                                                                            |
| `fees_column`                     | string  | No       | CSV header name for transaction fees                                                                                                                                                        |
| `taxes_column`                    | string  | No       | CSV header name for taxes/withholding                                                                                                                                                       |
| `currency_column`                 | string  | No       | CSV header name for trade currency                                                                                                                                                          |
| `fx_rate_column`                  | string  | No       | CSV header name for EUR FX rate                                                                                                                                                             |
| `note_column`                     | string  | No       | CSV header name for a free-text note                                                                                                                                                        |
| `source_id_column`                | string  | No       | CSV header for the literal provider event ID; trimmed, maximum 200 characters; blank or omitted leaves the mapping absent                                                                   |
| `source_account_column`           | string  | No       | CSV header for the literal provider account identity; trimmed, maximum 200 characters; blank or omitted leaves the mapping absent                                                           |
| `default_asset_class`             | string  | Yes      | Fallback asset class: `stock` `etf` `crypto` `metals` `real_estate` `savings` `bond`                                                                                                        |
| `default_type`                    | string  | No       | Fallback transaction type when no `type_column` is mapped (default `buy`): `buy` `sell` `dividend` `fee` `tax` `interest`                                                                   |
| `type_mapping`                    | string  | No       | JSON object mapping raw CSV type strings → canonical portfolio_txn_type values (e.g. `{"Koop":"buy","Verkoop":"sell"}`)                                                                     |
| `is_brokerage`                    | boolean | Format*  | Must be `true` for every maintained transaction-history format so portfolio and cash effects use brokerage routing                                                                          |
| `transfer_destination_account_id` | integer | No       | Distinct active portfolio account receiving outgoing Nexo/Kinesis custody transfers; required to commit those rows                                                                          |
| `transfer_origin_account_id`      | integer | No       | Distinct active portfolio account providing original lots for incoming Nexo crypto top-ups                                                                                                  |
| `included_symbols`                | string  | No       | Comma-separated exact adapter symbols for an explicit partial import; excluded rows are recorded separately in batch configuration, and parse errors remain errors                          |
| `yield_basis_policy`              | string  | No       | Literal `zero`; explicit Kinesis zero-yield basis interpretation, never selected by omission                                                                                                |
| `account_id`                      | integer | Format*  | Active broker account receiving every row; required with `is_brokerage` and for each maintained transaction-history format                                                                  |

> [!warning] Symbol or name required
> At least one of `symbol_column` or `name_column` must be provided. Both may be mapped simultaneously for best matching.

The optional source columns map to `custom_config.column_mapping.source_id` and
`source_account` for generic uploads. They preserve literal provider identity separately from
Vision account routing. Unmapped columns, including `Receipt_JSON`, remain in the primary raw
CSV record. These parameters are additive; existing omitted mappings remain unchanged.

Saved portfolio parser configurations accept optional `yieldBasisPolicy: "zero"`; invalid values
reject, and absence retains the existing interpretation.

Generic uploads accept optional `number_format`: `auto` (default), `decimal_dot`, or
`decimal_comma`, independent of `separator`. Saved parser configurations retain
`config.number_format`; missing values use `auto`. Every mapped generic numeric field uses it.
Ambiguous old inputs such as `1,234` now reject the entire file with 400 before staging instead
of guessing. Select an explicit format and retry. The diagnostic names the data-row ordinal and
column without the numeric value. Maintained preset numeric rules remain unchanged.

`skip_rows` counts physical lines before the header. Encoding choices include UTF-8
(`utf-8`/`utf8`), Latin-1 (`latin1`/`latin-1`/`iso-8859-1`), and true `windows-1252` decoding.
Unsupported encodings return 400. See [[docs/features/portfolio-import]].

The upload filter accepts CSV and XLSX filename/MIME combinations. After temporary upload, byte
inspection identifies ZIP workbooks independently of the temporary filename. XLSX requires the
Saxo format and a valid detailed workbook before any batch is created. Legacy XLS rejects. Bank
CSV upload endpoints are unchanged.

Workbook parsing limits are 1,000 ZIP entries, 100 MiB expanded content, and 500,000 parsed cells.
Archive validation rejects duplicate names, encrypted entries, unsupported layouts or compression,
inconsistent expansion sizes, and archives without workbook XML. Files are not extracted; macros,
formulas, and external links are not executed or followed. Invalid workbook structure, unsafe
numeric identifiers, or inconsistent accounting details return 400 with structural diagnostics.

Adding Saxo XLSX support is an additive request-contract change: endpoint paths, multipart field
names, and response shapes remain unchanged. Saxo CSV net-only dividends now require the detailed
workbook and stage review errors instead of being accepted as gross income.

The IBKR preset supplies the compatibility mapping fields but parses the multi-section statement
with format-specific rules. Each accepted `Transaction History,Data` record is retained literally
in the batch staging row's `raw_data` provenance field, including the source CSV quoting and column
order. `Forex Trade Component` records increase the returned `skipped` count; they are not imported
as currency holdings or cash movements. This is an additive, non-breaking API option. Existing
generic requests are unchanged.

Fresh IBKR batches retain `ibkr_source_context` in batch configuration: the literal transaction
header and Summary base-currency record, ordered columns, file hash and transaction-record hashes.
Repeated headers/base-currency records or blank/duplicate trimmed columns reject before staging;
valid reordered headers remain supported. Missing retained context is not reconstructed by guessing.

IBKR Transaction History requests are rejected before staging unless `is_brokerage=true` and a
valid `account_id` are supplied. This prevents deposit and withdrawal rows from entering the
portfolio-only route without a cash ledger destination.

The Kinesis preset accepts the exact 18-column Transactions statement schema. Kinesis emits one
row per currency leg, so the adapter groups `Trade` rows by `Order_ID`, identifies the base asset
from `Currency_Pair`, and emits one buy/sell plus one instrument-less quote-currency cash movement.
Direction comes from the exported starting and closing balances. Asset-denominated trade fees are
converted at `Trade_Price`; the trade gross amount remains derived from units and price, while the
cash row uses the actual quote balance movement.

Kinesis holder and velocity distributions emit linked dividend income at exported `Trade_Value`
and gifted units. Their default basis is that value. Explicit `yield_basis_policy='zero'` instead
marks yielded units as source-proven zero-basis acquisitions while retaining the income. The same
policy resolves positive holder distribution adjustments as zero-basis yield units. Without it,
positive adjustments and asset deposits retain unresolved original basis; an export valuation
cannot establish purchase cost. `C1USD` valuation cells normalize to `USD`.

Fiat deposits, withdrawals, and card payments have blank symbols and route to the cash ledger.
Asset withdrawals validate gross units against received units plus same-asset fees and stage dated
custody events requiring explicit `transfer_destination_account_id`. A negative holder adjustment
requires explicit zero policy, a consistent literal amount/balance delta, and enough remaining
eligible yielded units. It stages `asset_adjustment` with null financial type. Other negative
adjustments remain review errors. Actual `source_columns` are retained in batch configuration for
safe literal-record reparsing. Neither custody nor adjustment invents a sale. When review creates an unresolved holding, KAU and KAG are
inferred as `metals`; other Kinesis asset codes use the preset's `crypto` fallback so a mixed export
does not create BTC as a metal. Kinesis-created holdings use USD as their valuation currency even
when the selected source row is an asset deposit with no quote currency.

Full review can select the complete original Kinesis statement together with a complete generic
source receipt CSV. Verified native sender fees use `asset_fee` with carried original basis;
`asset_transfer_witness` retains owned transfer evidence for a unique broker deposit without
creating another movement. A closed group of exactly two distinct incoming native gift receipts,
each bound to literal recorded native basis, can attach one qualified existing manual gift and
insert only the missing gift. This group association does not infer an individual legacy identity.
The existing gift keeps its financial values, date, type, units, note and FX. Strict repeats require
both owned group members and unchanged after-images; incomplete or contested evidence blocks.
This path does not authorize new cash in full history.

Kinesis Transaction History requests have the same pre-staging brokerage-account requirement as
IBKR. This is an additive, non-breaking API option; generic and IBKR requests are unchanged.

The Nexo preset accepts the 11-column Transaction history export. Explicitly rejected records
increase `skipped`. Approved same-fiat wrapper events pair `Deposit To Exchange` with `Exchange
Deposited On`, or `Exchange To Withdraw` with `Withdraw Exchanged`. Pairing requires a unique
match in both directions, compatible amounts and underlying fiat, the same UTC date, and no more
than 30 minutes between records. A primary produces one instrument-less cash principal and an
additional fee row when present; the paired companion is skipped and both literal records remain
in provenance. Approved zero-output deposits use their positive input principal. Withdrawal input
must equal output plus fee. Missing or ambiguous companions and inconsistent fees remain errors.

Other cash-like-to-asset conversions become buys; asset-to-cash-like
conversions become sells. Conversion values use `USD Equivalent` for a stable valuation currency.
Conversions without one unambiguous cash-like side remain review errors. A non-zero fee outside USD
also remains a review error because the adapter cannot value it safely. Asset-denominated interest
produces linked income and gifted-unit rows. Approved fiat interest requires equal input/output
principal in the same underlying fiat, positive principal, and zero fee. It produces one
instrument-less `Interest` row in the original underlying fiat currency, with no acquired portfolio
units or USD-equivalent conversion. Unresolved approval, principal, or fee evidence blocks review.
Approved fee-free crypto top-ups use `transfer_origin_account_id` when supplied and carry original lots from that account. Without a
known origin they have unresolved basis and require supported reconciliation with original history.
Asset withdrawals use an explicit `transfer_destination_account_id` and consistent gross/received/
fee units. Same-asset, equal-unit, fee-free Wallet/Pro movements stage account-internal annotations;
review requires companion Pro trade history in the selected scope or an already complete Pro batch.
That check does not prove every Pro execution is present. Other incomplete conversions remain errors.

The Nexo Pro preset accepts the exact ordered 14 headers from spot order history. Literal records
and `orderId` are retained; filled units, executed price, and explicit fees determine economics.
Cancelled partial fills import; unfilled cancellations with zero execution fee skip. Fiat quotes
are supported. Base-asset fees reduce buy units or increase sell units and are valued at the
executed price; quote-asset fees remain separate. Crypto quotes, third-asset fees, non-final states,
changed headers, missing/duplicate IDs, and invalid timestamps reject or remain unsupported.
The calendar date comes from the literal exported timestamp prefix without a host timezone shift.
It is an order-history aggregate, not verified individual-fill or execution-time evidence. Source
timestamp semantics and history completeness must be established separately.

The Saxo preset accepts localized Transactions CSV and detailed XLSX. It normalizes ordinary and
non-breaking header spaces and reduces `ticker:venue` symbols to the ticker. `Bk Record Id` is
preferred for source identity; zero placeholders are ignored. CSV trades retain quoted units and
price in `Instrumentvaluta`, with account costs converted using `Omrekeningskoers`. CSV dividends
contain only net bookings and therefore stage errors that direct the user to the detailed workbook.

Selecting the matching detailed workbook in the same scope can prove those CSV events as
`duplicate_source` evidence. The proof requires captured actual CSV header order, literal hashes,
unique nonzero source identity, agreeing financial/date/instrument cells, complete workbook joins,
and the same Vision account. Missing or conflicting evidence blocks; CSV-only dividends remain errors.
Commit clears only proved companion errors and updates their counters atomically, without creating
CSV financial records or changing their retained net amounts and unsupported dividend fields.

The XLSX adapter requires `Transacties`, `_Transacties`, and `Bookings` sheets and joins them by
account and booking-record ID. It validates metadata, identifiers, execution quantities/prices,
booking signs, and agreement between detailed bookings and the net amount within one cent.
Workbook trades use account-currency booked principal, effective unit price, separate commission,
and exchange tax. Dividends use gross booking income and aggregate withholding tax. Embedded FX
conversion costs are not added again. Native quotes and joined booking records remain in internal
typed provenance with sheet/row coordinates and a source-byte hash. Deposits and withdrawals are
instrument-less cash rows. Unknown corporate actions or booking kinds remain review errors.

Nexo wallet, Nexo Pro, and Saxo requests have the same pre-staging brokerage-account requirement as IBKR and
Kinesis. These maintained format options are additive. Generic mapping remains available.

**201 Response — committed:**

```json
{
  "ok": true,
  "data": {
    "batch_id": 42,
    "total": 150,
    "imported": 148,
    "duplicates": 1,
    "errors": 1
  }
}
```

**202 Response — awaiting review:**

```json
{
  "ok": true,
  "data": {
    "batch_id": 43,
    "requires_review": true,
    "skipped": 15,
    "match_source_counts": {
      "symbol": 120,
      "name_exact": 15,
      "unresolved": 10,
      "error": 5
    }
  }
}
```

---

### POST /api/portfolio/import/csv/stream

SSE-streaming portfolio history import. Accepts the same CSV/Saxo XLSX request body as the custom
endpoint. Workbook preflight happens before streaming, so invalid input returns an HTTP 400
rather than creating a batch. Valid input uses the existing progress and terminal events.

**Response:** `text/event-stream`

```
event: progress
data: {"phase":"staging","current":50,"total":150,"percent":13}

event: progress
data: {"phase":"validating","current":150,"total":150,"errors":0,"percent":55}

event: review_required
data: {"batch_id":43,"skipped":15,"match_source_counts":{"unresolved":10},"percent":70}

event: complete
data: {"batch_id":"42","total":150,"imported":148,"duplicates":1,"errors":1}

event: error
data: {"detail":"date_column is required","code":"VALIDATION_ERROR"}
```

Progress percent mapping:

- `staging` → 0–40 %
- `validating` → 40–55 %
- `matching` → 55–70 %
- `committing` → 70–100 %

---

## Saved Parser Endpoints

Portfolio parser configs reuse the `custom_parser_configs` table with `kind = 'portfolio'`. The uniqueness constraint is `(name, kind)`, so a transaction parser and a portfolio parser may share the same name.

The camelCase `config` object may include optional `accountId`, a positive integer naming the
file-level broker destination. It is stored in the existing JSONB payload. Upload validates that it
still references an active brokerage, wallet, or crypto-exchange account before staging.

> [!warning] Parser `:id` contract (2026-08-11 — breaking for malformed ids)
> `PATCH` and `DELETE /api/portfolio/import/parsers/:id` accept **only** a plain base-10 integer in 1..2,147,483,647; anything else is `400 VALIDATION_ERROR` (`"Invalid parser config id"`) before any repository call. Both operations share `registerParserRoutes` with the [[docs/api/imports|transaction parser routes]], which had the same defect: no `validateIdParam`, and a `parseInt` guarded only by `Number.isNaN`, so `DELETE /parsers/22abc` answered **`204` having deleted parser 22**. Full accept set: [[docs/security/input-validation#validateIntParam|Input Validation]].

### GET /api/portfolio/import/parsers

List all saved portfolio parser configurations. Collection GETs use the
canonical `{items, total}` body; this list is unpaginated, so `total` is the
row count.

**Response:**

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 5,
        "name": "My Broker Trades",
        "config": {
          "accountId": 7,
          "dateFormat": "%d-%m-%Y",
          "separator": ",",
          "encoding": "utf-8",
          "skipRows": 0,
          "defaultAssetClass": "stock",
          "defaultType": "buy",
          "typeMapping": {},
          "dateColumn": "Date",
          "symbolColumn": "Symbol",
          "unitsColumn": "Quantity",
          "priceColumn": "Price",
          "amountColumn": "Value",
          "feesColumn": "Transaction and/or third party costs"
        },
        "created_at": "2026-06-15T10:00:00Z",
        "updated_at": "2026-06-15T10:00:00Z"
      }
    ],
    "total": 1
  }
}
```

---

### POST /api/portfolio/import/parsers

Create a new saved portfolio parser configuration.

**Request Body:**

```json
{
  "name": "My Broker Trades",
  "config": {
    "accountId": 7,
    "dateFormat": "%d-%m-%Y",
    "separator": ",",
    "defaultAssetClass": "stock",
    "dateColumn": "Date",
    "symbolColumn": "Symbol",
    "unitsColumn": "Quantity"
  }
}
```

The batch preview response includes `account_id`, `account_name`, and `account_valid` alongside the
existing groups and totals. Clients disclose the destination before commit. When `account_valid` is
false, the reviewed batch must be repointed to an active portfolio account rather than silently
committed as Unassigned.

**Responses:**

| Status         | Meaning                                          |
| -------------- | ------------------------------------------------ |
| `201 Created`  | Parser created; body contains the record         |
| `409 Conflict` | A portfolio parser with that name already exists |

---

### PATCH /api/portfolio/import/parsers/:id

Update an existing saved portfolio parser. Both `name` and `config` are optional.

**Responses:**

| Status            | Meaning                                                    |
| ----------------- | ---------------------------------------------------------- |
| `200 OK`          | Parser updated                                             |
| `400 Bad Request` | Malformed `id` (see the `:id` contract above)              |
| `404 Not Found`   | No portfolio parser with that id                           |
| `409 Conflict`    | Another portfolio parser already uses the requested `name` |

---

### DELETE /api/portfolio/import/parsers/:id

Delete a saved portfolio parser.

**Responses:**

| Status            | Meaning                                       |
| ----------------- | --------------------------------------------- |
| `204 No Content`  | Deleted successfully                          |
| `400 Bad Request` | Malformed `id` (see the `:id` contract above) |
| `404 Not Found`   | No portfolio parser with that id              |

---

## Batch Endpoints

### GET /api/portfolio/import/batches

List portfolio import batches, newest first.

**Query Parameters:**

- `limit` (integer, optional) — max rows to return (default 50, clamped to 200)
- `offset` (integer, optional) — pagination offset (default 0)

**Response:** canonical paginated collection body — `{ items, total, limit, offset }`.

---

### GET /api/portfolio/import/batches/:id

Get a single portfolio import batch with full status and row counts.

---

### DELETE /api/portfolio/import/batches/:id

Rollback a settled or review-waiting batch under its batch lock. The service removes batch-owned
trade/cash/custody/adjustment rows and restores adopted transactions from immutable receipts.
Adjustment removal cascades its evidence links; `deleted` counts canonical rows, not link rows. Adopted rows
must still equal their journal after-images. The full projected remaining history must preserve
custody/adjustment continuity and avoid a new or worsened partition oversell. A later sale,
transfer, or yield reversal can
therefore prevent removal of an earlier source acquisition. The original adopted ID and notes
survive; restore receipts append rather than mutating adoption receipts. Duplicate-repair rollback
also restores the removed imported ID/timestamps, original staging pointers/statuses, and counters.
Every recorded after-image is checked first; changed provenance returns `duplicate_repair_changed`.
Repair rollback adds integer `restored` and `restored_imported` counts to the usual `{ deleted }`
response. Normal rollback retains its earlier response shape.

| Status            | Meaning                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `200 OK`          | Rollback completed; body reports `{ deleted }`                                                                         |
| `400 Bad Request` | Malformed id, aborted batch, or batch still in progress                                                                |
| `404 Not Found`   | Batch disappeared or does not exist                                                                                    |
| `409 Conflict`    | Adopted/repair history changed or removal would break a later custody, adjustment, or sale dependency; nothing changes |

Journal, custody, adjustment, and yield-source foreign keys retain referenced batches/staging rows.
Guarded schema downgrade
requires application rollback first; see [[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger]].

---

## Review Endpoints

When the pipeline detects unresolved instruments (symbol not found in `investments`) it leaves the batch in `awaiting_review` and the SSE stream emits a `review_required` event. These endpoints let the client inspect, assign instruments, and commit.

> [!warning] Batch/row id contract (2026-08-11 — breaking for malformed ids)
> Every `:id` and `:rowId` on `/api/portfolio/import/batches/*` accepts **only** a plain base-10 integer in 1..9,007,199,254,740,991 (`portfolio_import_batches.id` and `portfolio_import_staging_rows.id` are `BIGSERIAL`, so the ceiling is _not_ `int32`). Anything else returns `400 VALIDATION_ERROR`.
>
> These ids were parsed with a bare `Number()`, which silently addressed a **different batch** on `"0x10"` → 16, `"1e3"` → 1000 and `"9007199254740993"` → …992, and additionally accepted `"+5"`, `" 12 "` and `"12.0"`. The parser now delegates to the shared `validateId` (`lib/importBatchIds.ts`, shared with the transaction import router). Clients sending plain integers are unaffected. Full accept set: [[docs/security/input-validation#coercedIdSchema (import batch/row ids)|Input Validation]].
>
> As of 2026-08-22, `openapi.yaml` publishes these path parameters as `integer` / `int64` with the same positive safe-integer range. Generated TypeScript clients therefore expose `id` and `rowId` path arguments as `number`, matching runtime validation and the shipped frontend callers. This is a breaking schema correction for external spec consumers that generated string-valued path arguments; runtime behavior did not change. `PortfolioImportBatch.id` in batch list/detail responses remains a string because node-postgres returns raw `BIGINT` values as strings at that repository boundary.

### GET /api/portfolio/import/batches/:id/preview

Returns staging rows grouped by investment (or by distinct raw symbol/name for unresolved rows).

**Response envelope `data`:**

| Field                                                                       | Type             | Description                                                                                                                                                   |
| --------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batch_id`                                                                  | number           | Positive safe-integer batch identifier                                                                                                                        |
| `groups[]`                                                                  | array            | One entry per resolved investment, case-insensitive unresolved raw symbol/name, or the shared cash group                                                      |
| `groups[].is_cash`                                                          | boolean          | `true` for brokerage cash rows, which never require a holding                                                                                                 |
| `groups[].investment_id`                                                    | `number \| null` | Matched or overridden investment. `null` = unresolved.                                                                                                        |
| `groups[].investment_name` / `investment_symbol` / `investment_asset_class` | strings or null  | Resolved holding metadata                                                                                                                                     |
| `groups[].raw_symbol` / `raw_name`                                          | strings or null  | First raw instrument identity for unresolved groups; null for cash                                                                                            |
| `groups[].row_count`                                                        | integer          | Number of staging rows in the group                                                                                                                           |
| `groups[].rows[]`                                                           | array            | Per-row status, route, date, type, raw instrument, units, price, amount, fees, taxes, currency, FX rate, note, match source, `error_message`, and override id |
| `totals`                                                                    | object           | `{symbol, name_exact, unresolved, error}` row counts; error rows count only as errors                                                                         |

---

### POST /api/portfolio/import/batches/:id/rows/:rowId/investment-override

Resolve an unmatched non-cash staging row by linking it to an existing investment or requesting that a new investment be created. Rows with `route='cash'` return `404`; assigning an investment would be a silent no-op at commit.

**Request Body:**

```json
{ "investment_id": 12 }
```

or

```json
{ "create_new": true }
```

When `create_new: true`, a new investment record is created from this row's `symbol` / `name` / `default_asset_class` and linked to this row. The review page uses the group endpoint below when resolving a complete symbol/name group.

`investment_id: null`, or an absent field, clears the override (200). A present value must be a positive integer; it is validated with `validateId`, not coerced, so `"1e3"` is a **400** rather than a link to investment 1000 (see [[docs/security/input-validation#FK ids in write bodies (`parseOverrideId` and the zod FK fields)|input validation]]).

**Responses:**

| Status            | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `200 OK`          | Override applied; body contains the updated row                                  |
| `400 Bad Request` | Malformed batch id, row id or `investment_id`, or `create_new` validation failed |
| `404 Not Found`   | Batch or staging row not found                                                   |

---

### POST /api/portfolio/import/batches/:id/rows/investment-override

Resolve a complete review group with one atomic request instead of one request per staging row.

**Request Body:**

```json
{ "row_ids": [101, 102, 103], "investment_id": 12 }
```

or:

```json
{ "row_ids": [101, 102, 103], "create_new": true }
```

- `row_ids` is required, unique, non-empty, and limited to 5,000 positive safe-integer staging-row ids.
- Provide exactly one of `investment_id` or `create_new: true`.
- Existing-investment mode verifies the investment before changing staging rows.
- Create-new mode creates one holding from the first requested row, then links the complete set to it.
- The batch and complete row set are locked before holding lookup or creation; the set-based update shares the same database transaction.
- If any row is missing, belongs to another batch, has `route='cash'`, or is no longer in `matched` or `error` status, the request returns `404` and changes no row. A failed create-new request also rolls back the holding creation.
- A non-reviewable batch or create-new retry whose row set already has a user override returns `400` before creating a holding.
- Error rows that are successfully assigned return to `matched`, clear their error message, and decrement the batch error count once per repaired row.

**Response envelope `data`:**

```json
{
  "investment_id": 12,
  "created": false,
  "resolved": 3
}
```

When `created` is `true`, `data.investment` also contains the created holding.

| Status            | Meaning                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `200 OK`          | Every requested row resolved to one investment                                                                                            |
| `400 Bad Request` | Malformed ids, empty/duplicate/oversized row set, invalid resolution mode, non-reviewable batch, or create-new row set already overridden |
| `404 Not Found`   | Investment or requested row missing, cross-batch, or no longer reviewable; nothing changed                                                |

---

### POST /api/portfolio/import/batches/:id/commit

Commit one reviewed batch, honoring investment overrides and resolving missing non-EUR FX under
[[docs/adr/074-fx-attribution-historical-rates|ADR-074]]. Maintained formats use the same locked
reconciliation planner as the multi-batch endpoint. Exact unique legacy matches can be adopted;
financial differences needing an explicit policy return a review conflict. This legacy endpoint
accepts only the optional account body below. Use the reconciliation endpoints to preview changes
and submit global/per-batch policies with a reviewed fingerprint.

Maintained commit requires complete staging and valid projected history. It writes trades, cash,
custody events, adoption receipts, statuses, and counters atomically; any runtime row failure aborts
the outer transaction. Generic imports retain partial-commit behavior. Rows run in ascending date
and stable source-row order. Unknown intraday execution order is not invented.

**Optional request body:**

```json
{ "account_id": 7 }
```

When `account_id` is provided, all committed `portfolio_transactions` inherit it — they belong to
the specified brokerage account. Omit (or send `null`) to keep the existing batch account; a
generic batch that had no account remains unassigned.
On a recommit, providing an account also resets cash rows whose exact stored error is
`brokerage cash row requires a batch account` to `matched` and decrements `rows_error`; other cash
errors are not cleared. The review page requires this account selection when it displays that
repairable error. The service holds the batch row lock from account selection through commit, so
concurrent recommits cannot change the selected account between validation and insertion.
Because the whole batch inherits it, the value is validated with `validateId` before the account
existence check rather than coerced: `"1e3"` used to arrive as the real account 1000, pass the
existence check and stamp every committed lot with it. Malformed values now return **400**.
The account column was introduced by migration 0057 (`portfolio_import_batches.account_id`).

Instrument-free dividend, interest, fee, and tax cash rows use the current
`brokerage_cash_category_ids` Settings mapping. The commit resolves only configured active IDs,
once per drain. It creates no category and leaves a row uncategorized when its mapping is null,
missing, deleted, or inactive. Changing Settings affects rows committed after the change; already
committed rows are not recategorized.

> [!warning] Generic partial commit limits
> Generic imports may record unresolved or runtime row failures while other rows commit. Maintained
> reviewed commits and multi-batch reconciliation commits reject the whole scope on such failures.

**Response:**

```json
{
  "ok": true,
  "data": {
    "batch_id": 43,
    "imported": 148,
    "duplicates": 1,
    "errors": 1
  }
}
```

**Responses:**

| Status            | Meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `200 OK`          | Commit completed (check `errors` and remaining batch errors)                          |
| `400 Bad Request` | Malformed identifiers/account or a batch outside reviewable states                    |
| `409 Conflict`    | Incomplete source, blocked reconciliation, or atomic runtime failure; no scope writes |

---

## Multi-batch reconciliation

Portfolio Performance XML upload and reference application are unavailable. Primary imports accept
supported broker CSV/Saxo XLSX files. Existing stored source context, corrections and immutable
receipts remain readable and must still satisfy their original proof and after-image guards.
The XML parser, reference planner and reference write repository are removed. The retained JSON
proof reader validates existing evidence without parsing or applying a document. This does not
alter historical transactions or stored evidence.

### POST /api/portfolio/import/reconciliation/preview

Preview source identity, adoption, custody continuity, and account-scoped history for a selected
session. This is a read-only database transaction; it creates no canonical rows or journal receipts.
Optional `reconciliation_scope` selects `full` (the default) or either bounded Kinesis mode
described below: `adopt_existing_only` or `correct_existing_only`.

```json
{
  "batch_ids": [42, 43],
  "adopt_policy": "preserve_existing",
  "batch_policies": [{ "batch_id": 43, "adopt_policy": "prefer_source" }]
}
```

`batch_ids` contains 1–100 numeric safe-integer IDs in `1..9007199254740991`. The service deduplicates and sorts
scope IDs. `adopt_policy` is optional and permits `preserve_existing` or `prefer_source`; absent
policy permits automatic exact adoption only. Optional `batch_policies` contains at most 100
unique selected batch IDs with the same policy enum and overrides the global choice. Objects are
strict; unknown fields reject. The JSON scope uses the same safe-integer ceiling as existing
BIGSERIAL batch path IDs.

The envelope's `data` uses camelCase: `batchIds`, `adoptPolicy` (null for automatic exact matching),
`batchPolicies`, `planFingerprint`, `ready`, `actions`, `blockers`, and `summary`. Actions identify
batch/staging row, investment, source and existing values, candidate transaction IDs, corrections,
applied policy, and transfer detail when applicable. Kinds include `insert`, `adopt`, `duplicate`,
`repair_duplicate`, `duplicate_source`, `cash`, `transfer`, `adjustment`, `internal_annotation`, `settled`, `blocked`, and
`policy_required`. Blockers identify `batchId`, `rowId`, one-based staging `rowOrdinal`, `reason`,
and candidate IDs. A `repair_duplicate` action additionally includes `importedTransactionId`,
`originalBatchId`, and `importedExisting`; `existingTransactionId` is the retained manual ID.
An `adjustment` action carries `adjustment` detail with `date`, `units`, `kind`, `basisPolicy`, and
`accountId`; `summary.adjustment` counts newly planned adjustment events. Their staging financial
`type` is null, and their ledger owns source linkage. Staging ordinals include adapter-derived rows
and are not CSV line numbers.

The planner requires one-to-one legacy attribution, exact source identity, complete staging,
proven economics for source corrections, known incoming basis, and usable custody counterpart
accounts. It rejects ambiguous history, prior assigned/imported legacy candidates, unexplained
currency corrections, source-policy conflicts, and missing Pro companions. Ordinary nearby legacy
matching uses seven calendar days. Literal Nexo Pro proof can extend to 31 days only with exact
executed price, exact units/base-fee explanation, and equivalent cash; raw evidence also binds
staged date, explicit quote fee, and zero tax. Ambiguous matches still block. A ready plan also
validates all projected custody events and new/worsened account oversells. See
[[docs/features/portfolio-import#Reviewed reconciliation|the reconciliation rules]].

Explicit `prefer_source` can also correct an unchanged earlier Saxo workbook adoption when a
fresh copy proves the same literal source identity and exactly one active immutable receipt
matches the canonical after-image. These remain `adopt` actions with the original transaction ID.
The fingerprint binds the old receipt, retained source and batch context. Changed or missing
evidence returns a blocker; automatic or preserve policies leave the record unchanged.

For IBKR imported-copy repairs and standalone legacy sales, authenticated literal source context
can prove a previously copied currency label, native principal and commission conversion. Dividend
proof requires a unique separately exported withholding row before correcting gross income and
removing embedded tax. Same-date economic identity can narrow overlapping imported-copy matches;
different proved copies remain duplicates and never become insertions. Ambiguous or unproved
claims remain blockers. This does not extend the ordinary seven-day matching window or reuse the
Nexo Pro date exception. These proof rules preserve the full-scope request and response contract.

#### Kinesis source attachment scope

`reconciliation_scope='adopt_existing_only'` requires only Kinesis batches, explicit global
`adopt_policy='preserve_existing'`, and no conflicting per-batch policy. Mixed formats, managed
reference supplemental batches, and `prefer_source` are not eligible. The server requires a fresh
capture of the complete unfiltered CSV: its literal SHA-256, ordered headers and event context,
source identities, account, repeated-record occurrences, and staged rows must agree. Skipped rows,
`included_symbols`, or missing/changed capture evidence prevent a ready plan. The entire source
is classified before the server derives the selected records; callers cannot supply row IDs or
an asset filter to handpick records within the staged source. This verifies the supplied file
context, not whether the export contains every historical broker event.

The reviewed-session UI explicitly sends `yield_basis_policy='zero'` when this scope is selected
before staging complete Kinesis CSVs. This permits proof of
matching existing zero-basis yield receipts; it does not authorize new transactions. Full-history
staging retains its existing basis policy, and changing reconciliation scope later does not
reinterpret staged source events.

Selected actions are only proven `adopt`, `duplicate`, or `settled` records. Ordinary new adoptions
identify one existing buy or gift with the exact date and eight-decimal quantity, while preserving
all its financial values, type and notes. Buys additionally require the literal principal, currency, unit
price, fees and taxes to match the existing values at stored precision. A meaningful gift requires
literal original basis and currency that match its recorded basis. Known source financial
differences or missing literal basis remain pending; preserving existing values does not make
that source attachment safe. Financial qualification comes before repeat-receipt validation. A
unique repeated record that fails it stays pending; incomplete retained source context on its
older receipt does not block this subset. Financially qualified repeated settlement requires one
active immutable adoption receipt, the same retained literal source proof, and an unchanged
canonical after-image. Proven existing zero-basis yield-unit acquisitions can receive source
provenance when their recorded
amount, unit price, fees and taxes are also zero. Their values stay unchanged.

Complete already-retained original-document evidence can prove a closed yield group between independent meaningful
deposit receipts. Complete primary, reference and canonical interval membership must agree, with
a same-file settled yield anchor and globally unique eight-decimal unit pairing. This is not a
subset-sum or nearby-date inference. Every eligible group member is selected together or the group
blocks review. Each new adoption binds one distinct source-unit row to one distinct existing record;
settled anchors remain `duplicate` or `settled`. Recorded dates, quantities, financial values,
types, notes and IDs are preserved even when broker payment dates differ. Retained group evidence
and unchanged receipts are required on repeat review. The action and count shapes remain unchanged.

New yield acquisitions and paired new income remain deferred in this attachment scope. Proven
paired income can be recorded separately through the bounded in-kind income scope below.
This scope performs no insertion, duplicate repair, cash movement, custody transfer, or unit
adjustment. Ambiguous eligible history and changed fresh source evidence still block the plan.
Qualifying repeats also block the plan when their receipt or canonical after-image has changed.

#### Kinesis existing correction scope

`reconciliation_scope='correct_existing_only'` requires complete unfiltered Kinesis primary
sources under the same capture and classification guards, explicit global
`adopt_policy='prefer_source'`, and no contrary statement policy. The server derives only proven
financial corrections or proved yield-group payment dates to unique existing buys/gifts and strict receipt-proven
`duplicate`/`settled` retries. Selected correction actions use `adopt` with `prefer_source`.
Ordinary financial corrections may change `amount`, `price_per_unit`, `fees`, `taxes`, `currency`
and `fx_rate_to_eur`. Their dates, IDs, types, quantities and notes stay unchanged.

A closed yield group proved from already-retained complete original-document evidence and complete primary/canonical interval can
instead use the literal broker payment date. All changed members are corrected together; each is
an `adopt` under `prefer_source` with `corrections: ['date']` and typed `dateProof`. Its existing
date equals `recordedDate`, and its source date equals `paymentDate`. Quantities, type, financial
values, notes and IDs stay unchanged. The group uses the same independent deposit boundaries,
settled anchor, global unique unit pairing and closure guards as attachment. It does not allow an
ordinary nearby-date correction or combine a date change with financial changes.

`dateProof` contains `kind: 'closed_kinesis_yield_group'`, a lowercase SHA-256 `groupKey`, ISO
`recordedDate` and `paymentDate`, and positive integer `memberCount`. That count includes unchanged
yield anchors, which need not be selected correction actions. The server proves complete closure
and atomic selection; the fingerprint binds original group evidence and before/after dates.
Selected action counts continue to count changed records, not all contextual group members.

Primary literal purchase fees replace the recorded fee; they are not added to it. A meaningful
gift needs validated original Portfolio Performance recorded-native basis/currency proof bound
to the primary event, account, asset, date and quantity and an existing meaningful positive basis.
A zero or nominal gift basis is not promoted into a financial basis correction. A placeholder, guessed conversion
or missing basis does not qualify.

When changing currency without literal original FX, corrections use the normal historical rate
cache. Preview and locked commit require a usable stored rate on or before the
transaction date, at most seven days earlier, and bind that evidence into the fingerprint. The
canonical source FX remains unstamped; today's rate never authorizes the correction. Unavailable
gift rates leave those corrections pending while independent literal-fee corrections can proceed.
This mode performs no inserts, duplicate repairs, cash movements,
custody transfers or unit adjustments. Other source events, including new yield acquisitions and
income, remain pending.

Full history can also record a proved literal paired income event beside its single selected
zero-basis Gift acquisition. Full `incomeProof` requires output-only `unitRowId` identifying a
Gift `insert`, `adopt`, `duplicate` or `settled` action in the same batch, investment and payment
date. An adoption or existing unit also requires `unitTransactionId`; a new Gift insert obtains
its canonical ID inside the same atomic commit before the income receipt is written. New income
uses the read-only `included_in_units` role, with no second acquisition or gain. Repeated income
requires distinct existing income/unit IDs and unchanged proof. Ordinary dividends remain ordinary.
Full `recordedIncome` and `recordedCash` are additive batch/aggregate subtotals within `imported`,
which may also include ordinary portfolio records. Older full responses may omit both subtotals.
New Kinesis cash still requires its explicitly confirmed bounded review; exact owned cash repeats
can settle in full history without writing the cash again.

#### Kinesis paired in-kind income scope

`reconciliation_scope='record_in_kind_income_only'` requires explicit `preserve_existing`, zero
yield basis and complete original unfiltered Kinesis source proof. Select it before staging to
send `yield_basis_policy='zero'`. The whole source is classified first. Only literal income whose
paired zero-basis unit acquisition already has unique validated source/receipt and current
after-image proof may be selected. The pair must agree on asset, account, date, provider event and
occurrence identity. Previously retained correction/group reference context remains eligible when
its complete source binding still validates.

Preview and locked commit automatically warm the normal historical currency cache for proved
income dates. A usable stored rate within seven days is required when conversion is needed, and
that rate evidence is bound in the plan fingerprint. Unresolved dates remain pending; a current
rate does not authorize recording. Canonical source FX remains null rather than receiving an
invented literal rate.

Selected actions are `record_income`, `duplicate` or `settled`. A new income action contains
`incomeProof: { kind: 'paired_kinesis_income', unitTransactionId }`, a positive canonical unit-record
ID. Its source is a `dividend` with `income_recognition_role='included_in_units'`, literal currency
and date, and an amount rounded at canonical precision (a positive raw value may round to zero).
Units and unit price are null, fees/taxes are zero, and source FX is unstamped. Pair and full-file
proof stay in the fingerprint; this public ID is output only. The source income row is
settled without changing its unit row or existing acquisition. Missing or changed paired proof does
not authorize new units, a guessed amount or ordinary dividend recognition.

Proved `duplicate` and `settled` income actions retain the same typed `incomeProof` and identify
the distinct existing income record with `existingTransactionId`. These are paired-income repeats
only, with no date proof or corrections. A settled action may omit source/existing values; a fresh
duplicate exposes literal source values without requiring the canonical accounting-role field.
The server revalidates both receipt after-images, and selected income/unit identities stay unique.
The narrow proof is rejected in other bounded scopes and does not authorize recording income again.
Full history uses the distinct staged-unit binding described above.

`summary.record_income` counts selected new income rows. Commit emits `recordedIncome` per batch
and at the top level, equal to `imported`; these are newly recorded canonical income, not new
acquisitions. `adopted` and `repaired` are zero. Repeat settlement creates no new income, and an
already-settled retry creates no duplicate count. Scope progress uses the same selected IDs,
pending/deferred counts and partial lifecycle as other bounded scopes. Other source rows stay
pending; no general cash, custody, acquisition or adjustment drain runs.

The read-only accounting role retains income separately in `totalInKindIncome`, excluded from
ordinary dividend/income totals and gains because its value is already represented by acquired
units. It makes no legal tax classification. Migration 0124 adds immutable paired `record`/`restore`
receipts and guards both current images. Archived income uses the canonical dated
`archivedInKindIncome` subtotal, without changing ordinary archive gain/basis. A rolled-back or
aborted income source batch cannot be reused; a fresh complete original source can prove a new
recording after guarded rollback. Rollback verifies the income and unit after-images, releases
the pair and removes only the owned income; changed history rejects restoration. Standard role
absence in older immutable receipts means `standard`, with no receipt rewrite. See
[[docs/adr/188-proved-in-kind-income-recognition|ADR-188]] and [[docs/reference/data-model]].

#### Kinesis complete cash-only scope

New Kinesis cash in ordinary full-history commit is rejected before writes with `cash_reconciliation_required`;
use the confirmed cash-only scope to record it. Already-owned unchanged settled cash repeats remain
compatible with full review. Ownership confirmation is not assumed for future unclassified funding.

`reconciliation_scope='record_cash_only'` requires complete original unfiltered Kinesis sources,
explicit global `adopt_policy='preserve_existing'`, no contrary batch policies, and explicit
`cash_funding_policy='own_account_transfer'`. The confirmation covers the selected source's cash
funding deposits and withdrawals as movements between the user's own accounts. Full literal
capture, routing, occurrence identities and complete cash balance chains are proved before selection.
Overlapping selected cash sources, missing chain members, ambiguity or changed evidence cannot
produce a partial new cash chain. Callers cannot supply row IDs or filtered/derived source files.
Account closure is checked across every active cash-ledger row on each routed account. Only
fully validated main/fee components from the same original source are allowed; unrelated active
rows, including other dates/currencies or opening anchors, block this bounded recording.
The zero-opening source also requires no routed-account `account_statement_balances` reading,
even a zero reading. Those rows are read, fingerprint-bound and locked alongside ledger proof;
a new or changed statement reading invalidates the reviewed plan.
Preview and locked commit prepare normal historical currency rates automatically. A usable stored
rate within seven days is required for cash dates needing conversion and is fingerprint-bound;
unresolved conversion readiness defers the whole cash group rather than authorizing a partial
chain or current-rate substitution. Source FX remains unstamped.

Selected actions are `cash`, `duplicate` or `settled`, each with typed `cashProof`:
`{ kind: 'closed_kinesis_cash', groupKey, eventKey, eventKind, fileHash, memberCount, componentCount }`.
The three hashes are lowercase SHA-256. `eventKind` is `trade_quote`, `own_account_funding` or
`card_expense`. `memberCount` includes all new/repeated source actions in the group, selected
atomically; `componentCount` is one, or two for a separately quoted funding-withdrawal fee.
The proof is output-only and fingerprint-bound to complete source and funding confirmation.

New `cashValues` contain ISO `date`, signed decimal-string `amount`, ISO `currency`, positive
`accountId`, boolean `isTransfer`, `transferSource: 'brokerage'` and `transferPeerId: null`.
Source-proved trade quotes and confirmed own-account funding are internal transfers, excluded from
ordinary cash-flow income/expenses while remaining real account movements. Card spending remains
an expense, including its literal quoted fee. A funding withdrawal with a separately quoted
same-currency fee uses its net transfer amount plus `cashFeeValues`: a negative expense with the
same date, currency and account, false transfer flag, brokerage origin and null peer. The two
components together equal the literal gross source debit. No card fee is counted twice, opposite
bank row is invented, or automatic peer is guessed. Brokerage origin also on card/fee expenses
prevents automatic re-pairing; orphan cleanup clears ordinary auto/manual origins only.

Repeated actions identify positive `existingTransactionId`; two-component repeats additionally
identify distinct positive `existingCashFeeTransactionId`. Canonical component identities stay
unique. Both values may be omitted together on repeats; if present they satisfy the same source
classification. Complete retained source and every component after-image are revalidated.
Unrelated portfolio bodies, correction/income/custody proofs and partial group claims are invalid.

`summary.cash` counts new source actions. Commit `imported` and `recordedCash`, at top and batch
level, count newly recorded canonical cash components, including separate withdrawal fees;
`adopted`, `repaired` and `recordedIncome` are zero. Duplicate counts describe newly settled source
rows, while same-batch settled retries add no new records or duplicate count. Other source rows
remain pending. This scope returns before ordinary portfolio, income, custody or adjustment drains.
Stored historical evidence remains read-only; no reference upload is available. The queued session retains
scope, policy and confirmation on reload only when source routing and batch identities match;
changed sources/routing clear confirmation and invalidate review. Legacy checkpoints retain full
history/automatic defaults.

Migration 0125 extends the origin CHECK and protects typed immutable staged cash receipts without
backfilling financial rows. Guarded rollback verifies both component images before removing owned
cash, retains source evidence and permits a fresh full-source recording afterward. Changed images
block rollback. Downgrade refuses remaining brokerage-origin rows. See
[[docs/adr/189-proved-brokerage-cash-history|ADR-189]] and [[docs/features/transfers]].

The narrow preview's `actions` and `summary` describe only the selected records. It additionally
returns:

| Field                 | Meaning                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `reconciliationScope` | `adopt_existing_only`, `correct_existing_only`, `record_in_kind_income_only` or `record_cash_only`; absent in the unchanged full-scope response |
| `selectedRowIds`      | Distinct staging IDs of selected actions; derived by the server, never an input                                                                 |
| `pending`             | Excluded unsettled source rows after the proposed selected actions                                                                              |
| `complete`            | Whether `pending` is zero                                                                                                                       |
| `deferredCounts`      | Pending rows grouped by staged event kind; values sum to `pending`                                                                              |
| `batchProgress`       | Per-batch `{ batchId, pending, complete, deferredCounts }`; pending counts sum to the session total                                             |

Deferred kinds can include `dividend`, `gift`, `sell`, `cash`, `asset_transfer`, `asset_adjustment`,
`account_internal`, and `unsupported`. They report outstanding events rather than failed writes.
The fingerprint binds the full classified source, server-selected actions, literal capture and
receipt context, policies, current history, and deferred counts. A later review must obtain a fresh
fingerprint. Full-scope responses keep their existing shape.

### POST /api/portfolio/import/reconciliation/commit

Submit the same scope and policies plus required `expected_plan_fingerprint`, a 64-character
lowercase hexadecimal SHA-256 fingerprint from preview. The hash binds policies, source rows,
current history, batch configuration/status, and companion-Pro evidence. The same
`reconciliation_scope` must be sent when reviewing a narrow scope. Commit reloads that state
under batch/account and portfolio-writer locks. An outdated plan cannot apply changed history.

The selected batches must be reviewable (`awaiting_review`, `matching`, or
`complete_with_errors`). Active eligible source/destination accounts are locked in ID order before
the transaction/custody tables. New matched events run across batches by date, batch ID, and source
row index. Adoption preserves transaction IDs and notes and adds source metadata/account assignment.
An immutable before/after receipt owns restoration; the adopted row remains `import_batch_id=null`.
`prefer_source` changes only supported, proven-equivalent financial values. It never changes the
transaction type/notes or invents a currency conversion.

For a proved prior Saxo adoption correction, the original batch joins the sorted lock scope.
The new batch owns the correction receipt; old counters, source rows, receipts and cash stay
unchanged. Rolling back the new correction restores the prior adoption's after-image. The old
adoption cannot roll back while a later correction still changes that image.

When a source fingerprint identifies an unchanged imported copy and one unique nearby
unassigned/unstamped manual candidate, an explicit reviewed policy can repair the duplicate.
The original import must be complete and retain exactly one committed staging pointer matching the fingerprint. Changed
imported economics, notes, or recurrence metadata block repair. The planner locks the referenced
original batches with the selected scope, removes the exact copy, preserves/adopts the manual ID
and notes, clears the old pointer, and moves its old imported count to duplicate. A separate 0122
receipt stores both full row images and original batch/staging state for restoration. Automatic
policy leaves this action blocked with `duplicate_repair_policy_required`.

The outer transaction includes all canonical writes, receipts, staging changes, and counters.
Custody and adjustment events preserve source ownership and original-lot allocations. New
adjustments count in `imported` alongside other new canonical events. Runtime failure returns
`409` and rolls them all back. Cache invalidation follows successful commit.

```json
{
  "ok": true,
  "data": {
    "batches": [
      {
        "batch_id": 42,
        "imported": 2,
        "duplicates": 1,
        "adopted": 1,
        "repaired": 0,
        "errors": 0
      }
    ],
    "imported": 2,
    "duplicates": 1,
    "adopted": 1,
    "repaired": 0,
    "errors": 0
  }
}
```

Adopted and repaired rows are also counted as duplicates because they create no second financial
transaction. Multi-batch results always include integer `repaired` in each batch and aggregate; the
legacy single-batch commit response retains its existing counts.

For the attachment and correction scopes, commit writes only selected adoptions/corrections and newly settled receipt-proven
duplicates, then returns before the general event writer drains any remaining source rows.
`imported` and `repaired` are always zero. Repeated already-settled actions create no new duplicate
count. The response adds the preview's scope metadata and `selectedRowIds`, but omits
`batchProgress`: each `batches` entry instead includes `reconciliationScope`, `pending`, `complete`,
and `deferredCounts` beside its usual snake-case `batch_id` and counts.

When the session has pending events, every selected batch stays `awaiting_review` with no completion
timestamp. A batch may report `complete=true` for its own source while remaining in that session
lifecycle. Deferred staging rows stay unsettled and are never marked complete by this commit.
Selected writes, immutable receipts, source statuses and counters remain one atomic
transaction. Existing guarded rollback restores only the adopted original rows after verifying
their after-images and appends inverse receipts; changed history rejects rollback. Attachment and correction use their existing journal. The in-kind income scope adds the separate
paired receipt journal described above.

| Status            | Meaning                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200 OK`          | Preview produced a plan, including a blocked plan; or commit completed atomically                                                                              |
| `400 Bad Request` | Invalid strict request, IDs/policies/scope/fingerprint, missing batch in preview scope, non-reviewable scope, or narrow mode with unsupported formats/policies |
| `404 Not Found`   | A selected batch disappeared before the locked commit recheck                                                                                                  |
| `409 Conflict`    | `incomplete_source`, `stale_reconciliation_plan`, `reconciliation_required`, or `atomic_import_failed`; no commit writes                                       |

The optional bounded scopes, accounting role, income subtotal and response fields are additive
and nonbreaking for supported readers. Role setters remain read-only. Omitting the field
or selecting `full` preserves the full-scope response and writer. These endpoints and policy fields
are additive. Maintained single-batch commit now adopts exact
history and rejects incomplete/unsafe or runtime-failed scopes atomically, which tightens earlier
partial behavior. API support does not prove real-source completeness or native-app acceptance.

---

## Rate Limits

The entire `/api/portfolio/import` router is mounted with `importRateLimiter`, in addition to the
global API limiter. This covers uploads, batch/review operations, reconciliation, and saved parsers.

---

## Related

- [[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|ADR-177]] — receipts, custody model, and guarded migration recovery

- [[docs/api/index|API Index]]
- [[docs/features/portfolio-import|Portfolio Import Feature]]
- [[docs/api/imports|Imports API]] — budgeting CSV import (parallel pipeline)
- [[docs/adr/078-portfolio-csv-import|ADR-078: Portfolio CSV Import Architecture]]
- [[docs/reference/data-model|Data Model Reference]] — `portfolio_import_batches`, `portfolio_import_staging_rows`
- [[docs/features/portfolio|Portfolio Feature]]
