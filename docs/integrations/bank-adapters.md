---
title: Integration - Bank Adapters
type: integration
description: Bank API integrations for CSV imports
date: 2026-04-25
updated: 2026-05-12
tags: [integration, bank, csv, import, ing, bnp]
status: active
related_code: [[apps/node-backend/src/services/importPipeline/adapters/index.js]]
---

# Integration: Bank Adapters

## Overview

Bank adapters parse CSV files from various banks into a normalized transaction format.

## Architecture

Each bank adapter:
1. Parses bank-specific CSV format
2. Normalizes to common transaction structure
3. Generates deduplication hash
4. Returns standardized transaction data

## Supported Banks

### Belfius
- **Fields**: own_account (col 0, IBAN), transaction_date, amount, recipient_name, recipient_account, balance
- **Date Format**: DD/MM/YYYY
- **Separator**: ;
- **Features**: Full transaction details including BIC and location; account = own IBAN (col 0), canonicalized (ADR-088)

### Revolut
- **Fields**: completed_date, amount, fee, currency, state
- **Date Format**: ISO 8601
- **States**: COMPLETED, PENDING, REVERTED, DECLINED
- **Features**: Multi-currency support, fees tracking

### ING
- **Fields**: booking_date, amount, counterparty_account, transaction_number, description, detail, message
- **Date Format**: DD/MM/YYYY
- **Separator**: ;
- **Columns**: Rekeningnummer, Naam van de rekening, Rekening tegenpartij, Omzetnummer, Boekingsdatum, Valutadatum, Bedrag, Munteenheid, Omschrijving, Detail van de omzet, Bericht
- **Detection**: Header contains `Omzetnummer` + `Detail van de omzet`
- **Features**: Counterparty IBAN, transaction reference, free-text message field

### KBC
- **Fields**: own_account (col 0, `Rekeningnummer`, IBAN), transaction_date, amount, counterparty_name, structured_communication
- **Date Format**: DD/MM/YYYY
- **Separator**: ;
- **Features**: Belgian structured communications (OCR); account = own IBAN (col 0), canonicalized (ADR-088)

### BNP Paribas Fortis
- **Fields**: sequence_number, execution_date, amount, transaction_type, counterparty_iban, counterparty_name, memo, details, status
- **Date Format**: DD/MM/YYYY
- **Separator**: ;
- **Columns**: Volgnummer, Uitvoeringsdatum, Valutadatum, Bedrag, Valuta rekening, Rekeningnummer, Type verrichting, Tegenpartij, Naam van de tegenpartij, Mededeling, Details, Status, Reden van weigering
- **Detection**: Header contains `Volgnummer` + `Uitvoeringsdatum` + `Valuta rekening`
- **Features**: Dutch-language export; supports comma and dot decimal formats (via `parseAmountField`); counterparty IBAN parsing

### SABB
- **Fields**: transaction_date, posting_date, description, amount
- **Date Format**: DD/MM/YYYY
- **Features**: Posting date vs transaction date

### Wise
- **Fields**: finished_on, source_amount, target_amount, exchange_rate, fee
- **Date Format**: ISO 8601
- **Features**: Multi-currency with exchange rates

### Vision (Internal)
- **Fields**: date, recipient, memo, amount
- **Purpose**: Internal format for manual entry

### Custom
- **Purpose**: User-defined column mapping
- **Configuration**: Date format, column names, separator
- **Date Parsing (2026-04-25)**: Generic adapter now uses `Date.UTC()` with explicit numeric components for all date formats, eliminating timezone-dependent parsing of unpadded dates (e.g., `5/1/2025`). This ensures dates are parsed consistently regardless of the server's local timezone, preventing off-by-one date shifts during import.
- **CRLF Safety (2026-04-28)**: All adapters (Belfius, KBC, Custom, Generic) now use `splitCsvLines()` helper which splits on `\r\n|\r|\n` for cross-platform compatibility. CSV files exported from Windows (CRLF line endings) no longer corrupt column indices.
- **EU Decimal Format (2026-04-28)**: `parseAmountField()` rewritten to handle both EU (`1.234,56`) and US (`1,234.56`) decimal formats correctly, including parens-for-negative with internal whitespace. Legacy version stripped ALL commas, breaking European amounts by a factor of 1000.

## Adding New Banks

1. Create parser in `apps/node-backend/src/services/bankAdapters.js`
2. Register in `getSupportedBanks()`
3. Handle all edge cases (missing fields, date formats)

## Field Mapping

Each adapter maps to standard transaction:
```javascript
{
  date: Date,
  amount: Number,
  recipient: String,
  memo: String,
  bankAccount: String, // the OWN account identifier — see "Account Identification" below
  currency: String,
  balance: Number
}
```

## Account Identification (ADR-088)

`bankAccount` is the parsed string that becomes the transaction's **owning account**: at import,
`importPipeline/commit.js` writes it to `transactions.bank_account`, and the dual-write trigger
(migration 0051) resolves it to `account_id` (resolve-or-create an `accounts` row whose `name` is
the trimmed string). So the value each adapter emits *is* the account identity.

**Per-adapter identifier:**

| Adapter | `bankAccount` source | Example |
|---|---|---|
| Belfius | own IBAN — column 0 (`Rekening`), canonicalized | `BE81063756944024` |
| KBC | own IBAN — column 0 (`Rekeningnummer`), canonicalized | `BE61734041478017` |
| BNP Paribas Fortis | own IBAN — `Rekeningnummer` column, canonicalized | `BE…` |
| ING | own IBAN — `Rekeningnummer` column, canonicalized | `BE…`/`NL…` |
| Revolut | `REVOLUT <PRODUCT>` (per product) | `REVOLUT CURRENT` |
| Wise | `WISE <CURRENCY>` (per currency) | `WISE EUR` |
| Vision | the `Bank Account` column, UPPER+trim | `MAIN` |
| Generic/Custom | `bank_name` (+ ` <ACCOUNT_TYPE>`), UPPER+trim | `MYBANK CHECKING` |

**IBAN canonicalization (`canonicalIban` in `adapters/_shared.js`):** IBAN-based adapters (Belfius,
KBC, BNP, ING) strip all whitespace and uppercase the account number, so a Belgian IBAN exported
space-grouped (`BE81 0637 5694 4024`) and one entered without spaces resolve to the **same** account
— no duplicate accounts from spacing/case. A CSV that spans multiple of your own accounts therefore
splits correctly into one account per IBAN. Non-IBAN adapters use `normalizeToUppercase` (UPPER+trim,
spaces preserved), matching the manual-entry path (`transactionRepository.create` uppercases too).

> [!note] Account labels changed 2026-06-18 (ADR-088)
> Belfius/KBC previously emitted the literals `'BELFIUS'`/`'KBC'`; they now emit the own IBAN.
> Transactions imported under the old literals keep their `'BELFIUS'`/`'KBC'` account; **merge** the
> old literal account into the IBAN account in the Accounts hub to unify history (see
> [[docs/api/accounts|Accounts API]] — `POST /api/accounts/:id/merge`).

## Related

- [[docs/api/imports|API: Imports]]
- [[docs/features/import|Feature: Import & Deduplication]]
