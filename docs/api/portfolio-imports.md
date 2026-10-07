---
title: API - Portfolio Imports
type: endpoint
method: POST, GET, PATCH, DELETE
path: /api/portfolio/import
description: Portfolio CSV/Saxo XLSX staging, optional bounded XML evidence, reviewed reconciliation, immutable receipts, and dated custody/unit adjustments with original basis
date: 2026-10-07
updated: 2026-10-04
last_modified: 2026-10-04
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
  - "apps/node-backend/src/routes/portfolioImportRoutes.js"
  - "apps/node-backend/src/routes/importBatchRoutes.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/index.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/stage.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/validate.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/matchInvestments.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/commit.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/ibkrTransactionHistoryAdapter.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/kinesisTransactionHistoryAdapter.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/nexoTransactionHistoryAdapter.js"
  - "apps/node-backend/src/services/portfolioImportPipeline/nexoProTransactionHistoryAdapter.js"
  - "apps/node-backend/src/services/portfolioImportReconciliationService.js"
  - "apps/node-backend/src/services/portfolioImportDuplicateRepairService.js"
  - "apps/node-backend/src/repositories/portfolioImportDuplicateRepairRepository.ts"
  - "apps/node-backend/src/repositories/portfolioImportReconciliationRepository.ts"
  - "apps/node-backend/src/services/portfolio/portfolioAssetTransferService.js"
  - "apps/node-backend/src/services/portfolio/portfolioAssetAdjustmentService.js"
  - "apps/node-backend/src/repositories/portfolioAssetAdjustmentRepository.ts"
  - "apps/node-backend/src/services/portfolioImportReferenceService.js"
  - "apps/node-backend/src/services/portfolioPerformanceXmlParser.js"
  - "apps/node-backend/src/services/portfolioPerformanceReferenceEvidence.js"
  - "apps/node-backend/src/repositories/portfolioImportReferenceRepository.ts"
  - "apps/node-backend/src/lib/portfolioReferenceUpload.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.js"
  - "apps/node-backend/src/services/portfolioImportBatchService.js"
  - "apps/node-backend/src/services/portfolioImportCommitService.js"
  - "apps/node-backend/src/services/portfolioImportReadinessService.js"
  - "apps/node-backend/src/repositories/portfolioImportBatchRepository.ts"
  - "apps/node-backend/src/services/customParserConfigService.js"
  - "apps/node-backend/src/lib/portfolioUpload.ts"
  - "apps/node-backend/src/services/portfolio/fxResolve.js"
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
adoption keeps the original transaction ID. Optional Portfolio Performance XML provides secondary
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

