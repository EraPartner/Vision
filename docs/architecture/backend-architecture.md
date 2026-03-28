---
title: Backend Architecture
description: Node.js backend architecture and diagrams
date: 2026-03-28
tags: [architecture, backend, uml, plantuml]
---

# Backend Architecture

This document contains UML diagrams for the Node.js backend application.

> **Note**: These diagrams are generated from the codebase and should be regenerated when significant changes are made.

## Domain Model

The core entities and their relationships.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 50
skinparam ranksep 80

package "Core Entities" {
  class Transaction {
    +id: integer
    +date: date
    +amount: numeric(15,2)
    +currency: varchar(3)
    +balance: numeric(15,2)
    +memo: text
    +comment: text
    +bank_account: text
    +recipient_id: integer <<FK>>
    +recipient_bank_account_id: integer <<FK>>
    +category_id: integer <<FK>>
    +is_active: boolean
  }

  class Recipient {
    +id: integer
    +name: text
    +normalized_name: text
    +default_category_id: integer <<FK>>
    +primary_recipient_id: integer <<FK>>
    +notes: text
    +is_active: boolean
  }

  class Category {
    +id: integer
    +general: text
    +detail: text
    +description: text
    +is_active: boolean
  }

  class RecipientBankAccount {
    +id: integer
    +recipient_id: integer <<FK>>
    +account_number: varchar(34)
    +bank_name: text
    +is_primary: boolean
    +is_active: boolean
  }

  class PlannedTransaction {
    +id: integer
    +planned_date: date
    +amount: numeric(15,2)
    +recipient_id: integer <<FK>>
    +category_id: integer <<FK>>
    +is_recurring: boolean
    +recurrence_pattern: text
    +is_loan: boolean
    +is_executed: boolean
    +is_active: boolean
  }

  class PlannedTransactionExecution {
    +id: integer
    +planned_transaction_id: integer <<FK>>
    +executed_transaction_id: integer <<FK>>
    +execution_date: date
  }

  class PlannedTransactionLoanSchedule {
    +id: integer
    +planned_transaction_id: integer <<FK>>
    +installment_number: integer
    +due_date: date
    +payment_amount: numeric(15,2)
    +principal_amount: numeric(15,2)
    +interest_amount: numeric(15,2)
    +remaining_principal: numeric(15,2)
  }
}

package "Investment & Portfolio" {
  class Investment {
    +id: integer
    +name: varchar(200)
    +symbol: varchar(20)
    +asset_class: asset_class
    +currency: varchar(10)
    +current_price: numeric(18,6)
    +is_active: boolean
  }

  class PortfolioTransaction {
    +id: integer
    +investment_id: integer <<FK>>
    +type: portfolio_txn_type
    +date: date
    +amount: numeric(18,4)
    +units: numeric(18,8)
    +fx_rate_to_eur: numeric(20,10)
  }

  class Watchlist {
    +id: integer
    +name: varchar(200)
    +symbol: varchar(20)
    +asset_class: asset_class
    +target_price: numeric(18,6)
  }
}

package "Supporting Entities" {
  class ExchangeRate {
    +id: integer
    +currency_code: varchar(3)
    +rate_to_eur: numeric(20,10)
    +rate_date: date
    +is_latest: boolean
  }

  class UserSetting {
    +key: text
    +value: jsonb
  }

  class SavedChart {
    +id: integer
    +name: text
    +chart_type: text
    +category_ids: integer[]
  }
}

' Relationships
Recipient "1" --> "0..1" Recipient : primary_recipient_id
Recipient "1" --> "0..1" Category : default_category_id
Recipient "1" *-- "*" RecipientBankAccount
Recipient "1" *-- "*" Transaction

Category "1" <-- "*" Transaction
Category "1" <-- "*" PlannedTransaction
Category "1" <-- "*" Recipient

Transaction "1" --> "0..1" RecipientBankAccount

PlannedTransaction "1" --> "0..1" Recipient
PlannedTransaction "1" --> "0..1" Category
PlannedTransaction "1" *-- "*" PlannedTransactionExecution
PlannedTransaction "1" *-- "*" PlannedTransactionLoanSchedule
PlannedTransactionExecution "1" --> "0..1" Transaction : executed_transaction_id

