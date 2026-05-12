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
- **Fields**: transaction_date, amount, recipient_name, recipient_account, balance
- **Date Format**: DD/MM/YYYY
- **Separator**: ;
- **Features**: Full transaction details including BIC and location

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
- **Fields**: transaction_date, amount, counterparty_name, structured_communication
- **Date Format**: DD/MM/YYYY
- **Separator**: ;
- **Features**: Belgian structured communications (OCR)

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
  bankAccount: String,
  currency: String,
  balance: Number
}
```

## Related

- [[docs/api/imports|API: Imports]]
- [[docs/features/import|Feature: Import & Deduplication]]