| Field                 | Type    | Required | Description                                                                                                                                                        |
| --------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file`                | File    | Yes      | CSV or detailed Saxo XLSX file (max 50 MiB); XLSX requires `portfolio_format=saxo_transaction_history`                                                             |
| `adapter_name`        | string  | No       | Display label for the import source (written as `bank_account` on portfolio_transactions)                                                                          |
| `portfolio_format`    | string  | No       | Specialized parser: `ibkr_transaction_history`, `kinesis_transaction_history`, `nexo_transaction_history`, `nexo_pro_spot_history`, or `saxo_transaction_history`. Omit for generic mapping |
| `date_format`         | string  | No       | Python strptime format; default `%Y-%m-%d`                                                                                                                         |
| `separator`           | string  | No       | Single-character CSV delimiter; default `,`                                                                                                                        |
| `encoding`            | string  | No       | File encoding; default `utf-8`                                                                                                                                     |
| `skip_rows`           | integer | No       | Header rows to skip; default `0`                                                                                                                                   |
| `date_column`         | string  | Yes      | CSV header name for the trade date                                                                                                                                 |
| `type_column`         | string  | No       | CSV header name for the transaction type (buy/sell/dividend/…)                                                                                                     |
| `symbol_column`       | string  | No*      | CSV header name for the ticker symbol                                                                                                                              |
| `name_column`         | string  | No*      | CSV header name for the instrument name                                                                                                                            |
| `units_column`        | string  | No       | CSV header name for number of units                                                                                                                                |
| `price_column`        | string  | No       | CSV header name for unit price                                                                                                                                     |
| `amount_column`       | string  | No       | CSV header name for total amount                                                                                                                                   |
| `fees_column`         | string  | No       | CSV header name for transaction fees                                                                                                                               |
| `taxes_column`        | string  | No       | CSV header name for taxes/withholding                                                                                                                              |
| `currency_column`     | string  | No       | CSV header name for trade currency                                                                                                                                 |
| `fx_rate_column`      | string  | No       | CSV header name for EUR FX rate                                                                                                                                    |
| `note_column`         | string  | No       | CSV header name for a free-text note                                                                                                                               |
| `default_asset_class` | string  | Yes      | Fallback asset class: `stock` `etf` `crypto` `metals` `real_estate` `savings` `bond`                                                                               |
| `default_type`        | string  | No       | Fallback transaction type when no `type_column` is mapped (default `buy`): `buy` `sell` `dividend` `fee` `tax` `interest`                                          |
| `type_mapping`        | string  | No       | JSON object mapping raw CSV type strings → canonical portfolio_txn_type values (e.g. `{"Koop":"buy","Verkoop":"sell"}`)                                            |
| `is_brokerage`        | boolean | Format*  | Must be `true` for every maintained transaction-history format so portfolio and cash effects use brokerage routing                                                 |
| `transfer_destination_account_id` | integer | No | Distinct active portfolio account receiving outgoing Nexo/Kinesis custody transfers; required to commit those rows |
| `transfer_origin_account_id` | integer | No | Distinct active portfolio account providing original lots for incoming Nexo crypto top-ups |
| `included_symbols` | string | No | Comma-separated exact adapter symbols for an explicit partial import; excluded rows are recorded separately in batch configuration, and parse errors remain errors |
| `yield_basis_policy` | string | No | Literal `zero`; explicit Kinesis zero-yield basis interpretation, never selected by omission |
| `account_id`          | integer | Format*  | Active broker account receiving every row; required with `is_brokerage` and for each maintained transaction-history format                                         |

> [!warning] Symbol or name required
> At least one of `symbol_column` or `name_column` must be provided. Both may be mapped simultaneously for best matching.

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

| Status | Meaning |
| ------ | ------- |
| `200 OK` | Rollback completed; body reports `{ deleted }` |
| `400 Bad Request` | Malformed id, aborted batch, or batch still in progress |
| `404 Not Found` | Batch disappeared or does not exist |
| `409 Conflict` | Adopted/repair history changed or removal would break a later custody, adjustment, or sale dependency; nothing changes |

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

| Status         | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| `200 OK`       | Commit completed (check `errors` and remaining batch errors) |
| `400 Bad Request` | Malformed identifiers/account or a batch outside reviewable states |
| `409 Conflict` | Incomplete source, blocked reconciliation, or atomic runtime failure; no scope writes |

---

## Multi-batch reconciliation

### POST /api/portfolio/import/reconciliation/reference

Apply one optional original Portfolio Performance XML as secondary evidence to an explicitly
selected import scope. This endpoint changes staging/configuration only and may create review-only
supplemental or managed retained-history batches. It writes no canonical trades, receipts, custody,
or adjustments. Primary broker execution facts keep precedence.

**Content-Type:** multipart/form-data

| Field | Required | Contract |
| ----- | -------- | -------- |
| `file` | Yes | One `.xml` file, at most 10 MiB, valid UTF-8 Portfolio Performance `client` document |
| `batch_ids` | Yes | JSON array of 1–100 unique numeric safe-integer batch IDs, each in `1..9007199254740991` |
| `placeholder_basis_policy` | Yes | Literal `zero`; explicit policy, never inferred |

Only these fields are accepted. The separate XML boundary permits two fields and one file. Parsing
rejects document type/entity declarations, malformed XML, unsupported encoding/entities, excessive
reference chains, inconsistent paired trade cash/transfer facts, and unsupported portfolio events.
The object graph is bounded at depth 64 and 300,000 nodes; text nodes have a 100,000-character limit.
Temporary uploads are cleaned up after handling. These are separate limits from the 50 MiB primary
CSV/Saxo XLSX upload.

Literal reference facts must resolve asset, units, date, currency, and wallet/account context.
Meaningful recorded native basis can fill a missing basis; a small placeholder value cannot become
an acquisition valuation. Consistent literal FX can establish its original EUR rate; other
conversions and account aliases are not guessed. Unknown/ambiguous anchors, unsupported basis or
currency, and uncovered selected history remain blockers. `placeholder_basis_policy='zero'` also
selects explicit Kinesis zero-yield interpretation using retained actual source columns.

A reviewable selected batch can be enriched in place. An explicitly selected terminal IBKR batch
(`complete` or `complete_with_errors`) requires complete retained literal source identity and is
cloned into a fresh managed review batch. The returned scope replaces the original ID with that
clone; original canonical history is unchanged. No existing import is included implicitly. A
managed clone avoids requiring rollback of unrelated history in an old import.

The envelope's `data` includes:

| Field | Meaning |
| ----- | ------- |
| `batch_ids` | Full effective review scope, including managed replacements and supplemental batches |
| `matched_reference_rows`, `source_corrections` | Nonnegative evidence-match and staged-correction counts |
| `supplemental_batches` | Metadata for new review batches: `batch_id`, `account_id`, `adapter_name`, `source_filename`, `status`, `rows_total`; managed clones also carry `original_batch_id` |
| `replacement_batches` | Array of `{original_batch_id, review_batch_id}` relations; empty when no original was cloned |
| `blockers` | Evidence/context/readiness blockers retained for reconciliation |
| `coverage` | Optional bounded diagnostic of selected XML/source/legacy coverage; not a complete-history certificate |

Repeating the same XML bytes and original/effective scope with unchanged routing returns the same
result without new batches. A changed XML or scope on an enriched primary batch returns
`409 reference_requires_restaging`; restage primary uploads and select the original again for a
fresh managed clone. Changed routing returns `409 reference_scope_changed`. Incomplete retained
source returns `409 reference_retained_source_incomplete`. Invalid strict fields, unsupported
scope, or invalid XML return 400. A successful staging/reference result returns 200, even when its
blockers prevent a later commit. A new ready preview and its fingerprint are still required.

See [[docs/features/portfolio-import#Optional Portfolio Performance reference|the evidence workflow]]
and [[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|ADR-177]].

### POST /api/portfolio/import/reconciliation/preview

Preview source identity, adoption, custody continuity, and account-scoped history for a selected
session. This is a read-only database transaction; it creates no canonical rows or journal receipts.

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

### POST /api/portfolio/import/reconciliation/commit

Submit the same scope and policies plus required `expected_plan_fingerprint`, a 64-character
lowercase hexadecimal SHA-256 fingerprint from preview. The hash binds policies, source rows,
current history, batch configuration/status, and companion-Pro evidence. Commit reloads that state
under batch/account and portfolio-writer locks. An outdated plan cannot apply changed history.

The selected batches must be reviewable (`awaiting_review`, `matching`, or
`complete_with_errors`). Active eligible source/destination accounts are locked in ID order before
the transaction/custody tables. New matched events run across batches by date, batch ID, and source
row index. Adoption preserves transaction IDs and notes and adds source metadata/account assignment.
An immutable before/after receipt owns restoration; the adopted row remains `import_batch_id=null`.
`prefer_source` changes only supported, proven-equivalent financial values. It never changes the
transaction type/notes or invents a currency conversion.

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
    "batches": [{ "batch_id": 42, "imported": 2, "duplicates": 1, "adopted": 1, "repaired": 0, "errors": 0 }],
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

| Status | Meaning |
| ------ | ------- |
| `200 OK` | Preview produced a plan, including a blocked plan; or commit completed atomically |
| `400 Bad Request` | Invalid strict request, IDs/policies/fingerprint, missing batch in preview scope, or non-reviewable scope |
| `404 Not Found` | A selected batch disappeared before the locked commit recheck |
| `409 Conflict` | `incomplete_source`, `stale_reconciliation_plan`, `reconciliation_required`, or `atomic_import_failed`; no commit writes |

These endpoints and policy fields are additive. Maintained single-batch commit now adopts exact
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
