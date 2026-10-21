---
title: API - Portfolio Imports
type: endpoint
method: POST, GET, PATCH, DELETE
path: /api/portfolio/import
description: Portfolio CSV, Saxo XLSX and IBKR funding XLS/XLSX staging, cross-export deduplication, one full-history reviewed reconciliation, reversible adoption receipts, and dated custody/unit adjustments with original basis
date: 2026-10-21
updated: 2026-10-21
last_modified: 2026-10-21
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
    adr-236,
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
  - "apps/node-backend/src/repositories/portfolioImportReconciliationRepository.ts"
  - "apps/node-backend/src/services/portfolio/portfolioAssetTransferService.ts"
  - "apps/node-backend/src/services/portfolio/portfolioAssetAdjustmentService.ts"
  - "apps/node-backend/src/repositories/portfolioAssetAdjustmentRepository.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/saxoTransactionHistoryAdapter.ts"
  - "apps/node-backend/src/services/portfolioImportBatchService.ts"
  - "apps/node-backend/src/services/portfolioImportCommitService.ts"
  - "apps/node-backend/src/services/portfolioImportReadinessService.ts"
  - "apps/node-backend/src/repositories/portfolioImportBatchRepository.ts"
  - "apps/node-backend/src/services/customParserConfigService.ts"
  - "apps/node-backend/src/lib/portfolioUpload.ts"
  - "apps/node-backend/src/services/portfolioImportPipeline/uploadSupport.ts"
  - "apps/node-backend/src/services/portfolioImportProbe.ts"
  - "packages/shared-utils/src/portfolioImportDetection.ts"
  - "packages/shared-utils/src/csvPreview.ts"
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

The Portfolio Imports API accepts CSV history, detailed Saxo XLSX workbooks and the IBKR funding
workbook (XLS or XLSX). It imports trades
into `portfolio_transactions`, routes brokerage cash to `transactions`, and stores dated custody
events in `portfolio_asset_transfers` and unit removals in `portfolio_asset_adjustments`. Reviewed
adoption keeps the original transaction ID. The API is parallel to budgeting import (`/api/import`) and uses stage, validate,
match, review, and commit phases.

Exact source records remain internal staging provenance. Versioned occurrence fingerprints provide
race-safe duplicate identity across generic and built-in adapters and are not exposed in API
responses. See [[docs/adr/134-versioned-import-identity-and-exact-provenance|ADR-134]].

The import path provides a generic user-configured mapper plus built-in IBKR, Kinesis Money, Nexo
wallet, Nexo Pro, and Saxo transaction-history formats with format-specific regression fixtures.
Source support does not establish completeness of the supplied historical exports.
Kinesis Money import is distinct from Vision's existing Kinesis market-price provider. Users may
configure other broker mappings, but those formats are not maintained compatibility targets.

