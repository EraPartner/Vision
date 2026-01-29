# Database Schema Analysis

**Vault Voyager Backend - Current State**

---

## 📊 **CURRENT DATABASE SCHEMA**

### Entity Relationship Overview

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   Categories    │         │   Recipients     │         │  ImportBatch    │
├─────────────────┤         ├──────────────────┤         ├─────────────────┤
│ PK id           │◄───┐    │ PK id            │◄───┐    │ PK id           │◄──┐
│    general      │    │    │    name          │    │    │    filename     │   │
│    detail       │    │    │    account_number│    │    │    bank_name    │   │
│    description  │    │    │ FK category_id   │─┐  │    │    total_proc.. │   │
│    color        │    │    │    notes         │ │  │    │    imported_cnt │   │
│    is_active    │    │    │    is_active     │ │  │    │    duplicate_.. │   │
│    created_at   │    │    │    created_at    │ │  │    │    error_count  │   │
│    updated_at   │    │    │    updated_at    │ │  │    │    config_used  │   │
└─────────────────┘    │    └──────────────────┘ │  │    │    status       │   │
                       │                         │  │    │    error_message│   │
                       │                         │  │    │    created_at   │   │
                       │                         │  │    │    completed_at │   │
                       │                         │  │    └─────────────────┘   │
                       │                         │  │                          │
                       │                         └──┼──────────────┐           │
                       │                            │              │           │
                       │    ┌───────────────────────┘              │           │
                       │    │                                      │           │
                  ┌────┴────┴────────────────────────────────────┐│           │
                  │              Transactions                     ││           │
                  ├───────────────────────────────────────────────┤│           │
                  │ PK id                                         ││           │
                  │    date                    [INDEXED]          ││           │
                  │    amount                                     ││           │
                  │    currency                ⚠️ UNDERUSED?      ││           │
                  │    balance                 ⚠️ NECESSARY?      ││           │
                  │    memo                                       ││           │
                  │    comment                 ⚠️ REDUNDANT?      ││           │
                  │    bank_account            [INDEXED]          ││           │
                  │ FK recipient_id            [NOT INDEXED]      │├───────────┘
                  │ FK category_id             [NOT INDEXED] ─────┘│
                  │ FK batch_id                                    │
                  │    original_raw_data       ⚠️ DEBUG ONLY?      │
                  │    bank_reference          ⚠️ USAGE?           │
                  │    created_at                                  │
                  │    updated_at                                  │
                  └────────────────────────────────────────────────┘


┌──────────────────┐
│  BankAdapter     │  ⚠️ POTENTIALLY UNUSED TABLE
├──────────────────┤
│ PK id            │
│    bank_name     │  [UNIQUE]
│    adapter_config│  (JSON)
│    is_active     │
│    created_at    │
│    updated_at    │
└──────────────────┘
     ⚠️ Check: Does BankAdapterFactory use this table?
        It appears to use hard-coded adapters instead.