Investment "1" *-- "*" PortfolioTransaction

@enduml
```

Source diagram: [[docs/diagrams/backend-api-layer.puml]]

## Repository Layer

Data access layer showing repositories and their dependencies.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 40
skinparam ranksep 60

package "Database" {
  class "connection.js" as DB {
    +query(sql, params)
    +getClient()
  }
}

package "Repositories" {
  class TransactionRepository {
    +getAll(opts)
    +getCount(opts)
    +getAllWithCount(opts)
    +getById(id)
    +create(data)
    +update(id, fields)
  }

  class RecipientRepository {
    +getAll(opts)
    +getById(id)
    +createOrGet(data)
    +update(id, fields)
    +mergeRecipients(primaryId, aliasIds)
  }

  class CategoryRepository {
    +getAll(opts)
    +getById(id)
    +createOrGet(data)
    +update(id, fields)
  }

  class PlannedTransactionRepository {
    +getAll(opts)
    +getById(id)
    +create(data)
    +update(id, fields)
    +addExecution(id, txId, date)
  }

  class InvestmentRepository {
    +getAll(opts)
    +getById(id)
    +create(data)
    +update(id, fields)
  }

  class PortfolioTransactionRepository {
    +getAll(opts)
    +getByInvestment(investmentId)
    +create(data)
  }

  class WatchlistRepository
  class RecipientBankAccountRepository
  class SplitRepository
  class SettingsRepository
  class SavedChartsRepository
  class RawTransactionRepository
  class InfoRepository
}

' Relationships
DB <.. TransactionRepository
DB <.. RecipientRepository
DB <.. CategoryRepository
DB <.. PlannedTransactionRepository
DB <.. InvestmentRepository
DB <.. PortfolioTransactionRepository

@enduml
```

## Service Layer

Business logic services and their interactions.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 40
skinparam ranksep 50

package "Import Services" {
  class ImportService {
    +importCSV(filePath, bankName, config)
  }

  class DataImportService
  class StreamingImportService
  class RawTransactionImportService
}

package "Business Logic Services" {
  class RecurringDetectionService {
    +detectRecurring()
  }

  class RecurrenceService {
    +generateOccurrences(startDate, pattern, endDate)
    +getNextOccurrence(date, pattern)
  }

  class LoanRepaymentService {
    +calculateAmortizationSchedule(principal, rate, months)
    +calculateMonthlyPayment(principal, rate, months)
  }

  class DeduplicationService {
    +isDuplicateByFields(date, amount, recipient, memo)
  }
}

package "External Services" {
  class CurrencyConversionService {
    +convert(amount, from, to)
    +getExchangeRate(from, to)
  }

  class PriceProviderService {
    +fetchPrice(provider, symbol)
    +updateInvestmentPrices()
  }

  class BankAdapters {
    +createAdapter(bankName, config)
  }
}

package "Supporting Services" {
  class TextNormalization {
    +normalizeForMatching(text)
  }

  class IBANService {
    +validate(iban)
  }

  class MaterializedViewService {
    +refreshMaterializedViews()
  }
}

ImportService --> BankAdapters
ImportService --> DeduplicationService

@enduml
```

## API Layer

Express routes and their connections to repositories and services.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 30
skinparam ranksep 50

package "Express App" {
  class Main
}

package "Routes" {
  class TransactionsRouter
  class CategoriesRouter
  class RecipientsRouter
  class PlannedTransactionsRouter
  class InvestmentsRouter
  class ImportRouter
  class SettingsRouter
  class WatchlistRouter
  class SavedChartsRouter
  class SplitsRouter
  class MarketLookupRouter
  class InfoRouter
  class AdminRouter
}

package "Repositories" {
  class TR
  class CR
  class RR
  class PTR
  class IR
}

Main --> TransactionsRouter
Main --> CategoriesRouter
Main --> RecipientsRouter
Main --> PlannedTransactionsRouter
Main --> InvestmentsRouter
Main --> ImportRouter
Main --> SettingsRouter

TransactionsRouter --> TR
CategoriesRouter --> CR
RecipientsRouter --> RR
PlannedTransactionsRouter --> PTR
InvestmentsRouter --> IR

@enduml
```

## Database Schema

