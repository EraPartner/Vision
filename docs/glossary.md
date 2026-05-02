---
title: Glossary & Terminology
type: reference
status: active
date: 2026-03-31
tags: [glossary, terminology, reference, search]
description: Key terms, aliases, and disambiguation for the Vision project - helps with search and navigation
aliases: [glossary, terms, terminology, dictionary, vocabulary, disambiguation]
---

# Glossary & Terminology

> [!abstract] Purpose
> This glossary helps both humans and AI agents find the right documentation when searching for concepts. Many terms in Vision have multiple names across code, docs, and UI.

## Core Concepts

| Term | Also Known As | Description | See Also |
|------|--------------|-------------|----------|
| **Transaction** | financial record, entry | A single income or expense record. Negative = expense, positive = income. | [[docs/features/transactions\|Transactions]] |
| **Category** | label, tag | Organization label in `GENERAL:DETAIL` format (e.g., `FOOD:GROCERIES`). | [[docs/api/categories\|Categories API]] |
| **Recipient** | payee, payer, counterparty | Person or entity associated with a transaction. | [[docs/api/recipients\|Recipients API]] |
| **Planned Transaction** | planned payment, scheduled payment, recurring payment | Future-dated transaction that can be one-time or recurring. | [[docs/features/plannedTransactions\|Planned Transactions]] |
| **Portfolio** | investments, holdings | Collection of investment holdings (stocks, ETFs, crypto, metals, real estate, savings, bonds). | [[docs/features/portfolio\|Portfolio]] |
| **Investment** | holding, asset | A single portfolio position (e.g., "Apple Inc." stock). | [[docs/api/investments\|Investments API]] |
| **Watchlist** | watch list, tracked symbols | List of symbols to track with target prices. | [[docs/api/watchlist\|Watchlist API]] |
| **Split** | owed, debt, shared expense | Division of a transaction amount among multiple recipients. | [[docs/api/splits\|Splits API]] |
| **Import** | bank import, CSV import | Process of bringing transaction data from bank CSV files. | [[docs/features/import\|Import]] |
| **Bank Adapter** | bank parser, import parser | Code that parses a specific bank's CSV format. | [[docs/integrations/bank-adapters\|Bank Adapters]] |

## Price Providers

| Provider | Asset Types | Description |
|----------|-------------|-------------|
| **Binance** | Crypto | Primary crypto price provider |
| **Yahoo Finance** | Stocks, ETFs | Primary stock price provider |
| **Kinesis** | US Stocks | US stock price provider (alternative) |
| **Custom** | Any | Manual price input via JSON API |

> [!warning] Deprecated Providers
> **CoinGecko** and **Kraken** were removed and replaced by **Binance** (migration 0021). Any docs still mentioning them are outdated.

## Technical Terms

| Term | Description | See Also |
|------|-------------|----------|
| **Materialized View** | Pre-computed database query result for fast dashboard loading | [[docs/performance/materialized-views\|Materialized Views]] |
| **Performance Snapshot** | Daily cached portfolio performance data | [[docs/performance/caching-strategies\|Caching]] |
| **LTTB** | Largest-Triangle-Three-Buckets downsampling algorithm for charts | [[docs/performance/chart-downsampling\|Chart Downsampling]] |
| **Inheritance Tables** | PostgreSQL table inheritance pattern for investments | [[docs/adr/002-database-schema\|Database Schema]] |
| **Raw Transactions** | Bank-specific raw data stored before creating normalized transactions | [[docs/features/import\|Import]] |
| **Deduplication Hash** | SHA-256 hash used to prevent duplicate imports | [[docs/features/import\|Import]] |
| **Override Category ID** | Per-row category assignment during import review (can optionally persist to recipient default) | [[docs/adr/046-import-review-category-assignment\|ADR-046]] |

## UI Terms

| Term | Description | See Also |
|------|-------------|----------|
| **Widget** | Dashboard component that can be shown/hidden | [[docs/components/dashboard\|Dashboard]] |
| **Combobox** | Searchable dropdown selector | [[docs/components/form-dialogs\|Form Dialogs]] |
| **Virtual Table** | Table with virtual scrolling for large datasets | [[docs/components/form-dialogs\|VirtualDataTable]] |

## Tax Terms (Belgian)

| Term | Description | See Also |
|------|-------------|----------|
| **Cadastral Income** | Estimated rental value of real estate (Belgian tax) | [[docs/features/portfolio\|Portfolio]] |
| **Municipality Tax** | Local tax rate based on residence | [[docs/features/portfolio\|Portfolio]] |
| **HICP** | Harmonised Index of Consumer Prices (Eurostat inflation) | [[docs/features/portfolio\|Portfolio]] |
| **Statbel** | Belgian statistics office (primary inflation source) | [[docs/features/portfolio\|Portfolio]] |

## Search Tips

When searching the KB:
- Search **"investments"** → finds [[docs/api/investments\|Investments API]] and [[docs/features/portfolio\|Portfolio]]
- Search **"planned payments"** → finds [[docs/features/plannedTransactions\|Planned Transactions]]
- Search **"splits"** or **"owes"** → finds [[docs/api/splits\|Splits API]] and [[docs/features/views\|Owes Page]]
- Search **"bank import"** → finds [[docs/features/import\|Import]] and [[docs/integrations/bank-adapters\|Bank Adapters]]