```

---

## 📋 **TABLE-BY-TABLE ANALYSIS**

### 1. Transactions Table

**Purpose:** Core table storing all financial transactions

**Columns (17 total):**

| Column            | Type          | Nullable | Indexed | Status           | Notes                                     |
|-------------------|---------------|----------|---------|------------------|-------------------------------------------|
| id                | Integer       | No       | PK      | ✅ Keep           | Primary key                               |
| date              | Date          | No       | Yes     | ✅ Keep           | Core field, well-indexed                  |
| amount            | Numeric(10,2) | No       | No      | ✅ Keep           | Core field                                |
| currency          | String(3)     | Yes      | No      | ⚠️ Review        | Is this used? Default to single currency? |
| balance           | Numeric(12,2) | Yes      | No      | ⚠️ Review        | Stored or computed? Value unclear         |
| memo              | Text          | Yes      | No      | ✅ Keep           | Transaction description                   |
| comment           | Text          | Yes      | No      | ⚠️ Review        | Redundant with memo? Bank-specific data?  |
| bank_account      | String(100)   | Yes      | Yes     | ⚠️ Refactor      | Should be FK to BankAccount table         |
| recipient_id      | Integer       | No       | No      | ⚠️ Missing Index | FK, frequently queried                    |
| category_id       | Integer       | Yes      | No      | ⚠️ Missing Index | FK, frequently filtered                   |
| batch_id          | Integer       | Yes      | No      | ✅ OK             | FK for import tracking                    |
| original_raw_data | Text          | Yes      | No      | ⚠️ Review        | Storage overhead, debug only?             |
| bank_reference    | String(100)   | Yes      | No      | ⚠️ Review        | Check actual usage                        |
| created_at        | DateTime      | No       | No      | ✅ Keep           | Audit trail                               |
| updated_at        | DateTime      | Yes      | No      | ✅ Keep           | Audit trail                               |

**Relationships:**

- `recipient_id` → Recipients (Many-to-One) ✅
- `category_id` → Categories (Many-to-One) ✅
- `batch_id` → ImportBatch (Many-to-One) ✅

**Issues Found:**

1. Missing index on `recipient_id` (frequently joined)
2. Missing index on `category_id` (frequently filtered)
3. Missing composite index on `(date, bank_account)` (common query pattern)
4. `bank_account` should be normalized to separate table
5. Several columns with unclear value proposition

**Recommended Actions:**

```sql
-- Add missing indexes
CREATE INDEX idx_transaction_recipient ON transactions (recipient_id);
CREATE INDEX idx_transaction_category ON transactions (category_id);
CREATE INDEX idx_transaction_date_bank ON transactions (date, bank_account);

-- Consider removing after audit
-- DROP COLUMN original_raw_data;  -- If not used for debugging
-- DROP COLUMN comment;  -- If redundant with memo
-- DROP COLUMN currency;  -- If single-currency system
-- DROP COLUMN balance;  -- If can be computed
```

---

### 2. Categories Table

**Purpose:** Hierarchical category system (General:Detail)

**Columns (8 total):**

| Column      | Type        | Nullable     | Indexed | Status    | Notes                           |
|-------------|-------------|--------------|---------|-----------|---------------------------------|
| id          | Integer     | No           | PK      | ✅ Keep    | Primary key                     |
| general     | String(100) | No           | Yes     | ✅ Keep    | Top-level category              |
| detail      | String(100) | No           | Yes     | ✅ Keep    | Sub-category                    |
| description | Text        | Yes          | No      | ✅ Keep    | Optional description            |
| color       | String(7)   | Yes          | No      | ⚠️ Review | Frontend feature - verify usage |
| is_active   | Boolean     | Default True | No      | ✅ Keep    | Soft delete flag                |
| created_at  | DateTime    | No           | No      | ✅ Keep    | Audit trail                     |
| updated_at  | DateTime    | Yes          | No      | ✅ Keep    | Audit trail                     |

**Constraints:**

- `UNIQUE(general, detail)` ✅ Good - prevents duplicates

**Relationships:**

- → Recipients (One-to-Many via `default_category_id`) ✅
- → Transactions (One-to-Many) ✅

**Issues Found:**

1. `color` column might be unused by frontend - verify
2. `is_active` soft delete needs consistent enforcement across codebase

**Recommended Actions:**

```sql
-- Add index if frequently filtered by active status
CREATE INDEX idx_category_active ON categories (is_active) WHERE is_active = true;