ERD showing all tables and their relationships.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 25
skinparam ranksep 40
hide circle

entity "categories" as categories {
  * id : serial <<PK>>
  * general : text
  * detail : text
  description : text
  is_active : boolean
}

entity "recipients" as recipients {
  * id : serial <<PK>>
  * name : text
  * normalized_name : text <<UQ>>
  default_category_id : integer <<FK>>
  primary_recipient_id : integer <<FK>>
  notes : text
  is_active : boolean
}

entity "recipient_bank_accounts" as rba {
  * id : serial <<PK>>
  * recipient_id : integer <<FK>>
  * account_number : varchar(34) <<UQ>>
  bank_name : text
  is_primary : boolean
  is_active : boolean
}

entity "transactions" as transactions {
  * id : serial <<PK>>
  * date : date
  * amount : numeric(15,2)
  currency : varchar(3)
  memo : text
  comment : text
  * recipient_id : integer <<FK>>
  recipient_bank_account_id : integer <<FK>>
  category_id : integer <<FK>>
  is_active : boolean
}

entity "planned_transactions" as pt {
  * id : serial <<PK>>
  * planned_date : date
  * amount : numeric(15,2)
  recipient_id : integer <<FK>>
  category_id : integer <<FK>>
  is_recurring : boolean
  is_loan : boolean
  is_executed : boolean
  is_active : boolean
}

entity "planned_transaction_executions" as pte {
  * id : serial <<PK>>
  * planned_transaction_id : integer <<FK>>
  * executed_transaction_id : integer <<FK>>
  * execution_date : date
}

entity "investments_base" as investments_base {
  * id : serial <<PK>>
  * name : varchar(200)
  currency : varchar(10)
  is_active : boolean
}

entity "stock_investments" as stock_investments {
  * id : integer <<PK>>
  symbol : varchar(20)
  current_price : numeric(18,6)
}

entity "etf_investments" as etf_investments {
  * id : integer <<PK>>
  symbol : varchar(20)
  current_price : numeric(18,6)
}

entity "crypto_investments" as crypto_investments {
  * id : integer <<PK>>
  symbol : varchar(50)
  current_price : numeric(18,6)
}

entity "real_estate_investments" as real_estate_investments {
  * id : integer <<PK>>
  current_price : numeric(18,6)
  location : varchar(300)
  municipality : varchar(200)
  cadastral_income : numeric(12,2)
  municipality_tax_rate : numeric(8,4)
}

entity "savings_investments" as savings_investments {
  * id : integer <<PK>>
  current_price : numeric(18,6)
  interest_rate : numeric(8,4)
}

entity "bond_investments" as bond_investments {
  * id : integer <<PK>>
  current_price : numeric(18,6)
  interest_rate : numeric(8,4)
  maturity_date : date
}

entity "portfolio_transactions_base" as portfolio_transactions_base {
  * id : serial <<PK>>
  * investment_id : integer
  * type : portfolio_txn_type
  * date : date
  * amount : numeric(18,4)
  currency : varchar(10)
  fx_rate_to_eur : numeric(20,10)
}

entity "stock_transactions" as stock_transactions {
  * id : integer <<PK>>
  * investment_id : integer
  units : numeric(18,8)
}

entity "etf_transactions" as etf_transactions {
  * id : integer <<PK>>
  * investment_id : integer
  units : numeric(18,8)
}

entity "crypto_transactions" as crypto_transactions {
  * id : integer <<PK>>
  * investment_id : integer
  units : numeric(18,8)
}

entity "real_estate_transactions" as real_estate_transactions {
  * id : integer <<PK>>
  * investment_id : integer
}

entity "savings_transactions" as savings_transactions {
  * id : integer <<PK>>
  * investment_id : integer
}

entity "bond_transactions" as bond_transactions {
  * id : integer <<PK>>
  * investment_id : integer
}

entity "watchlist" as watchlist {
  * id : serial <<PK>>
  * name : varchar(200)
  symbol : varchar(20)
  * asset_class : asset_class
  * target_price : numeric(18,6)
  currency : varchar(10)
}

entity "exchange_rates" as er {
  * id : serial <<PK>>
  * currency_code : varchar(3)
  * rate_to_eur : numeric(20,10)
  * rate_date : date
  is_latest : boolean
}