All routes are mounted at `/api/portfolio/import`. Uploads, probe, and commits also pass
`importRateLimiter`; see [[docs/api/portfolio-imports#Rate Limits|Rate Limits]].

> [!info] Auto-commit policy
> Non-brokerage generic imports auto-commit (return 201) only when there are zero errors, unresolved
> rows, or name matches. Exact symbol and explicit provider-alias matches use `match_source='symbol'`.
> Every maintained preset is a brokerage import
> and always enters `awaiting_review` (return 202), even when every symbol matches exactly.

---

## Upload Endpoints

### POST /api/portfolio/import/probe

`POST /api/portfolio/import/probe` is a read-only multipart probe a client can send before staging. `file` is required;
`separator` can be comma, semicolon, tab or pipe (omit to sniff), `encoding` defaults to `utf-8`
and also accepts `latin1` or `windows-1252` (case-insensitive, with `utf8`, `latin-1` and
`iso-8859-1` aliases), and `skipRows` is a decimal string defaulting to `0`.
The existing upload filter, 50 MB limit and workbook inflation limits apply. Temporary files
are cleaned up on success and failure. No batch, staging, investment or financial row is written.

The envelope data is `{detected, detectionError, preview, previewError, separator}`. Detection
contains `source` and every `sourceAccountIdentities` value. Since ADR-236 there is no
`native_receipts` source and no `presetKey`. Unknown formats return `detected: null`; detection parse failures additionally
return `detectionError: "parse_error"`. Preview contains `headers` and at most five `rows`
from the first 16,384 bytes, or `null` with `previewError: "parse_error"` if parsing fails.
The two outcomes are independent: a maintained workbook can be detected even when its
CSV preview is unreadable. The frontend still displays its existing unreadable notice for an
empty header set. Distinct type mapping values come from these preview rows, as in the web UI.

Maintained record and workbook predicates and CSV preview decoding now live in
`@vision/shared-utils`; the web frontend keeps compatibility entry points. Detection uses the
complete file so another source account cannot be hidden beyond the preview prefix. This is
additive; existing upload behavior is unchanged.

### POST /api/portfolio/import/csv/custom

One-shot portfolio history import. The existing endpoint path accepts CSV and maintained Saxo workbooks.
It runs the pipeline synchronously and returns 201 if committed or 202 if review is required.

Every mapping, adapter, format, brokerage, and account option is accepted only as a multipart
field. Query fields are ignored. This is a breaking request-contract change under
[[docs/adr/136-same-release-http-import-and-navigation-contract|ADR-136]].

**Content-Type:** multipart/form-data

**Form Data:**

| Field                             | Type    | Required | Description                                                                                                                                                                                 |
| --------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file`                            | File    | Yes      | CSV or maintained workbook (max 50 MiB); Saxo XLSX requires `saxo_transaction_history`; the IBKR funding XLS/XLSX requires `ibkr_funding_history`; other legacy XLS is rejected                 |
| `adapter_name`                    | string  | No       | Display label for the import source (written as `bank_account` on portfolio_transactions)                                                                                                   |
| `portfolio_format`                | string  | No       | Specialized parser: `ibkr_transaction_history`, `ibkr_funding_history`, `kinesis_transaction_history`, `nexo_transaction_history`, `nexo_pro_spot_history`, or `saxo_transaction_history`. Omit for generic mapping |
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

The upload filter accepts CSV, XLSX and XLS filename/MIME combinations; the error for anything
else is `File must be a CSV, XLSX or supported XLS workbook`. After temporary upload, byte
inspection identifies ZIP and OLE2 workbooks independently of the temporary filename. XLSX
requires the Saxo or IBKR funding format and a valid maintained workbook before batch creation;
XLS is accepted only for `ibkr_funding_history`. Bank CSV upload endpoints are unchanged.

`ibkr_funding_history` reads the Deposit and Withdrawal sheets of the IBKR Transaction Status &
History export (SheetJS reads both XLS and XLSX). Each completed request (status Available, Sent,
Completed, Processed, Received, Credited or Disbursed) stages one brokerage cash row in its own
currency, from the `Amount` text such as `USD 1,000.00`, dated by the request date and identified
by the account ID and reference number. Pending, rejected, cancelled and other open requests are
skipped and counted; an unknown status, a changed header, formulas, hidden sheets, duplicate
references or more than one account reject the file. `included_symbols` is rejected for this
format. Each row's literal cells are kept in `raw_data` with the `ibkr_funding_workbook_row`
schema.

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
order. `Forex Trade Component` records with explicit negative commissions or transaction fees
produce one instrument-less fee in the statement base currency, retaining the literal record for
deduplication. Conversion principal and quantities are not imported as holdings; zero-charge
components increase `skipped`. Invalid charges or positive fee credits reject rather than invent
an expense. `Adjustment` records whose trimmed description is exactly `FX Translations P&L`
also increase `skipped` because they report valuation, not cash. Other signed cash adjustments
retain their deposit or withdrawal behavior. This is a non-breaking parsing correction. Existing
generic requests are unchanged.

IBKR Transaction History deposits and withdrawals commit as ordinary brokerage cash in the
statement base currency. When the funding workbook is imported too, in either order or together,
reconciliation pairs each CSV movement with its workbook row and records it once in the
workbook's own currency (see [[docs/adr/236-simplify-portfolio-import-reconciliation#Amendment: cross-export imports (2026-10-21)|the ADR-236 amendment]]).
Batches staged before ADR-236 may still carry `ibkr_source_context`; it is no longer written or
read.

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

Fiat deposits, withdrawals, card payments and trade cash legs have blank symbols and commit as
ordinary signed brokerage cash; each amount is the literal balance movement, fees included.
Under the zero policy, a distribution's literal income commits as a dividend with
`income_recognition_role='included_in_units'` beside its zero-basis units.
Asset withdrawals validate gross units against received units plus same-asset fees and stage dated
custody events requiring explicit `transfer_destination_account_id`. A negative holder adjustment
requires explicit zero policy, a consistent literal amount/balance delta, and enough remaining
eligible yielded units. It stages `asset_adjustment` with null financial type. Other negative
adjustments remain review errors. Actual `source_columns` are retained in batch configuration for
safe literal-record reparsing. Neither custody nor adjustment invents a sale. When review creates an unresolved holding, KAU and KAG are
inferred as `metals`; other Kinesis asset codes use the preset's `crypto` fallback so a mixed export
does not create BTC as a metal. Kinesis-created holdings use USD as their valuation currency even
when the selected source row is an asset deposit with no quote currency.

Generic rows of type `asset_fee` or `asset_transfer_witness` (the former native wallet receipt
format) are rejected with 400.

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

A CSV and a detailed workbook of the same period can be imported in either order or together.
Reconciliation pairs their rows by account, source account and `Bk Record Id`, so each event is
recorded once; the workbook's values win and a CSV dividend with a workbook twin settles without
its error. Rows whose date, type, instrument, units or cash disagree block with
`cross_format_source_conflict`.

The XLSX adapter requires `Transacties`, `_Transacties`, and `Bookings` sheets and joins them by
account and booking-record ID. It validates metadata, identifiers, execution quantities/prices,
booking signs, and agreement between detailed bookings and the net amount within one cent.
Workbook trades use account-currency booked principal, effective unit price, separate commission,
and exchange tax. Dividends use gross booking income and aggregate withholding tax. Embedded FX
conversion costs are not added again. Native quotes and joined booking records remain in internal
typed provenance with sheet/row coordinates and a source-byte hash. Deposits and withdrawals are
instrument-less cash rows. Unknown corporate actions or booking kinds remain review errors.

New IBKR and detailed Saxo dividend records commit with `dividend_amount_convention = 'gross'`.
This retains the adapter's proven amount meaning without changing principal or withholding.
Generic imports retain the existing unknown convention unless separately reviewed.

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

SSE-streaming portfolio history import. Accepts the same CSV/XLSX/XLS request body as the custom
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
survive; restore receipts append rather than mutating adoption receipts. Rollback of a duplicate
repair applied before ADR-236 also restores the removed imported ID/timestamps, original staging pointers/statuses, and counters.
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

`investment_id: null`, or an absent field, clears the override (200). A present value must be a positive integer; it is validated with `validateId`, not coerced, so `"1e3"` is a **400** rather than a link to investment 1000 (see [[docs/security/input-validation#FK ids in write bodies (`parseOverrideId` and the zod FK fields)|input validation]]). The body must be a JSON object: a JSON array returns `400 VALIDATION_ERROR` instead of clearing the override.

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
- The body must be a JSON object. Checks stop at the first failure, so a `400` carries one message.
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
and submit global/per-batch policies.

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
A body that is not a JSON object, such as an array, also returns `400 VALIDATION_ERROR`.
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
supported broker CSV, Saxo XLSX or IBKR funding XLS/XLSX files.
[[docs/adr/236-simplify-portfolio-import-reconciliation|ADR-236]] removed the bounded scopes, the
Kinesis, IBKR, Saxo and Portfolio Performance proofs, duplicate repair and the plan fingerprint.
Receipts written earlier stay readable and are restored on batch rollback. Its amendment adds
cross-export pairing for Saxo CSV and XLSX, for the IBKR Transaction History CSV and funding
workbook, and for manual brokerage cash entries.

> [!warning] Breaking change (ADR-236)
> Preview and commit reject `reconciliation_scope`, `cash_funding_policy` and
> `expected_plan_fingerprint` with 400. Plans no longer include `planFingerprint`,
> `selectedRowIds`, `pending`, `complete`, `deferredCounts`, `batchProgress` or proof fields, and
> commit results no longer include `repaired`, `recordedIncome` or `recordedCash`.

### POST /api/portfolio/import/reconciliation/preview

Preview source identity, adoption, custody continuity, and account-scoped history for a selected
session. This is a read-only database transaction; it creates no canonical rows or journal receipts.

```json
{
  "batch_ids": [42, 43],
  "adopt_policy": "preserve_existing",
  "batch_policies": [{ "batch_id": 43, "adopt_policy": "prefer_source" }],
  "row_choices": [{ "batch_id": 42, "row_id": 901, "choice": "keep_both" }]
}
```

`batch_ids` contains 1–100 numeric safe-integer IDs in `1..9007199254740991`. The service deduplicates and sorts
scope IDs. `adopt_policy` is optional and permits `preserve_existing` or `prefer_source`; absent
policy permits automatic exact adoption only. Optional `batch_policies` contains at most 100
unique selected batch IDs with the same policy enum and overrides the global choice. Optional
`row_choices` answers rows that resemble an existing transaction, and Saxo rows blocked by
`cross_format_identity_missing`: `keep_both` records the row as a new transaction, and
`same_transaction` settles it as a duplicate of its single existing candidate or Saxo twin. Each staged row of the selected batches may occur once. Objects are
strict; unknown fields reject. The JSON scope uses the same safe-integer ceiling as existing
BIGSERIAL batch path IDs.

The envelope's `data` uses camelCase: `batchIds`, `adoptPolicy` (null for automatic exact matching),
`batchPolicies`, `rowChoices` (the applied choices, sorted), `ready`, `actions`, `blockers`, and
`summary`. A cash row whose identity the cash ledger already holds is a `duplicate` with
`cash: true`, so the summary counts what commit settles. Actions identify
batch/staging row, investment, source and existing values, candidate transaction IDs, corrections,
applied policy, and transfer detail when applicable. Kinds include `insert`, `adopt`, `duplicate`,
`duplicate_source`, `cash`, `transfer`, `adjustment`, `internal_annotation`, `settled`, `blocked`, and
`policy_required`. In-kind income is an `insert` whose `source.income_recognition_role` is
`included_in_units`. Blockers identify `batchId`, `rowId`, one-based staging `rowOrdinal`, `reason`,
and candidate IDs.

Rows that another export of the same broker history records carry `crossFormat: true`.
`duplicate_source` names the selected twin in `duplicateOfRowId`; `duplicate` names the existing
transaction; an `adopt` with `cash: true` names an existing brokerage cash transaction, with its
`existing` and `source` date, amount and currency and the `corrections`. A cash adoption either
corrects an earlier IBKR CSV movement to the funding workbook's own amount and currency, or adopts
a manual cash entry (no import fingerprint) with the same account, currency and signed amount
within seven days. A manual entry on another date needs a policy (`policy_required`,
`source_policy_required`). The cross-export blocker reasons are `cross_format_source_conflict`
(the other export disagrees, or the earlier CSV row was edited since import),
`ambiguous_funding_history` and `ambiguous_cash_history` (more candidates than rows could be the
same movement), `funding_date_mismatch` (an IBKR CSV deposit or withdrawal matches a funding
workbook movement in type, account and value, but its date is up to ten days outside the
request–completion window) and `cross_format_identity_missing` (an otherwise identical Saxo CSV
and XLSX row, one without a booking record id; a committed CSV batch without retained
`source_columns` counts its source id as the booking record only when the workbook row's record id
is none of its own `Transactie-ID` or `Booking Id` values). Both clear on the selected statements'
`batchPolicies` or `adoptPolicy` `prefer_source`, which records the pair as one event; the paired
`duplicate` or `duplicate_source` carries `policy: prefer_source`. `funding_date_mismatch` also
clears on `preserve_existing`, which keeps both. `cross_format_identity_missing` never clears on
`preserve_existing`, since keeping both could count one event twice: the owner answers that row
with `row_choices` instead, `same_transaction` recording the pair once (without a `policy`) and
`keep_both` keeping both. With several look-alikes only `keep_both` applies. A per-row answer
outranks the statement policy; answers or policies that disagree across the pair keep it blocked.
A later import of a row the owner paired settles the same way without asking again.
An `adjustment` action carries `adjustment` detail with `date`, `units`, `kind`, `basisPolicy`, and
`accountId`; `summary.adjustment` counts newly planned adjustment events. Their staging financial
`type` is null, and their ledger owns source linkage. Staging ordinals include adapter-derived rows
and are not CSV line numbers.

The planner requires one-to-one legacy attribution, exact source identity, complete staging,
proven economics for source corrections, known incoming basis, and usable custody counterpart
accounts. It rejects ambiguous history, prior assigned/imported legacy candidates, unexplained
currency corrections, source-policy conflicts, and missing Pro companions. Ordinary nearby legacy
matching uses seven calendar days. A candidate must be unassigned or on the row's own account.
An imported candidate recorded under a different source id of the row's own specialized export
format is no candidate, so a regular same-size purchase imports; ids of another format, and ids
from a generic CSV mapping (which different tools share), never exclude a candidate. A remaining assigned or imported candidate
(`existing_assigned_or_imported_history`) or `ambiguous_history` clears on `row_choices`. Literal Nexo Pro proof can extend to 31 days only with exact
executed price, exact units/base-fee explanation, and equivalent cash; raw evidence also binds
staged date, explicit quote fee, and zero tax. Ambiguous matches still block. A ready plan also
validates all projected custody events and new/worsened account oversells. See
[[docs/features/portfolio-import#Reviewed reconciliation|the reconciliation rules]].

### POST /api/portfolio/import/reconciliation/commit

Submit the same `batch_ids`, `adopt_policy`, `batch_policies` and `row_choices` as the preview. Commit locks the
selected batches, their accounts and the portfolio writer, then rebuilds the plan from current
history in the same transaction; it adopts the history as it stands at commit time. A blocked plan
returns `409 reconciliation_required` with its blockers. An existing transaction that changed or
disappeared since planning returns `409 stale_existing_transaction`.

The selected batches must be reviewable (`awaiting_review`, `matching`, or
`complete_with_errors`). Active eligible source/destination accounts are locked in ID order before
the transaction/custody tables. New matched events run across batches by date, batch ID, and source
row index. Adoption preserves transaction IDs and notes and adds source metadata/account assignment.
An immutable before/after receipt owns restoration; the adopted row remains `import_batch_id=null`.
`prefer_source` changes only supported, proven-equivalent financial values. It never changes the
transaction type/notes or invents a currency conversion.

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
        "errors": 0
      }
    ],
    "imported": 2,
    "duplicates": 1,
    "adopted": 1,
    "errors": 0
  }
}
```

Commit applies the plan's adoptions and cross-export settlements before its readiness check, so a
Saxo CSV dividend settled by its workbook twin no longer blocks; a blocked plan still reports the
source-level reason (`incomplete_source`) when there is one. Rolling back a funding workbook batch
restores the CSV movement it corrected; rolling back the CSV batch underneath that correction is
rejected.

`imported`, `duplicates` and `adopted` are disjoint: an adopted row counts only in `adopted`,
although its staging row (and the batch's `rows_duplicate` counter) settles as a duplicate. In the
example, one row was adopted and one other row was already recorded. In-kind income counts in
`imported`. The legacy single-batch commit response, which has no `adopted` field, keeps counting
adopted rows among its `duplicates`.

| Status            | Meaning                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200 OK`          | Preview produced a plan, including a blocked plan; or commit completed atomically                                                                              |
| `400 Bad Request` | Invalid strict request (including the removed scope, funding and fingerprint fields), IDs or policies, missing batch, or non-reviewable scope                 |
| `404 Not Found`   | A selected batch disappeared before the locked commit recheck                                                                                                  |
| `409 Conflict`    | `incomplete_source`, `reconciliation_required`, `stale_existing_transaction`, `paired_income_units_missing` or `atomic_import_failed`; no commit writes         |

Maintained single-batch commit adopts exact history and rejects incomplete/unsafe or
runtime-failed scopes atomically. API support does not prove real-source completeness.

---

## Rate Limits

Every route passes the global API limiter. Since 2026-10-20, `importRateLimiter` (20 req/min,
shared `import` bucket with the budgeting import uploads and commits) applies only to
`/csv/custom`, `/csv/stream`, `/probe`, `/batches/:id/commit`, and `/reconciliation/commit`.
Batch preview, investment overrides, batch list/detail/rollback, saved parsers, and
reconciliation preview no longer share that budget, so a review session or group assignment
cannot exhaust it. See [[docs/security/rate-limiting|Rate Limiting]].

---

## Related

- [[docs/adr/177-reviewed-history-reconciliation-and-custody-ledger|ADR-177]] — receipts, custody model, and guarded migration recovery
- [[docs/adr/236-simplify-portfolio-import-reconciliation|ADR-236]] — removal of the bounded scopes, proofs and plan fingerprint

- [[docs/api/index|API Index]]
- [[docs/features/portfolio-import|Portfolio Import Feature]]
- [[docs/api/imports|Imports API]] — budgeting CSV import (parallel pipeline)
- [[docs/adr/078-portfolio-csv-import|ADR-078: Portfolio CSV Import Architecture]]
- [[docs/reference/data-model|Data Model Reference]] — `portfolio_import_batches`, `portfolio_import_staging_rows`
- [[docs/features/portfolio|Portfolio Feature]]

## Cash rollback integrity

Rollback of owned ledger cash rows uses the same active-account lock and planned-execution guard
as bank import rollback. Reopen a closed account before removing its ledger rows. Planned links
and concurrent ownership changes return a conflict; rollback never silently changes recurrence or
removes linked plan history. Rollback still checks legacy cash receipts before restoring them. See
[[docs/api/transactions]] and [[docs/features/portfolio-import]].