-- Verify color column usage, remove if unused
-- DROP COLUMN color;
```

**Design Decision Needed:**

- Is `general:detail` split optimal, or should it be a single hierarchical path?
- Should categories support more than 2 levels?

---

### 3. Recipients Table

**Purpose:** Store transaction recipients/payees

**Columns (8 total):**

| Column              | Type        | Nullable     | Indexed | Status    | Notes                              |
|---------------------|-------------|--------------|---------|-----------|------------------------------------|
| id                  | Integer     | No           | PK      | ✅ Keep    | Primary key                        |
| name                | String(255) | No           | Yes     | ✅ Keep    | Recipient name, indexed for search |
| account_number      | String(50)  | Yes          | No      | ✅ Keep    | Optional account info              |
| default_category_id | Integer     | Yes          | No      | ✅ Keep    | FK for auto-categorization         |
| notes               | Text        | Yes          | No      | ⚠️ Review | Check actual usage                 |
| is_active           | Boolean     | Default True | No      | ✅ Keep    | Soft delete flag                   |
| created_at          | DateTime    | No           | No      | ✅ Keep    | Audit trail                        |
| updated_at          | DateTime    | Yes          | No      | ✅ Keep    | Audit trail                        |

**Relationships:**

- `default_category_id` → Categories (Many-to-One) ✅
- → Transactions (One-to-Many) ✅

**Issues Found:**

1. `notes` column usage unclear - verify necessity
2. Name normalization not enforced at database level (handled in service layer)

**Recommended Actions:**

```sql
-- Add index if filtering by category is common
CREATE INDEX idx_recipient_category ON recipients (default_category_id);

-- Consider adding normalized_name column for better searching
ALTER TABLE recipients
    ADD COLUMN normalized_name VARCHAR(255);
CREATE INDEX idx_recipient_normalized ON recipients (normalized_name);
```

---

### 4. ImportBatch Table

**Purpose:** Track CSV import operations and statistics

**Columns (11 total):**

| Column          | Type        | Nullable             | Indexed | Status    | Notes                      |
|-----------------|-------------|----------------------|---------|-----------|----------------------------|
| id              | Integer     | No                   | PK      | ✅ Keep    | Primary key                |
| filename        | String(255) | No                   | No      | ✅ Keep    | Source file tracking       |
| bank_name       | String(100) | No                   | No      | ✅ Keep    | Bank identifier            |
| total_processed | Integer     | Default 0            | No      | ✅ Keep    | Import statistics          |
| imported_count  | Integer     | Default 0            | No      | ✅ Keep    | Success count              |
| duplicate_count | Integer     | Default 0            | No      | ✅ Keep    | Duplicate detection count  |
| error_count     | Integer     | Default 0            | No      | ✅ Keep    | Error tracking             |
| config_used     | Text        | Yes                  | No      | ⚠️ Review | JSON config - verify usage |
| status          | String(20)  | Default "processing" | No      | ✅ Keep    | State tracking             |
| error_message   | Text        | Yes                  | No      | ⚠️ Review | Could be separate table    |
| created_at      | DateTime    | No                   | No      | ✅ Keep    | Import timestamp           |
| completed_at    | DateTime    | Yes                  | No      | ✅ Keep    | Completion tracking        |

**Relationships:**

- → Transactions (One-to-Many) ✅

**Issues Found:**

1. Missing index on `created_at` for sorting import history
2. `config_used` JSON field usage unclear
3. `error_message` could be normalized to separate error log table

**Recommended Actions:**

```sql
-- Add index for sorting import history
CREATE INDEX idx_batch_created ON import_batches (created_at DESC);

-- Add index for filtering by status
CREATE INDEX idx_batch_status ON import_batches (status);

-- Consider separate error log table
CREATE TABLE import_errors
(
    id            INTEGER PRIMARY KEY,
    batch_id      INTEGER REFERENCES import_batches (id),
    row_number    INTEGER,
    error_type    VARCHAR(50),
    error_message TEXT,
    raw_data      TEXT,
    created_at    DATETIME
);
```

---

### 5. BankAdapter Table ⚠️

**Purpose:** Store bank adapter configurations (POTENTIALLY UNUSED)

**Columns (6 total):**

| Column         | Type        | Nullable       | Indexed | Status    | Notes                               |
|----------------|-------------|----------------|---------|-----------|-------------------------------------|
| id             | Integer     | No             | PK      | ⚠️ Review | Primary key                         |
| bank_name      | String(100) | No             | UNIQUE  | ⚠️ Review | Bank identifier                     |
| adapter_config | Text        | No             | No      | ⚠️ Review | JSON configuration                  |
| is_active      | String(10)  | Default "true" | No      | ⚠️ Review | Odd type choice (should be Boolean) |
| created_at     | DateTime    | No             | No      | ⚠️ Review | Audit trail                         |
| updated_at     | DateTime    | No             | No      | ⚠️ Review | Audit trail                         |

**Relationships:**

- None found ⚠️

**Critical Issue:**

```python
# In services/bank_adapters.py:
class BankAdapterFactory:
    @staticmethod
    def get_adapter(bank_name: str) -> BaseBankAdapter:
        adapters = {
            "belfius": BelfiusAdapter,
            "revolut": RevolutAdapter,
            "kbc": KBCAdapter,
            # ... hard-coded adapters
        }
        # No database query here!