recipients }|--|| categories : default_category_id
recipients }|--|| recipients : primary_recipient_id
rba }|--|| recipients
transactions }|--|| recipients
transactions }|---|| rba
transactions }|---|| categories
pt }|---|| recipients
pt }|---|| categories
pte }|--|| pt
pte }|--|| transactions
investments_base ||--|| stock_investments : inherits
investments_base ||--|| etf_investments : inherits
investments_base ||--|| crypto_investments : inherits
investments_base ||--|| real_estate_investments : inherits
investments_base ||--|| savings_investments : inherits
investments_base ||--|| bond_investments : inherits

portfolio_transactions_base ||--|| stock_transactions : inherits
portfolio_transactions_base ||--|| etf_transactions : inherits
portfolio_transactions_base ||--|| crypto_transactions : inherits
portfolio_transactions_base ||--|| real_estate_transactions : inherits
portfolio_transactions_base ||--|| savings_transactions : inherits
portfolio_transactions_base ||--|| bond_transactions : inherits

stock_investments ||--o{ stock_transactions
etf_investments ||--o{ etf_transactions
crypto_investments ||--o{ crypto_transactions
real_estate_investments ||--o{ real_estate_transactions
savings_investments ||--o{ savings_transactions
bond_investments ||--o{ bond_transactions

@enduml
```

## Import Pipeline

End-to-end flow showing how CSV files are imported, parsed, deduplicated, and stored.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 30
skinparam ranksep 40

package "Frontend" {
  class ImportPage
  class ImportForm
}

package "Import Service" {
  class ImportService
  class BankAdapters
  class CSVParser
  class DeduplicationService
  class RecipientService
}

package "Raw Tables" {
  class BelfiusRaw
  class RevolutRaw
  class KbcRaw
  class WiseRaw
  class CustomRaw
}

package "Core Tables" {
  class Transactions
  class Recipients
}

ImportPage --> ImportForm : Upload CSV
ImportForm --> Backend : POST /api/import/csv

Backend --> BankAdapters : Parse CSV
BankAdapters --> CSVParser
CSVParser --> DeduplicationService : Check Duplicates
DeduplicationService --> RecipientService : Resolve Recipient
RecipientService --> RawTables : Store Raw First

RawTables --> DeduplicationService : Mark Duplicates
DeduplicationService --> ImportService : Insert New
ImportService --> Transactions : INSERT

note right of ImportService
  Phase 1: 20 concurrent
  Phase 2: 250 rows/batch
end note

@enduml
```

## System Architecture

High-level view of the complete system architecture.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 35
skinparam ranksep 60

actor "User" as User

package "Client" {
  rectangle "Browser (React App)" {
    node "React 18 + TypeScript" as ReactApp
    node "Vite" as Vite
    node "Tailwind CSS + Radix UI" as UI
    node "React Router v7" as Router
    node "TanStack Query" as ReactQuery
    node "React Context" as Context
  }
}

cloud "HTTP/JSON" as Network

package "Server" {
  rectangle "Node.js Backend" {
    node "Express.js" as Express
    node "Middleware" as Middleware {
      CORS, Compression, Rate Limiter
    }
    node "Routes" as Routes
    node "Services" as Services
    node "Repositories" as Repos
  }
}

database "PostgreSQL 18" as DB {
  node "Tables"
  node "Materialized Views"
  node "Indexes"
  node "Triggers"
}

cloud "External Services" as External {
  node "ECB (Exchange Rates)"
  node "CoinGecko (Crypto)"
  node "Yahoo Finance (Stocks)"
  node "Kraken (Crypto)"
}

User --> ReactApp : HTTPS
ReactApp --> Express : REST API
Express --> Middleware
Middleware --> Routes
Routes --> Services
Services --> Repos
Repos --> DB : SQL
Services --> External : API Calls

@enduml
```

## Deployment Architecture

Development, production (Docker), and desktop deployment models.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 35
skinparam ranksep 50

package "Development" {
  node "Local Machine" as Dev {
    component "Frontend (Vite)" as FrontendDev
    component "Node.js (Bun)" as BackendDev
    component "PostgreSQL" as PostgresDev
  }
}

package "Production (Docker)" {
  node "Docker Host" as DockerHost {
    container "app" as AppContainer {
      node "Node.js Server"
      node "Static Files"
    }
    container "db" as DBContainer {
      node "PostgreSQL 18"
    }
  }
}

package "Desktop (Electron)" as Desktop {
  node "Electron Main"
  node "Electron Renderer"
}

actor "User" as User

User --> Dev : Dev Access
User --> DockerHost : HTTPS
User --> Desktop : Desktop App

Dev --> PostgresDev
AppContainer --> DBContainer
Desktop --> AppContainer

@enduml
```

## Currency Conversion Flow

How exchange rates are fetched, cached, and used for currency normalization.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 30
skinparam ranksep 40

actor "User" as User

package "Frontend" {
  class TransactionPage
  class ApiClient
}

package "Backend Services" {
  class CurrencyConversionService {
    +convert(amount, from, to)
    +getExchangeRate(from, to)
  }
  class ExchangeRateRepository
}

cloud "ECB API" as ECB
database "PostgreSQL" as DB {
  table "exchange_rates"
}

User --> TransactionPage : View EUR
TransactionPage --> ApiClient : GET /transactions?normalize_to_eur=true
ApiClient --> CurrencyConversionService : convert(100, USD, EUR)
CurrencyConversionService --> ExchangeRateRepository : getExchangeRate(USD, EUR)

alt Cache hit
  ExchangeRateRepository --> DB : SELECT
  DB --> ExchangeRateRepository : rate
else Cache miss
  ExchangeRateRepository --> ECB : GET /rates
  ECB --> ExchangeRateRepository : rates
  ExchangeRateRepository --> DB : INSERT
end

ExchangeRateRepository --> CurrencyConversionService : rate
CurrencyConversionService --> ApiClient : converted
ApiClient --> TransactionPage : EUR amount
TransactionPage --> User : display

@enduml
```

## Price Provider Flow

Automatic price updates for investments from external providers.

Migration compatibility note:
- `0017_investment_custom_provider_history` updates inheritance compatibility for custom-provider latest/history fields and metals view/trigger wiring ([[alembic/versions/0017_investment_custom_provider_history.py]]).
- `0019_asset_price_history_cache` adds persisted historical quote cache (`asset_price_history`) used by read-through provider history fetches and startup backfill for held assets ([[alembic/versions/0019_asset_price_history_cache.py]]).

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 30
skinparam ranksep 40

package "Backend Services" {
  class PriceProviderService {
    +updateInvestmentPrices()
  }
  class InvestmentRepository
}

cloud "Providers" as Providers {
  Binance
  YahooFinance
  Kinesis
  CustomJSON
}

database "PostgreSQL" as DB

PriceProviderService --> InvestmentRepository : getActiveInvestments()
InvestmentRepository --> DB : SELECT

loop For each investment
  alt provider = 'binance'
    PriceProviderService --> Binance : GET price
  else provider = 'yahoo'
    PriceProviderService --> YahooFinance : GET price
  else provider = 'kinesis'
    PriceProviderService --> Kinesis : GET trendline
  else provider = 'custom'
    PriceProviderService --> CustomJSON : GET latest/history
  end
  Providers --> PriceProviderService : price
  PriceProviderService --> InvestmentRepository : update price
  InvestmentRepository --> DB : UPDATE current_price
end

@enduml
```

Source diagram: [[docs/diagrams/price-provider-flow.puml]]

Database addition note:
- Historical quote persistence table: `asset_price_history` (`investment_id`, `price_date`, `close_price`, `source`, `fetched_at`, `updated_at`) created by schema init and Alembic migration.

## Recurring Detection Flow

Automatic detection of recurring transactions from transaction history.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 30
skinparam ranksep 40

package "Backend Services" {
  class RecurringDetectionService {
    +detectRecurring()
  }
  class TransactionRepository
  class PlannedTransactionRepository
}

database "PostgreSQL" as DB {
  table "transactions"
  table "planned_transactions"
}

RecurringDetectionService --> TransactionRepository : getLastN(1000)
TransactionRepository --> DB : SELECT
DB --> TransactionRepository : transactions

RecurringDetectionService --> DB : group by (recipient, amount)
DB --> RecurringDetectionService : candidate patterns

RecurringDetectionService --> PlannedTransactionRepository : create planned
PlannedTransactionRepository --> DB : INSERT
DB --> PlannedTransactionRepository : created

@enduml
```

## Materialized View Refresh Flow

How materialized views are maintained for performance.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam nodesep 30
skinparam ranksep 40

package "Backend" {
  class MaterializedViewService
  class SchemaInit
}

database "PostgreSQL" as DB {
  node "Materialized Views" as MatViews {
    category_monthly_stats
    recipient_monthly_stats
    monthly_trends
  }
  node "Indexes" as Indexes
}

SchemaInit --> MaterializedViewService : check version

alt version match
  MaterializedViewService --> MatViews : REFRESH MATERIALIZED VIEW
else version mismatch
  MaterializedViewService --> MatViews : CREATE
  MaterializedViewService --> Indexes : CREATE INDEX
end

MatViews --> DB : refreshed

@enduml
```

## Recipient Merge Sequence

How recipients are merged and unmerged.

```plantuml
@startuml
!theme plain
skinparam participantSpacing 8
skinparam ranksep 40
skinparam linetype ortho

actor "User" as User
participant "RecipientsPage" as Page
participant "useRecipients" as Hook
participant "ApiClient" as API
participant "RecipientsRouter" as Router
participant "RecipientRepository" as Repo
database "PostgreSQL" as DB

User -> Page : Merge Recipients
Page -> Hook : mergeRecipients(primaryId, aliasIds)
Hook -> API : POST /api/recipients/:id/merge
API -> Router : POST /recipients/:id/merge
Router -> Repo : mergeRecipients(primaryId, aliasIds)
Repo -> DB : UPDATE recipients
DB -> Repo : updated
Repo -> Router : {primary, merged_ids}
Router -> API : JSON
API -> Hook : MergeResponse
Hook -> Page : refresh
Page -> User : Success

note right of Repo
  Aliases point to primary
  via primary_recipient_id
end note

@enduml
```

## PlannedTransaction State Machine

Lifecycle states for planned transactions.

```plantuml
@startuml
!theme plain
skinparam linetype ortho
skinparam stateDimension 100, 60

title PlannedTransaction States

[*] --> Active
Active --> Pending
Pending --> Executed : execute()
Executed --> Pending : (recurring)

Active --> Recurring : is_recurring=true
Recurring --> Executed : execute()

Active --> Loan : is_loan=true
Loan --> Executed : payment

Executed --> [*] : delete()

note right of Pending
  Awaiting execution
end note
note right of Loan
  loan_schedule populated
end note

@enduml
```

## Diagram Source Files

The raw PlantUML source files are stored in `docs/diagrams/`:

**Backend Architecture:**
- `backend-domain-model.puml` - Core domain entities
- `backend-repository-layer.puml` - Data access layer
- `backend-service-layer.puml` - Business logic services
- `backend-api-layer.puml` - API routes and controllers
- `backend-database-schema.puml` - Database ERD

**Import & Processing:**
- `import-pipeline.puml` - CSV import flow
- `import-sequence.puml` - Detailed import sequence
- `currency-conversion-flow.puml` - Exchange rate conversion
- `price-provider-flow.puml` - Investment price updates
- `recurring-detection-flow.puml` - Recurring transaction detection
- `materialized-view-flow.puml` - Materialized view refresh

**Sequence & State Diagrams:**
- `recipient-merge-sequence.puml` - Recipient merge workflow
- `planned-transaction-state.puml` - PlannedTransaction lifecycle

**System-Wide:**
- `system-architecture.puml` - Full system overview
- `deployment-architecture.puml` - Deployment diagram
- `api-communication.puml` - Frontend to Backend communication
- `use-case-diagram.puml` - User interactions overview
- `transaction-state.puml` - Transaction lifecycle states

## Regenerating Diagrams

To regenerate these diagrams after code changes:

1. Review the relevant source files
2. Update the PlantUML source in the respective `.puml` file
3. The diagrams in this document will render the updated content

---

**Related Documentation**
- [[API Documentation]] - API endpoint details
- [[Database Schema]] - Detailed schema documentation
- [[Features Overview]] - Feature descriptions
