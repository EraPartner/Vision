---
title: TypeScript Types Reference
type: reference
status: active
date: 2026-04-02
updated: 2026-08-25
tags: [reference, typescript, types, interfaces, frontend, contract-guard, openapi, generated-types, type-safety]
description: Complete reference of Vision frontend TypeScript types. generated.ts is load-bearing through contract-guard.ts, including nullable portfolio transaction PATCH payloads.
aliases: [typescript types, type definitions, interfaces, type reference]
related_code: ["apps/frontend/src/types/api.ts", "apps/frontend/src/types/generated.ts", "apps/frontend/src/types/contract-guard.ts", "apps/frontend/src/types/portfolio.ts", "apps/frontend/src/types/watchlist.ts", "apps/frontend/src/lib/api/splits.ts"]
---

# TypeScript Types Reference

> [!abstract] Purpose
> Complete reference of all TypeScript types and interfaces in the Vision frontend. Use this for understanding data shapes, API contracts, and type-safe development.

---

## Contract Architecture (June 2026)

> [!info] generated.ts is now load-bearing
> The authoritative contract is `openapi.yaml`. From it, `bun run generate:types` produces [[apps/frontend/src/types/generated.ts|generated.ts]] (CI drift-checked). The hand-written, ergonomic types consumed by the ~36 app modules live in [[apps/frontend/src/types/api.ts|api.ts]]. Prior to June 2026, `generated.ts` was imported by **zero** modules — so drift between the two sources was invisible.

**[[apps/frontend/src/types/contract-guard.ts|contract-guard.ts]]** closes that gap with compile-time assertions:

- Imports `components['schemas']` from `generated.ts` and the hand-written types from `api.ts` (plus the per-feature type modules for splits, watchlist, attachments and AI chat)
- **Key coverage check:** every field the app consumes (`Transaction`, `Category`, `Account`, `Recipient`, `Tag`, `PlannedTransaction`, `Investment`, `PortfolioTransaction`, `SplitItem`, `SplitPayment`, `OwedSummaryItem`, `WatchlistItem`, `Attachment`, `ConversationSummary`, `ChatMessage`, `TokenUsage`, `OllamaModel`) must exist as a key in the corresponding generated schema — `bun run typecheck` fails if a field is renamed or removed in the contract
- **Money/quantity check:** money fields (`amount`, `balance`, `amount_eur`, `loan_principal`, `current_price`, `units`, `price_per_unit`, `fees`, `taxes`, `amount_paid`, `total_owed`, `total_paid`, `remaining`, `target_price`, `added_price`) must remain `number` (or `number | null`) in the contract — fails if the OpenAPI spec re-types an amount as a string
- **Portfolio PATCH type:** `PortfolioTransactionUpdate` is derived directly from the generated `updatePortfolioTransaction` request body, so generated optional fields and nullable clear semantics cannot drift from a handwritten copy
- **One-directional and optionality-tolerant:** additive contract changes (new fields) and `required`/`| null` nuances do not cause failures — only consumed-field removals/renames and money-type regressions are caught