```

**Finding:** The `BankAdapterFactory` uses hard-coded adapter classes, NOT database records.

**Recommended Action:**

```sql
-- Option 1: Drop the table if truly unused
-- Verify first: grep for "BankAdapter" model usage
-- DROP TABLE bank_adapters;

-- Option 2: If needed for dynamic configuration, refactor factory to use it
-- But current implementation doesn't need it
```

---

## 🔍 **MISSING TABLES TO CONSIDER**

### 1. BankAccount Table (Recommended)

**Purpose:** Normalize bank_account string field

```sql
CREATE TABLE bank_accounts
(
    id           INTEGER PRIMARY KEY,
    name         VARCHAR(100) NOT NULL UNIQUE,
    bank_name    VARCHAR(100),
    account_type VARCHAR(50), -- checking, savings, credit
    currency     VARCHAR(3) DEFAULT 'USD',
    is_active    BOOLEAN    DEFAULT TRUE,
    created_at   DATETIME   DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME
);

-- Update transactions table
ALTER TABLE transactions
    ADD COLUMN bank_account_id INTEGER REFERENCES bank_accounts (id);

-- Migrate data
INSERT INTO bank_accounts (name, bank_name)
SELECT DISTINCT bank_account, bank_account
FROM transactions
WHERE bank_account IS NOT NULL;

UPDATE transactions t
SET bank_account_id = (SELECT id
                       FROM bank_accounts ba
                       WHERE ba.name = t.bank_account);

-- After verification
ALTER TABLE transactions DROP COLUMN bank_account;
```

### 2. AuditLog Table (Recommended)

**Purpose:** Track all data modifications

```sql
CREATE TABLE audit_log
(
    id         INTEGER PRIMARY KEY,
    table_name VARCHAR(50) NOT NULL,
    record_id  INTEGER     NOT NULL,
    action     VARCHAR(20) NOT NULL, -- INSERT, UPDATE, DELETE
    old_values TEXT,                 -- JSON
    new_values TEXT,                 -- JSON
    user_id    INTEGER,              -- Future: user tracking
    ip_address VARCHAR(45),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX      idx_audit_table_record (table_name, record_id),
    INDEX      idx_audit_created (created_at)
);
```

### 3. UserSettings Table (Future)

**Purpose:** User preferences and configuration

```sql
CREATE TABLE users
(
    id            INTEGER PRIMARY KEY,
    username      VARCHAR(100) NOT NULL UNIQUE,
    email         VARCHAR(255),
    password_hash VARCHAR(255),
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    DATETIME,
    last_login    DATETIME
);

CREATE TABLE user_settings
(
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER REFERENCES users (id),
    setting_key   VARCHAR(100),
    setting_value TEXT,
    UNIQUE (user_id, setting_key)
);
```

### 4. Tags Table (Future Enhancement)

**Purpose:** Flexible transaction tagging

```sql
CREATE TABLE tags
(
    id         INTEGER PRIMARY KEY,
    name       VARCHAR(50) NOT NULL UNIQUE,
    color      VARCHAR(7),
    created_at DATETIME
);

