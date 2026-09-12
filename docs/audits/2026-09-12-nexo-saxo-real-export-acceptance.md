---
title: Nexo and Saxo real-export acceptance
description: Sanitized real-export evidence for the maintained Nexo and Saxo portfolio import presets.
status: accepted
date: 2026-09-12
---

# Nexo and Saxo real-export acceptance

## Scope

Two user-supplied sanitized CSV exports were checked directly against the maintained portfolio
adapters on 2026-09-12. The source rows were not copied into the repository. This audit records
only schema and aggregate evidence; the regression fixtures contain synthetic identifiers and
values.

| Export                   | SHA-256                                                            | Source rows | Parsed rows | Skipped rows |
| ------------------------ | ------------------------------------------------------------------ | ----------: | ----------: | -----------: |
| Nexo Transaction history | `3a18b93fc5f02df5f6f6471de4df0451e4f6b5c72ba653e987be8141f75272e2` |          48 |          51 |            0 |
| Saxo Transactions        | `e9c1b825a9a8ef1c50fd8996ec1c0bf0367f6f4cf8413e8eaf7f432a3d8e49ba` |          17 |          17 |            0 |

## Nexo evidence

- The export has the documented 11-column Transaction history schema.
- It covers nine event types, including both conversion directions, wallet lifecycle rows, Pro
  wallet transfers, interest, top-ups, and withdrawals.
- USD-equivalent cells use currency-decorated dot-decimal values. Fee rows include fiat and
  suffixed asset currencies.
- Nexo has asset-code columns rather than separate instrument and symbol columns. All supplied
  codes were present and normalized cleanly, so instrument-less and noisy-symbol cases are not
  applicable to this export. The supplied sample contains no comma-decimal cells.
- Three interest source rows intentionally become six staged rows: one income row and one acquired
  unit row per event.
- Thirty-seven ambiguous lifecycle, transfer, withdrawal, or fee cases remain explicit review rows.
  No source row is silently discarded.

The synthetic Nexo fixture pins the real headers and cell shapes while adding named boundary cases
for unambiguous buys and sells, non-USD fees, and incomplete conversions.

## Saxo evidence

- The export has the documented localized 29-column Transactions schema, including exporter
  whitespace in booking headers.
- Five cash rows are instrument-less, and twelve instrument rows use noisy `ticker:venue` symbols.
- The sample covers Dutch trades, cash dividends, deposits, and a withdrawal. All 17 source rows
  produce one staged row.
- Numeric cells in this sample use dot decimals. The synthetic fixture separately pins the
  supported localized comma-decimal boundary.

The synthetic Saxo fixture retains no supplied usernames, account identifiers, transaction
identifiers, instruments, or amounts.

## Safety result

Both formats are maintained brokerage presets. Every import stops at staged review even when all
symbols match, so the explicit Nexo review rows cannot reach the portfolio ledger without user
confirmation.