> [!note] Money coercion is a separate concern
> `api.ts` types money fields as `number`, but node-postgres returns NUMERIC columns as strings. The repository layer coerces them on emit via `numericColumn` / `coerceNumericFields` (see [[docs/reference/repository-layer|Repository Layer]] and [[docs/reference/code-patterns#money-utility-pattern-phase-9--june-2026|Money Utility Pattern]]). `contract-guard.ts` does not address this runtime conversion — it only enforces that the OpenAPI schema declares them as numeric.

---

## API Types

**Source:** [[apps/frontend/src/types/api.ts]]

### Transaction

```typescript
interface Transaction {
  id: number;
  date: string;          // ISO date (YYYY-MM-DD)
  amount: number;        // Negative = expense, Positive = income
  currency: string;      // ISO 4217
  balance: number | null;
  memo: string | null;
  comment: string | null;
  bank_account: string | null;
  recipient_id: number;
  recipient_bank_account_id: number | null;
  category_id: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
}
```

### Category

```typescript
interface Category {
  id: number;
  general: string;       // e.g., "FOOD"
  detail: string;        // e.g., "GROCERIES"
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
}
```

### Recipient

```typescript
interface Recipient {
  id: number;
  name: string;
  normalized_name: string;
  default_category_id: number | null;
  primary_recipient_id: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
}
```

### PlannedTransaction

```typescript
interface PlannedTransaction {
  id: number;
  planned_date: string;
  amount: number;
  currency: string | null;
  memo: string | null;
  comment: string | null;
  url: string | null;
  bank_account: string | null;
  recipient_id: number | null;
  category_id: number | null;
  is_recurring: boolean;
  recurrence_pattern: string | null;
  is_loan: boolean;
  loan_type: string | null;
  loan_principal: number | null;
  loan_annual_interest_rate: number | null;
  loan_term_months: number | null;
  is_executed: boolean;
  last_executed_date: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
}
```

### PaginatedResponse

```typescript
interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  links: string[];
}
```

---

## Portfolio Types

**Source:** [[apps/frontend/src/types/portfolio.ts]]

### Investment

```typescript
interface Investment {
  id: number;
  name: string;
  symbol: string | null;
  asset_class: AssetClass;
  currency: string;
  current_price: number | null;
  interest_rate: number | null;
  maturity_date: string | null;
  location: string | null;        // Real estate
  municipality: string | null;    // Belgian
  cadastral_income: number | null;
  municipality_tax_rate: number | null;
  notes: string | null;
  is_active: boolean;
  price_provider: PriceProvider;
  price_provider_id: string | null;
  price_provider_url: string | null;
  price_updated_at: string | null;
  created_at: string;
  updated_at: string;
}
```

### AssetClass

```typescript
type AssetClass = 'stock' | 'etf' | 'crypto' | 'metals' | 'real_estate' | 'savings' | 'bond';
```

### PriceProvider

```typescript
type PriceProvider = 'manual' | 'binance' | 'yahoo' | 'kinesis' | 'custom';
```

### PortfolioTransaction

```typescript
interface PortfolioTransaction {
  id: number;
  investment_id: number;
  type: PortfolioTxnType;
  date: string;
  amount: number;
  units: number | null;
  price_per_unit: number | null;
  fees: number;
  taxes: number;
  currency: string;
  note: string | null;
  is_recurring: boolean;
  recurrence_interval: RecurrenceInterval | null;
  recurrence_end_date: string | null;
  fx_rate_to_eur: number | null;
  created_at: string;
  updated_at: string;
}
```

`PortfolioTransactionUpdate` is the PATCH payload type. It excludes the create-only `cash_account_id` field and permits explicit `null` for `fx_rate_to_eur`, `account_id`, `note`, `recurrence_interval`, and `recurrence_end_date`. The edit dialog sends those nulls when a user clears a stored value; `undefined` would omit the key and leave the old backend value unchanged.

### PortfolioTxnType

```typescript
type PortfolioTxnType = 'buy' | 'sell' | 'dividend' | 'fee' | 'tax' | 'interest' | 'rent_income' | 'appreciation' | 'gift';
```

### RecurrenceInterval

```typescript
type RecurrenceInterval = 'daily' | 'weekly' | 'bi-weekly' | 'monthly' | 'quarterly' | 'yearly';
```

### InvestmentSummary

```typescript
interface InvestmentSummary {
  investment: Investment;
  total_units: number;
  average_cost: number;
  current_value: number;
  total_dividends: number;
  total_fees: number;
  realized_gain: number;
  unrealized_gain: number;
  total_gain: number;
  total_gain_percentage: number;
}
```

---

## Watchlist Types

**Source:** [[apps/frontend/src/types/watchlist.ts]]

### WatchlistItem

```typescript
interface WatchlistItem {
  id: number;
  name: string;
  symbol: string | null;
  asset_class: AssetClass;
  target_price: number;
  currency: string;
  notes: string | null;
  price_provider_id: string | null;
  created_at: string;
  updated_at: string;
  current_price?: number;   // Populated by API
  price_change?: number;    // Populated by API
}
```

---

## Split Types

**Source:** [[apps/frontend/src/lib/api/splits.ts]]

Guarded against `components['schemas']['Split'] / ['SplitPayment'] / ['SplitOwed']`
in [[apps/frontend/src/types/contract-guard.ts]].

### SplitItem

```typescript
interface SplitItem {
  id: number;
  transaction_id: number;
  recipient_id: number;
  recipient_name: string | null;
  amount: number;
  amount_paid: number;
  note: string | null;
  is_settled: boolean;
  created_at: string;
  updated_at: string;
}
```

### SplitPayment

```typescript
interface SplitPayment {
  id: number;
  split_id: number;
  amount: number;
  paid_at: string;
  note: string | null;
  created_at: string;
}
```

### OwedSummaryItem

One row per recipient from `GET /api/splits/owed` — a flat list, not a nested tree.

```typescript
interface OwedSummaryItem {
  recipient_id: number;
  recipient_name: string;
  total_owed: number;
  total_paid: number;
  remaining: number;
  split_count: number;
}
```

---

## Settings Types

### AppSettings

```typescript
interface AppSettings {
  language: 'en' | 'nl';
  defaultCurrency: string;
  numberFormat: string;
  dateFormat: string;
  startOfWeek: number;
  showDecimalPlaces: boolean;
  defaultPageSize: number;
}
```

### WidgetVisibility

```typescript
interface WidgetVisibility {
  [page: string]: {
    [widget: string]: boolean;
  };
}
```

---

## API Request/Response Types

### CreateTransactionRequest

```typescript
interface CreateTransactionRequest {
  date: string;
  amount: number;
  recipient_id: number;
  category_id?: number;
  memo?: string;
  comment?: string;
  currency?: string;
  bank_account?: string;
}
```

### CreateInvestmentRequest

```typescript
interface CreateInvestmentRequest {
  name: string;
  symbol?: string;
  asset_class: AssetClass;
  currency?: string;
  current_price?: number;
  price_provider?: PriceProvider;
  price_provider_id?: string;
  price_provider_url?: string;
  // Real estate specific
  municipality?: string;
  cadastral_income?: number;
  municipality_tax_rate?: number;
  // Savings/Bonds specific
  interest_rate?: number;
  maturity_date?: string;
}
```

---

## Related

- [[docs/reference/code-patterns]] — Code patterns (Money Utility Pattern)
- [[docs/reference/repository-layer]] — Repository layer (NUMERIC coercion on emit)
- [[docs/api/index]] — API documentation
- [[docs/reference/react-query-keys]] — React Query keys