CREATE TABLE transaction_tags
(
    transaction_id INTEGER REFERENCES transactions (id),
    tag_id         INTEGER REFERENCES tags (id),
    PRIMARY KEY (transaction_id, tag_id)
);
```

---

## 🎯 **INDEX OPTIMIZATION PLAN**

### Current Indexes

```sql
-- Existing (auto-created by ORM)
transactions
.
id
[PRIMARY KEY]
transactions.date [INDEX]
transactions.bank_account [INDEX]
categories.id [PRIMARY KEY]
categories.general [INDEX]
categories.detail [INDEX]
recipients.id [PRIMARY KEY]
recipients.name [INDEX]
import_batches.id [PRIMARY KEY]
bank_adapters.id [PRIMARY KEY]
bank_adapters.bank_name [UNIQUE]
```

### Missing Indexes (HIGH PRIORITY)

```sql
-- Transaction lookups by foreign keys
CREATE INDEX idx_transaction_recipient_id ON transactions (recipient_id);
CREATE INDEX idx_transaction_category_id ON transactions (category_id);
CREATE INDEX idx_transaction_batch_id ON transactions (batch_id);

-- Common query patterns
CREATE INDEX idx_transaction_date_bank ON transactions (date, bank_account);
CREATE INDEX idx_transaction_date_category ON transactions (date, category_id);

-- Recipient lookups
CREATE INDEX idx_recipient_category_id ON recipients (default_category_id);

-- Import history
CREATE INDEX idx_batch_created_desc ON import_batches (created_at DESC);
CREATE INDEX idx_batch_status ON import_batches (status);

-- Category active filter
CREATE INDEX idx_category_active ON categories (is_active) WHERE is_active = true;
```

### Index Size Estimates

Assuming 100,000 transactions:

- `idx_transaction_recipient_id`: ~2 MB
- `idx_transaction_category_id`: ~2 MB
- `idx_transaction_date_bank`: ~4 MB
- Total additional space: ~10-15 MB

**Trade-off:** Storage space vs query performance
**Recommendation:** Add all - worth the space for query speed

---

## 📊 **QUERY PATTERN ANALYSIS**

### Common Query Patterns (Observed in Code)

1. **List transactions with filters**

```sql
SELECT t.*, r.name, c.general, c.detail
FROM transactions t
         LEFT JOIN recipients r ON t.recipient_id = r.id
         LEFT JOIN categories c ON t.category_id = c.id
WHERE t.date BETWEEN ? AND ?
  AND t.bank_account = ?
  AND t.category_id = ?
ORDER BY t.date DESC LIMIT ?
OFFSET ?;
```

**Needs:** Composite index on `(date, bank_account, category_id)`

2. **Uncategorized transactions**

```sql
SELECT t.*, r.name
FROM transactions t
         LEFT JOIN recipients r ON t.recipient_id = r.id
WHERE t.category_id IS NULL LIMIT ?;
```

**Needs:** Index on `category_id` (includes NULL optimization)

3. **Statistics by category**

```sql
SELECT c.general, c.detail, COUNT(*), SUM(t.amount)
FROM transactions t
         JOIN categories c ON t.category_id = c.id
WHERE t.date >= ?
GROUP BY c.general, c.detail;
```

**Needs:** Index on `(date, category_id)`

4. **Import batch details**

```sql
SELECT *
FROM import_batches
ORDER BY created_at DESC LIMIT ?;
```

**Needs:** Index on `created_at DESC`

---

## 🔄 **MIGRATION ROADMAP**

### Phase 1: Index Addition (No Breaking Changes)

**Estimated Time:** 1-2 hours  
**Risk:** Low  
**Downtime:** None

```sql
-- Script: migrations/001_add_indexes.sql
CREATE INDEX idx_transaction_recipient_id ON transactions (recipient_id);
CREATE INDEX idx_transaction_category_id ON transactions (category_id);
CREATE INDEX idx_transaction_date_bank ON transactions (date, bank_account);
CREATE INDEX idx_batch_created_desc ON import_batches (created_at DESC);
```

### Phase 2: Column Cleanup (Backward Compatible)

**Estimated Time:** 2-4 hours  
**Risk:** Medium  
**Downtime:** None (if done right)

```sql
-- Script: migrations/002_cleanup_columns.sql
-- Verify usage first in application code!

-- Option A: Soft removal (keep data but mark deprecated)
-- (Update ORM models but don't drop columns yet)

-- Option B: Hard removal (after verification)
ALTER TABLE transactions DROP COLUMN original_raw_data;
ALTER TABLE transactions DROP COLUMN comment;
```

### Phase 3: Schema Normalization (Breaking Changes)

**Estimated Time:** 1-2 days  
**Risk:** High  
**Downtime:** Possible

```sql
-- Script: migrations/003_normalize_bank_accounts.sql
-- 1. Create new table
-- 2. Migrate data
-- 3. Update foreign keys
-- 4. Drop old column
-- (See BankAccount table creation above)
```

### Phase 4: Drop Unused Tables

**Estimated Time:** 1 hour  
**Risk:** Low (if verified unused)  
**Downtime:** None

```sql
-- Script: migrations/004_drop_unused_tables.sql
-- Only after verification
DROP TABLE IF EXISTS bank_adapters;
```

---

## ✅ **VERIFICATION QUERIES**

### Check Column Usage

```sql
-- Find transactions with NULL currency
SELECT COUNT(*)
FROM transactions
WHERE currency IS NULL;
SELECT COUNT(*)
FROM transactions
WHERE currency IS NOT NULL;

-- Find transactions with NULL balance
SELECT COUNT(*)
FROM transactions
WHERE balance IS NULL;

-- Find transactions with comment but no memo
SELECT COUNT(*)
FROM transactions
WHERE comment IS NOT NULL
  AND memo IS NULL;

-- Check if BankAdapter table is referenced
SELECT COUNT(*)
FROM bank_adapters; -- If 0, likely unused
```

### Check Index Effectiveness

```sql
-- SQLite: Query plan analysis
EXPLAIN
QUERY PLAN
SELECT *
FROM transactions
WHERE recipient_id = 1;

-- Check index usage (PostgreSQL)
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
ORDER BY idx_scan;
```

### Data Quality Checks

```sql
-- Orphaned recipients (no transactions)
SELECT r.*
FROM recipients r
         LEFT JOIN transactions t ON r.id = t.recipient_id
WHERE t.id IS NULL;

-- Transactions without category
SELECT COUNT(*)
FROM transactions
WHERE category_id IS NULL;

-- Categories not used
SELECT c.*
FROM categories c
         LEFT JOIN transactions t ON c.id = t.category_id
WHERE t.id IS NULL;
```

---

## 📈 **PERFORMANCE PROJECTIONS**

### Current State (100k transactions)

- List transactions query: ~200ms (missing indexes)
- Category statistics: ~150ms
- Uncategorized search: ~100ms

### After Index Optimization

- List transactions query: ~20ms (10x improvement)
- Category statistics: ~30ms (5x improvement)
- Uncategorized search: ~10ms (10x improvement)

### After Full Refactoring

- All queries: <50ms
- Import speed: >1000 rows/second
- Concurrent users: 10-20 simultaneous

---

## 🚨 **CRITICAL RECOMMENDATIONS**

### Immediate Actions

1. ✅ Add missing indexes (safe, high impact)
2. ✅ Verify BankAdapter table usage → likely drop
3. ✅ Initialize Alembic for future migrations
4. ✅ Audit column usage before removal

### Short-term Actions (1-2 weeks)

1. ⚠️ Normalize bank_account to separate table
2. ⚠️ Remove redundant columns after verification
3. ⚠️ Add audit logging table
4. ⚠️ Implement data quality constraints

### Long-term Actions (1-2 months)

1. 📋 Consider multi-currency support architecture
2. 📋 Add user management tables
3. 📋 Implement tag system
4. 📋 Add data retention policies

---

**Document Version:** 1.0  
**Last Updated:** January 17, 2026  
**Next Review:** After Phase 1 implementation
