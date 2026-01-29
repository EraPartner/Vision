# Vault Voyager Backend - TODO List

**Backend for Frontend Architecture**

**Created:** January 17, 2026  
**Last Updated:** January 17, 2026  
**Status:** In Progress

---

## 📋 **OVERVIEW**

This backend serves a frontend application. All user interactions happen through the frontend, which makes API calls to
this backend. Security, validation, and business logic are handled here.

**Completed:**

- ✅ Category endpoints (full stack: API → Service → Repository → Model)

**Next Up:**

- 🔄 Recipient endpoints
- 🔄 Transaction endpoints
- 🔄 Import/Export endpoints
- 🔄 Statistics endpoints
- 🔄 Admin endpoints

---

## 🔴 **PRIORITY 1: CORE FEATURE COMPLETION** (Vertical Slices)

Complete each feature from top to bottom: API Routes → Schemas → Service → Repository → Model

### ✅ 1.1 Categories Feature (COMPLETED)

All category code is working correctly.

---

### 🔄 1.2 Recipients Feature

**Goal:** Complete full CRUD for recipients with validation and business logic

#### API Layer (`api/api_routes_recipients.py`)

- [ ] Review and test `GET /api/recipients` endpoint
    - [ ] Verify search functionality works correctly
    - [ ] Test `with_accounts` filter behavior
    - [ ] Check pagination if needed (currently returns all)
    - [ ] Validate error handling

- [ ] Review and test `POST /api/recipients` endpoint
    - [ ] Verify recipient creation with deduplication
    - [ ] Test account_number handling (optional field)
    - [ ] Check default_category_id assignment
    - [ ] Validate error responses

- [ ] Review and test `GET /api/recipients/{id}` endpoint
    - [ ] Verify 404 handling for non-existent recipients
    - [ ] Check response includes all needed fields

- [ ] Review and test `PUT /api/recipients/{id}` endpoint
    - [ ] Test updating name, account_number, category, notes
    - [ ] Verify null handling (clearing fields)
    - [ ] Check validation rules

- [ ] Review and test `DELETE /api/recipients/{id}` endpoint
    - [ ] Verify soft delete (is_active = false)
    - [ ] Check cascade behavior with transactions
    - [ ] Test 404 for non-existent recipient

#### Schema Layer (`api/api_schemas.py`)

- [ ] Review `RecipientCreate` schema
    - [ ] Validate required fields
    - [ ] Add field descriptions
    - [ ] Check validation rules (e.g., name length)

- [ ] Review `RecipientUpdate` schema
    - [ ] Verify all fields are optional
    - [ ] Test null handling for clearing values

- [ ] Review `RecipientResponse` schema
    - [ ] Ensure all model fields are included
    - [ ] Check proper from_attributes configuration
    - [ ] Validate response format matches frontend needs

#### Service Layer (`services/recipient_service.py`)

- [ ] Review `RecipientService` class structure
    - [ ] Check initialization and dependencies
    - [ ] Verify proper error handling
    - [ ] Review logging strategy

- [ ] Review business logic methods
    - [ ] `create()` - name normalization, deduplication
    - [ ] `get_by_id()` - simple retrieval
    - [ ] `get_all()` - with filtering
    - [ ] `update()` - field updates with validation
    - [ ] `delete()` - soft delete implementation
    - [ ] Check if `get_or_create()` is needed

- [ ] Check text normalization integration
    - [ ] Verify consistent use of TextNormalizationService
    - [ ] Test duplicate recipient detection

- [ ] Review default category logic
    - [ ] When/how is default_category_id used?
    - [ ] Is it applied to new transactions automatically?

#### Repository Layer (`repositories/recipient_repository.py`)

- [ ] Review `RecipientRepository` class
    - [ ] Check query methods for efficiency
    - [ ] Verify proper session management
    - [ ] Review index usage in queries

- [ ] Review query methods
    - [ ] `get_by_id()` - basic retrieval
    - [ ] `get_all()` - with optional filters
    - [ ] `search_by_name()` - if exists
    - [ ] `create()` - insertion logic
    - [ ] `update()` - update logic
    - [ ] `soft_delete()` - is_active = false

- [ ] Optimize queries
    - [ ] Add eager loading if needed (category relationship)
    - [ ] Check for N+1 query problems
    - [ ] Verify proper use of indexes

#### Model Layer (`database/models.py` - Recipient)

- [ ] Review `Recipient` model structure
    - [ ] Verify all columns are necessary
    - [ ] Check field types and constraints
    - [ ] Review relationships (categories, transactions)

- [ ] Check specific fields
    - [ ] `name` - required, indexed, proper length
    - [ ] `account_number` - optional, consider uniqueness
    - [ ] `default_category_id` - FK, nullable, indexed?
    - [ ] `notes` - used by frontend?
    - [ ] `is_active` - soft delete flag
    - [ ] Timestamps - created_at, updated_at

- [ ] Review indexes
    - [ ] Is `name` indexed for search?
    - [ ] Does `default_category_id` need index?
    - [ ] Consider composite indexes for common queries

#### Testing

- [ ] Unit tests for RecipientService
    - [ ] Test create with duplicate names
    - [ ] Test normalization logic
    - [ ] Test soft delete behavior

- [ ] Integration tests for API endpoints
    - [ ] Test full CRUD flow
    - [ ] Test error cases (404, 400, 500)
    - [ ] Test filtering and search

---

### 🔄 1.3 Transactions Feature

**Goal:** Complete transaction management (list, view, create, update, delete, categorize)

#### API Layer (`api/api_routes_transactions.py`)

- [ ] Review and consolidate endpoints
    - [ ] `GET /api/transactions` - main listing endpoint
        - [ ] Review all query parameters (limit, offset, dates, bank, category, recipient)
        - [ ] Check if all filters are needed by frontend
        - [ ] Verify pagination logic
        - [ ] Test date filtering

    - [ ] **CONSOLIDATE EXPORT ENDPOINTS**
        - [ ] Current: `GET /export-csv` AND `POST /transactions/export`
        - [ ] Decision needed: Keep one, remove other
        - [ ] Recommend: Single `GET /api/transactions/export` with query params

    - [ ] `GET /transactions/view` - is this different from main GET?
        - [ ] Compare with `GET /api/transactions`
        - [ ] Remove if redundant

    - [ ] `GET /api/transactions/{id}` - ADD if missing
        - [ ] Need single transaction retrieval?
        - [ ] For transaction detail view in frontend

    - [ ] `PUT /api/transactions/{id}` - ADD if missing
        - [ ] Update category assignment
        - [ ] Update memo/comment
        - [ ] Update recipient?

    - [ ] `DELETE /api/transactions/{id}` - single transaction delete
        - [ ] Soft delete or hard delete?
        - [ ] What about import batch references?

    - [ ] `DELETE /transactions/by-recipient` - bulk delete
        - [ ] Review safety measures
        - [ ] Add confirmation requirement?
        - [ ] Consider moving to `/api/transactions/bulk-delete`

    - [ ] `GET /transactions/uncategorized`
        - [ ] Keep or merge into main endpoint with `category_id=null` filter?
        - [ ] Check frontend usage

#### Schema Layer (`api/api_schemas.py`)

- [ ] Review transaction schemas
    - [ ] `TransactionBase` - core fields
    - [ ] `TransactionCreate` - for manual creation (needed?)
    - [ ] `TransactionUpdate` - for editing transactions
    - [ ] `TransactionResponse` - full response
    - [ ] `TransactionFrontend` - simplified for lists
    - [ ] Consider consolidating overlapping schemas

- [ ] Review export schemas
    - [ ] `ExportCSVRequest`
    - [ ] `ExportCSVResponse`
    - [ ] Validate all fields are needed

#### Service Layer

- [ ] **CONSOLIDATE TRANSACTION SERVICES**
    - [ ] Current situation:
        - `TransactionImportService` - handles imports AND queries
        - `TransactionExportService` - handles exports
        - `TransactionQueryService` - more queries

    - [ ] Recommended structure:
      ```
      TransactionService - main CRUD operations
      TransactionImportService - CSV import only
      TransactionExportService - CSV export only
      TransactionQueryService - complex queries/reports (or merge into main)
      ```

- [ ] Review `TransactionService` (create if needed)
    - [ ] `get_by_id()` - single transaction
    - [ ] `get_all()` - with filtering
    - [ ] `create()` - manual transaction entry
    - [ ] `update()` - edit transaction
    - [ ] `delete()` - soft/hard delete
    - [ ] `bulk_update_category()` - assign category to multiple
    - [ ] `get_uncategorized()` - list uncategorized

- [ ] Review `TransactionImportService`
    - [ ] Focus on CSV import logic only
    - [ ] Move listing/query methods to TransactionService
    - [ ] Keep: `import_csv()`, batch tracking
    - [ ] Remove: `list_transactions_frontend()`, `view_transactions_joined()`

- [ ] Review `TransactionExportService`
    - [ ] Keep focused on export
    - [ ] `export_to_csv()` with filters
    - [ ] Consider adding JSON export

- [ ] Review `TransactionQueryService`
    - [ ] Evaluate if needed separately
    - [ ] Consider merging into TransactionService
    - [ ] Or keep for complex reporting queries

#### Repository Layer (`repositories/transaction_repository.py`)

- [ ] Review `TransactionRepository`
    - [ ] `get_by_id()` with joins (recipient, category)
    - [ ] `get_all()` with filters
    - [ ] `create()` - insert transaction
    - [ ] `update()` - update fields
    - [ ] `delete()` - soft or hard delete
    - [ ] `get_uncategorized()` - WHERE category_id IS NULL
    - [ ] `bulk_update_category()` - efficient bulk updates

- [ ] Optimize queries
    - [ ] Use eager loading for recipient and category
    - [ ] Verify indexes on filter columns
    - [ ] Check query performance with large datasets
    - [ ] Avoid N+1 problems in list queries

#### Model Layer (`database/models.py` - Transaction)

- [ ] Review `Transaction` model
    - [ ] Core fields review
        - [ ] `date` - required, indexed ✓
        - [ ] `amount` - required, Numeric(10,2) ✓
        - [ ] `currency` - optional, used?
        - [ ] `balance` - optional, used? computed?
        - [ ] `memo` - main description field ✓
        - [ ] `comment` - redundant with memo?
        - [ ] `bank_account` - should be FK to BankAccount table?

    - [ ] Foreign keys
        - [ ] `recipient_id` - required, indexed?
        - [ ] `category_id` - optional, indexed?
        - [ ] `batch_id` - optional, tracks import ✓

    - [ ] Metadata fields
        - [ ] `original_raw_data` - for debugging, needed?
        - [ ] `bank_reference` - bank's transaction ID, used?
        - [ ] `created_at`, `updated_at` - audit trail ✓

- [ ] Review indexes
    - [ ] Add index on `recipient_id` (FK, frequently joined)
    - [ ] Add index on `category_id` (FK, frequently filtered)
    - [ ] Add composite index on `(date, bank_account)` (common query)
    - [ ] Current indexes: `date`, `bank_account`

#### Testing

- [ ] Unit tests for TransactionService
    - [ ] Test CRUD operations
    - [ ] Test filtering logic
    - [ ] Test category assignment

- [ ] Integration tests
    - [ ] Test transaction listing with various filters
    - [ ] Test export functionality
    - [ ] Test bulk operations

---

### 🔄 1.4 Import/Export Feature

**Goal:** Robust CSV import with bank adapters and export functionality

#### API Layer (`api/api_routes_import.py`)

- [ ] Review `GET /supported-banks` endpoint
    - [ ] Returns list of available bank adapters
    - [ ] Consider caching response
    - [ ] Add adapter descriptions for frontend

- [ ] Review `POST /import/csv` endpoint
    - [ ] File upload handling
    - [ ] Bank adapter selection
    - [ ] Validation before processing
    - [ ] Progress reporting (consider async/websocket for large files)
    - [ ] Error handling and reporting

- [ ] Review `POST /import/csv/custom` endpoint
    - [ ] Custom column mapping
    - [ ] Date format specification
    - [ ] Validation of custom config
    - [ ] Is this used? Consider removing if not

- [ ] Consider adding:
    - [ ] `POST /import/validate` - dry-run validation before import
    - [ ] `GET /import/batches` - list import history
    - [ ] `GET /import/batches/{id}` - batch details
    - [ ] `POST /import/rollback/{batch_id}` - undo import?

#### Schema Layer

- [ ] Review `ImportResult` schema
    - [ ] batch_id, imported, duplicates, errors counts
    - [ ] Add more detail? (error_details array)
    - [ ] Success/failure messages

- [ ] Add schemas for:
    - [ ] `ImportValidationResult` - for dry-run
    - [ ] `ImportBatchResponse` - batch info
    - [ ] `SupportedBank` - bank adapter info with description

#### Service Layer

- [ ] Review `FileImportHandler`
    - [ ] File validation (type, size)
    - [ ] Temp file management
    - [ ] Security checks
    - [ ] Cleanup in all error scenarios

- [ ] Review `BankAdapterFactory` and adapters
    - [ ] Each adapter parses CSV correctly
    - [ ] Consistent error handling across adapters
    - [ ] Date parsing robustness
    - [ ] Amount parsing (negatives, decimals, commas)
    - [ ] Test with real bank CSV samples

    - [ ] Specific adapters to review:
        - [ ] `BelfiusAdapter`
        - [ ] `RevolutAdapter`
        - [ ] `KBCAdapter`
        - [ ] `GenericCSVAdapter`

- [ ] Review `TransactionImportService.import_csv()`
    - [ ] Duplicate detection logic
    - [ ] Recipient creation/matching
    - [ ] Category auto-assignment (if default_category exists)
    - [ ] Batch creation and tracking
    - [ ] Transaction validation before insert
    - [ ] Error handling (partial imports)
    - [ ] Performance with large files (1000+ rows)

- [ ] Review `DeduplicationService`
    - [ ] How are duplicates detected?
    - [ ] Fields used for matching (date, amount, recipient?)
    - [ ] Fuzzy matching needed?
    - [ ] Performance with large transaction history

- [ ] Review `CSVConfigurationFactory`
    - [ ] Custom config creation
    - [ ] Validation logic
    - [ ] Is this actually used?

#### Repository Layer

- [ ] Review `ImportBatchRepository`
    - [ ] Batch creation
    - [ ] Status updates (processing → completed/failed)
    - [ ] Statistics tracking
    - [ ] Batch history queries

- [ ] Consider adding methods:
    - [ ] `get_recent_batches()` - for history display
    - [ ] `get_batch_transactions()` - transactions in a batch
    - [ ] `rollback_batch()` - delete all transactions from batch?

#### Model Layer (`database/models.py` - ImportBatch)

- [ ] Review `ImportBatch` model
    - [ ] `filename` - source file name ✓
    - [ ] `bank_name` - which adapter used ✓
    - [ ] Statistics fields (total, imported, duplicates, errors) ✓
    - [ ] `config_used` - JSON config, needed?
    - [ ] `status` - processing/completed/failed ✓
    - [ ] `error_message` - overall error ✓
    - [ ] Timestamps ✓

- [ ] Review indexes
    - [ ] Add index on `created_at` for sorting history
    - [ ] Add index on `status` for filtering

#### Testing

- [ ] Unit tests for adapters
    - [ ] Test each adapter with sample CSV
    - [ ] Test error handling (malformed CSV)
    - [ ] Test date parsing edge cases

- [ ] Integration tests
    - [ ] Test full import flow
    - [ ] Test duplicate detection
    - [ ] Test error scenarios
    - [ ] Test large file imports

---

### 🔄 1.5 Statistics/Dashboard Feature

**Goal:** Provide analytics and summaries for frontend dashboard

#### API Layer (`api/api_routes_statistics.py`)

- [ ] Review `GET /api/statistics` endpoint
    - [ ] Overview stats for dashboard
    - [ ] Total transactions count
    - [ ] Category breakdown
    - [ ] What else does frontend need?
    - [ ] Consider caching for performance

- [ ] Review `GET /api/statistics/banks` endpoint
    - [ ] List of bank accounts in database
    - [ ] Transaction counts per bank?
    - [ ] Is this needed or use transaction filters?

- [ ] Review `GET /api/statistics/import-history` endpoint
    - [ ] Recent import batches
    - [ ] Pagination needed?
    - [ ] Include batch statistics

- [ ] Review `GET /api/statistics/transaction-summary` endpoint
    - [ ] Filtered summary (by date, bank, etc.)
    - [ ] Total income/expenses
    - [ ] Average amounts
    - [ ] Check overlap with main statistics endpoint

- [ ] Consider adding:
    - [ ] `GET /api/statistics/spending-by-category` - breakdown
    - [ ] `GET /api/statistics/trends` - monthly trends
    - [ ] `GET /api/statistics/top-recipients` - most frequent
    - [ ] Date range parameters for all statistics

#### Schema Layer

- [ ] Review `StatisticsResponse` schema
    - [ ] total_transactions
    - [ ] categories array with CategoryStats
    - [ ] Add more fields? (total_income, total_expenses, date_range)

- [ ] Review `CategoryStats` schema
    - [ ] category info
    - [ ] transaction count
    - [ ] total amount
    - [ ] Add percentage of total?

- [ ] Review `BankListResponse` schema
    - [ ] Simple list of bank names
    - [ ] Add transaction counts?

#### Service Layer (`services/statistics_service.py`)

- [ ] Review `StatisticsService` class
    - [ ] `get_statistics()` - main dashboard stats
    - [ ] `get_banks()` - distinct bank accounts
    - [ ] `get_import_history()` - recent imports
    - [ ] `get_transaction_summary()` - filtered summary

- [ ] Optimize for performance
    - [ ] Use aggregation queries efficiently
    - [ ] Consider caching results (5-minute cache?)
    - [ ] Avoid loading full transaction objects
    - [ ] Use database aggregation (GROUP BY, SUM, COUNT)

- [ ] Consider adding methods:
    - [ ] `get_spending_by_category()` - detailed breakdown
    - [ ] `get_monthly_trends()` - time series data
    - [ ] `get_top_recipients()` - most common recipients

#### Repository Layer (`repositories/statistics_repository.py`)

- [ ] Review `StatisticsRepository` class
    - [ ] Efficient aggregation queries
    - [ ] Date filtering
    - [ ] Category grouping

- [ ] Optimize queries
    - [ ] Use SQL aggregations (not loading all records)
    - [ ] Proper index usage
    - [ ] Consider database views for complex stats?

#### Testing

- [ ] Unit tests for StatisticsService
    - [ ] Test calculations with known data
    - [ ] Test date filtering
    - [ ] Test empty result handling

- [ ] Integration tests
    - [ ] Test with realistic dataset
    - [ ] Verify performance with large data

---

### 🔄 1.6 Admin/System Feature

**Goal:** Database management and system operations

#### API Layer (`api/api_routes_admin.py`)

- [ ] Review `POST /api/admin/init-db` endpoint
    - [ ] Creates tables if not exist
    - [ ] Idempotent operation
    - [ ] When is this used? First-time setup only?

- [ ] Review `POST /api/admin/reset-db` endpoint
    - [ ] ⚠️ DESTRUCTIVE - drops all data
    - [ ] Requires `force=true` parameter ✓
    - [ ] Add additional safety checks
    - [ ] Consider environment check (never in production)

- [ ] Consider adding:
    - [ ] `GET /api/admin/health` - system health check
    - [ ] `POST /api/admin/backup` - create database backup
    - [ ] `POST /api/admin/vacuum` - optimize database
    - [ ] `GET /api/admin/stats` - system statistics (DB size, record counts)

#### Schema Layer

- [ ] Review `AdminResponse` schema
    - [ ] Simple message + details dict
    - [ ] Sufficient for admin operations

- [ ] Add schemas for new endpoints:
    - [ ] `HealthCheckResponse` - status, database, services
    - [ ] `BackupResponse` - backup file info
    - [ ] `SystemStats` - DB size, counts, etc.

#### Testing

- [ ] Integration tests
    - [ ] Test init-db (on fresh database)
    - [ ] Test health check
    - [ ] DO NOT test reset-db in CI!

---

## 🟡 **PRIORITY 2: DATABASE OPTIMIZATION**

**After completing all vertical slices above, optimize the database**

### 2.1 Add Missing Indexes

**High Priority - Performance Impact**

```sql
-- Add indexes for foreign keys (frequently joined)
CREATE INDEX idx_transaction_recipient_id ON transactions (recipient_id);
CREATE INDEX idx_transaction_category_id ON transactions (category_id);
CREATE INDEX idx_transaction_batch_id ON transactions (batch_id);

-- Add composite indexes for common query patterns
CREATE INDEX idx_transaction_date_bank ON transactions (date, bank_account);
CREATE INDEX idx_transaction_date_category ON transactions (date, category_id);

-- Add indexes for filtering/sorting
CREATE INDEX idx_recipient_category_id ON recipients (default_category_id);
CREATE INDEX idx_batch_created_desc ON import_batches (created_at DESC);
CREATE INDEX idx_batch_status ON import_batches (status);
CREATE INDEX idx_category_active ON categories (is_active) WHERE is_active = true;
```

- [ ] Set up Alembic for migrations
  ```bash
  alembic init alembic
  alembic revision --autogenerate -m "Initial schema baseline"
  alembic upgrade head
  ```

- [ ] Create migration for adding indexes
  ```bash
  alembic revision -m "Add missing indexes for performance"
  # Add index creation SQL above
  alembic upgrade head
  ```

- [ ] Test index effectiveness
    - [ ] Run EXPLAIN QUERY PLAN before/after
    - [ ] Measure query performance improvement
    - [ ] Verify indexes are being used

### 2.2 Clean Up Unused/Redundant Columns

**After verifying usage in each feature review above**

- [ ] Verify column usage with queries:
  ```sql
  SELECT COUNT(*) as total,
         COUNT(currency) as with_currency,
         COUNT(balance) as with_balance,
         COUNT(comment) as with_comment,
         COUNT(original_raw_data) as with_raw_data,
         COUNT(bank_reference) as with_reference
  FROM transactions;
  ```

- [ ] Decision on each column:
    - [ ] `Transaction.currency` - Remove if not used (or add multi-currency support)
    - [ ] `Transaction.balance` - Remove if not used (or implement balance tracking)
    - [ ] `Transaction.comment` - Remove if redundant with memo
    - [ ] `Transaction.original_raw_data` - Keep for debugging or remove for storage
    - [ ] `Transaction.bank_reference` - Remove if not used for reconciliation
    - [ ] `Recipient.notes` - Remove if frontend doesn't use it
    - [ ] `Category.color` - Remove if frontend doesn't use it
    - [ ] `ImportBatch.config_used` - Remove if not used

- [ ] Create migration to drop unused columns
  ```bash
  alembic revision -m "Remove unused columns"
  # Add DROP COLUMN statements
  alembic upgrade head
  ```

### 2.3 Consider Schema Improvements

**Long-term improvements**

- [ ] Normalize `bank_account` field
    - [ ] Create `BankAccount` table (id, name, bank_name, currency, is_active)
    - [ ] Migrate existing bank_account strings to table
    - [ ] Update Transaction.bank_account to bank_account_id FK
    - [ ] Benefits: Consistent naming, metadata per account, better queries

- [ ] Review `BankAdapter` model
    - [ ] Verify if this table is actually used (check code references)
    - [ ] If unused, drop it:
      ```sql
      DROP TABLE bank_adapters;
      ```
    - [ ] If used, integrate with BankAdapterFactory

- [ ] Consider separate error logging table
    - [ ] Instead of single error_message in ImportBatch
    - [ ] Store per-row errors with row number, error type, message
    - [ ] Helps with debugging failed imports

### 2.4 Data Integrity Constraints

- [ ] Add check constraints
  ```sql
  ALTER TABLE transactions ADD CONSTRAINT chk_amount_not_zero CHECK (amount != 0);
  ALTER TABLE import_batches ADD CONSTRAINT chk_counts_non_negative 
    CHECK (total_processed >= 0 AND imported_count >= 0 AND duplicate_count >= 0);
  ```

- [ ] Review cascade delete rules
    - [ ] What happens when a Category is deleted? (SET NULL on transactions?)
    - [ ] What happens when a Recipient is deleted? (Should prevent if transactions exist)
    - [ ] What happens when an ImportBatch is deleted? (Keep transactions?)

---

## 🟢 **PRIORITY 3: SECURITY & VALIDATION**

**Frontend-Backend Security Architecture**

Since all access is through frontend (not direct API), focus on backend validation and frontend-backend trust.

### 3.1 Input Validation (High Priority)

- [ ] **Schema Validation - strengthen Pydantic models**
    - [ ] Add length limits on all string fields
      ```python
      name: str = Field(..., min_length=1, max_length=255)
      ```
    - [ ] Add value ranges on numeric fields
      ```python
      limit: int = Field(100, ge=1, le=5000)
      ```
    - [ ] Add pattern validation where appropriate
      ```python
      bank_account: str = Field(..., pattern=r'^[A-Za-z0-9\s-]+$')
      ```
    - [ ] Validate date formats strictly
    - [ ] Sanitize file names in upload

- [ ] **Business Logic Validation**
    - [ ] Validate transaction amounts (reasonable ranges?)
    - [ ] Validate date ranges (not in future? not before reasonable date?)
    - [ ] Validate recipient names (no special chars injection)
    - [ ] Validate category references exist
    - [ ] Validate import file sizes (max 50MB already, good)

- [ ] **SQL Injection Prevention**
    - [ ] ✅ Already protected by SQLAlchemy ORM (parameterized queries)
    - [ ] Ensure no raw SQL with string interpolation
    - [ ] Review any custom queries in repositories

### 3.2 CORS Configuration (High Priority)

**Currently in `config/config.py`**

- [ ] Review CORS settings for frontend-backend setup
  ```python
  cors_origins: list = ["http://localhost:3000"]  # Frontend dev
  cors_credentials: bool = True
  cors_methods: list = ["GET", "POST", "PUT", "DELETE"]
  cors_headers: list = ["*"]
  ```

- [ ] Configure for production
    - [ ] Set specific frontend domain (not wildcard)
    - [ ] Limit methods to what's needed
    - [ ] Limit headers to what's needed
    - [ ] Set `Access-Control-Max-Age` for preflight caching

- [ ] Environment-based CORS
    - [ ] Development: localhost:3000
    - [ ] Production: your-frontend-domain.com
    - [ ] Load from environment variable

### 3.3 Authentication & Authorization (Later Priority)

**Not needed immediately if backend is not publicly exposed, but plan for future**

- [ ] Design authentication strategy
    - [ ] Session-based (cookies) or Token-based (JWT)?
    - [ ] Since frontend-backend, session-based may be simpler
    - [ ] Or JWT in httpOnly cookie for SPA

- [ ] Consider multi-user support
    - [ ] Add `User` table (id, username, email, password_hash, created_at)
    - [ ] Add `user_id` to transactions, categories, recipients
    - [ ] Filter all queries by current user
    - [ ] Implement login/logout endpoints

- [ ] Implement later when needed:
    - [ ] `POST /api/auth/login` - authenticate user
    - [ ] `POST /api/auth/logout` - end session
    - [ ] `GET /api/auth/me` - current user info
    - [ ] Middleware to verify authentication on protected routes
    - [ ] Password hashing (bcrypt)

### 3.4 Rate Limiting & DoS Prevention

**Protect against abuse**

- [ ] Add rate limiting (when deploying to production)
    - [ ] Use library like `slowapi` for FastAPI
    - [ ] Limit requests per IP/user
      ```python
      @limiter.limit("100/minute")
      async def get_transactions(...):
      ```
    - [ ] Different limits for different endpoints
        - Read endpoints: 100/minute
        - Write endpoints: 20/minute
        - Import endpoints: 5/minute (expensive operation)

- [ ] File upload limits (already have 50MB)
    - [ ] ✅ Already implemented in FileImportHandler
    - [ ] Consider lower limit (10MB?) if files are typically smaller

- [ ] Query result limits
    - [ ] ✅ Already have max limit on endpoints (5000)
    - [ ] Enforce pagination for large result sets
    - [ ] Default page size: 100, max: 1000?

### 3.5 Error Handling & Information Disclosure

- [ ] **Don't leak sensitive information in errors**
    - [ ] Review error messages sent to frontend
    - [ ] Don't expose database structure
    - [ ] Don't expose file paths
    - [ ] Don't expose stack traces to client (log them server-side)

- [ ] **Standardize error responses**
  ```python
  {
    "detail": "User-friendly error message",
    "error_code": "CATEGORY_NOT_FOUND",  # For frontend handling
    "timestamp": "2026-01-17T10:30:00Z"
  }
  ```

- [ ] **Log security events**
    - [ ] Failed validation attempts
    - [ ] Unusual query patterns
    - [ ] Large file uploads
    - [ ] Admin operations (reset-db!)

### 3.6 Data Privacy & Compliance

- [ ] **Audit logging** (for regulatory compliance)
    - [ ] Create `AuditLog` table
      ```sql
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        table_name VARCHAR(50),
        record_id INTEGER,
        action VARCHAR(20),  -- INSERT, UPDATE, DELETE
        user_id INTEGER,  -- future
        changed_fields JSON,
        timestamp DATETIME
      );
      ```
    - [ ] Log all data modifications
    - [ ] Keep audit log for X years (check regulations)

- [ ] **Data retention policy**
    - [ ] How long to keep transactions?
    - [ ] How long to keep import batches?
    - [ ] How long to keep audit logs?
    - [ ] Implement cleanup job

- [ ] **Data export for users** (GDPR right to data portability)
    - [ ] Endpoint to export all user's data
    - [ ] JSON and CSV formats
    - [ ] Include all transactions, categories, recipients

### 3.7 Secure Configuration

- [ ] **Environment variables** (already using dotenv)
    - [ ] ✅ Using .env.local for sensitive config
    - [ ] Ensure .env.local is in .gitignore
    - [ ] Document required environment variables
    - [ ] Validate required vars on startup

- [ ] **Database security**
    - [ ] If moving to PostgreSQL/MySQL:
        - Use database user with minimal privileges
        - Not the admin/root user
        - Only CRUD permissions needed
    - [ ] SQLite: Protect database file permissions
      ```bash
      chmod 600 financial_transactions.db
      ```

- [ ] **API keys for future integrations**
    - [ ] If adding bank API integrations
    - [ ] Store in environment variables
    - [ ] Never log or expose in responses

---

## 🔵 **PRIORITY 4: TESTING & QUALITY**

### 4.1 Set Up Testing Framework

- [ ] Install testing dependencies
  ```bash
  pip install pytest pytest-cov pytest-asyncio httpx faker
  pip freeze > requirements-dev.txt
  ```

- [ ] Create test structure
  ```
  tests/
  ├── __init__.py
  ├── conftest.py          # Shared fixtures
  ├── unit/
  │   ├── test_category_service.py
  │   ├── test_recipient_service.py
  │   ├── test_transaction_service.py
  │   ├── test_import_service.py
  │   └── test_adapters.py
  ├── integration/
  │   ├── test_api_categories.py
  │   ├── test_api_recipients.py
  │   ├── test_api_transactions.py
  │   ├── test_api_import.py
  │   └── test_api_statistics.py
  └── e2e/
      ├── test_import_workflow.py
      └── test_category_assignment_workflow.py
  ```

- [ ] Configure pytest (pytest.ini or pyproject.toml)
  ```ini
  [pytest]
  testpaths = tests
  python_files = test_*.py
  python_classes = Test*
  python_functions = test_*
  addopts = -v --cov=. --cov-report=html --cov-report=term
  ```

### 4.2 Unit Tests (Test Business Logic)

- [ ] **CategoryService tests** ✅ (already done)

- [ ] **RecipientService tests**
    - [ ] Test create with name normalization
    - [ ] Test duplicate detection
    - [ ] Test soft delete
    - [ ] Test default category assignment

- [ ] **TransactionService tests**
    - [ ] Test CRUD operations
    - [ ] Test filtering logic
    - [ ] Test category assignment
    - [ ] Test bulk operations

- [ ] **ImportService tests**
    - [ ] Test each bank adapter with sample CSV
    - [ ] Test duplicate detection algorithm
    - [ ] Test error handling (malformed CSV)
    - [ ] Test batch creation and statistics

- [ ] **StatisticsService tests**
    - [ ] Test calculations with known dataset
    - [ ] Test date filtering
    - [ ] Test empty results

### 4.3 Integration Tests (Test API Endpoints)

- [ ] **Category endpoints** ✅ (already done)

- [ ] **Recipient endpoints**
    - [ ] Test GET /api/recipients
    - [ ] Test POST /api/recipients
    - [ ] Test PUT /api/recipients/{id}
    - [ ] Test DELETE /api/recipients/{id}
    - [ ] Test error cases (404, 400)

- [ ] **Transaction endpoints**
    - [ ] Test GET /api/transactions with filters
    - [ ] Test GET /api/transactions/{id}
    - [ ] Test PUT /api/transactions/{id}
    - [ ] Test export endpoint
    - [ ] Test uncategorized endpoint

- [ ] **Import endpoints**
    - [ ] Test POST /import/csv with sample file
    - [ ] Test GET /supported-banks
    - [ ] Test validation errors

- [ ] **Statistics endpoints**
    - [ ] Test GET /api/statistics
    - [ ] Test with various filters
    - [ ] Test with empty database

### 4.4 End-to-End Tests

- [ ] **Import workflow test**
    - [ ] Upload CSV → Import → Verify transactions created
    - [ ] Check duplicate detection works
    - [ ] Check recipient creation
    - [ ] Check batch statistics

- [ ] **Category assignment workflow**
    - [ ] Create category → Assign to recipient → Import transactions
    - [ ] Verify transactions have correct category

### 4.5 Coverage Goals

- [ ] Achieve 70% overall coverage
- [ ] 80%+ coverage on services (business logic)
- [ ] 60%+ coverage on API routes
- [ ] 50%+ coverage on repositories

Run coverage:

```bash
pytest tests/ --cov=. --cov-report=html
open htmlcov/index.html
```

---

## 🟣 **PRIORITY 5: CODE QUALITY & MAINTENANCE**

### 5.1 Code Quality Tools

- [ ] **Set up linting**
  ```bash
  pip install pylint flake8 black isort mypy
  ```

- [ ] **Configure tools**
    - [ ] Create `.pylintrc` for pylint config
    - [ ] Create `setup.cfg` or `pyproject.toml` for flake8, isort, mypy
    - [ ] Run and fix issues:
      ```bash
      black .  # Auto-format code
      isort .  # Sort imports
      flake8 .  # Check style
      pylint **/*.py  # Static analysis
      mypy .  # Type checking
      ```

- [ ] **Add pre-commit hooks** (optional but recommended)
  ```bash
  pip install pre-commit
  # Create .pre-commit-config.yaml
  pre-commit install
  ```

### 5.2 Documentation

- [ ] **API Documentation**
    - [ ] ✅ FastAPI auto-generates docs at /docs (Swagger)
    - [ ] ✅ And at /redoc (ReDoc)
    - [ ] Ensure all endpoints have good docstrings
    - [ ] Add example requests/responses
    - [ ] Document error responses

- [ ] **Code Documentation**
    - [ ] Add docstrings to all public methods (Google or NumPy style)
    - [ ] Document complex algorithms (deduplication, normalization)
    - [ ] Add inline comments for tricky code
    - [ ] Update README with setup instructions

- [ ] **Architecture Documentation**
    - [ ] Create ARCHITECTURE.md explaining structure
    - [ ] Document data flow (Frontend → API → Service → Repository → DB)
    - [ ] Document key design decisions
    - [ ] Create database ERD diagram

### 5.3 Logging Improvements

- [ ] **Review logging configuration** (`config/logging_config.py`)
    - [ ] Ensure appropriate log levels (INFO for normal, DEBUG for dev)
    - [ ] Log rotation (daily? size-based?)
    - [ ] Structured logging (JSON format for parsing?)

- [ ] **Add logging to all services**
    - [ ] Log entry/exit of important methods
    - [ ] Log all errors with full context
    - [ ] Log security events
    - [ ] Log performance metrics (slow queries)

### 5.4 Error Handling Standardization

- [ ] **Create custom exception hierarchy**
  ```python
  # config/exceptions.py
  class AppException(Exception):
      """Base exception"""
      pass
  
  class ValidationError(AppException):
      """Input validation failed"""
      pass
  
  class NotFoundError(AppException):
      """Resource not found"""
      pass
  
  class DuplicateError(AppException):
      """Duplicate resource"""
      pass
  ```

- [ ] **Use custom exceptions in services**
    - [ ] Replace generic exceptions
    - [ ] Makes error handling clearer
    - [ ] Easier to test

- [ ] **Standardize error responses in API layer**
    - [ ] Catch custom exceptions
    - [ ] Return appropriate HTTP status
    - [ ] Return standardized error format

### 5.5 Dependency Updates

- [ ] **Regular dependency updates**
    - [ ] Check for security vulnerabilities
      ```bash
      pip install safety
      safety check
      ```
    - [ ] Update dependencies quarterly
    - [ ] Test after updates

- [ ] **Pin dependency versions** (for reproducibility)
    - [ ] Use exact versions in requirements.txt
      ```bash
      pip freeze > requirements.txt
      ```

---

## 🟠 **PRIORITY 6: DEPLOYMENT & DEVOPS**

### 6.1 Environment Setup

- [ ] **Multi-environment configuration**
    - [ ] Development (.env.local)
    - [ ] Staging (.env.staging)
    - [ ] Production (.env.production)

- [ ] **Document environment variables**
    - Create `.env.example`:
      ```bash
      DATABASE_URL=sqlite:///./financial_transactions.db
      ENVIRONMENT=development
      PORT=8000
      CORS_ORIGINS=["http://localhost:3000"]
      LOG_LEVEL=INFO
      ```

### 6.2 Containerization (Optional)

- [ ] **Create Dockerfile**
  ```dockerfile
  FROM python:3.12-slim
  WORKDIR /app
  COPY ../requirements.txt .
  RUN pip install --no-cache-dir -r requirements.txt
  COPY .. .
  CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
  ```

- [ ] **Create docker-compose.yml** (for local dev with PostgreSQL)
  ```yaml
  version: '3.8'
  services:
    backend:
      build: .
      ports:
        - "8000:8000"
      environment:
        - DATABASE_URL=postgresql://user:pass@db:5432/vault_voyager
      depends_on:
        - db
    db:
      image: postgres:15
      environment:
        - POSTGRES_DB=vault_voyager
        - POSTGRES_USER=user
        - POSTGRES_PASSWORD=pass
  ```

### 6.3 CI/CD Pipeline (Optional)

- [ ] **GitHub Actions / GitLab CI**
    - [ ] Run tests on every commit
    - [ ] Run linters
    - [ ] Check test coverage
    - [ ] Deploy to staging on merge to main
    - [ ] Deploy to production on tag/release

### 6.4 Monitoring (Production)

- [ ] **Health check endpoint**
    - [ ] Already in admin endpoints (add if missing)
    - [ ] Returns 200 if healthy, 503 if database down
    - [ ] Check by monitoring service

- [ ] **Error tracking**
    - [ ] Integrate Sentry or similar
    - [ ] Catch and report all unhandled exceptions
    - [ ] Alert on error rate spike

- [ ] **Performance monitoring**
    - [ ] Track API response times
    - [ ] Track database query times
    - [ ] Set up alerts for slow queries

---

## 📝 **DECISION LOG**

### Decisions Made

- ✅ Fix typo in `api_routes_categories.py` (genera → general)
- ✅ Use vertical slice approach for refactoring
- ✅ Backend serves frontend (not public API)
- ✅ Categories feature is complete baseline

### Decisions Needed

- [ ] Should we consolidate transaction services or keep separate?
- [ ] Do we need the `GET /transactions/view` endpoint?
- [ ] Export: single endpoint or keep GET/POST separate?
- [ ] Remove `bank_account` string and normalize to table?
- [ ] Drop unused columns after verification?
- [ ] Drop `BankAdapter` table if unused?
- [ ] Authentication: when to implement? Session or JWT?
- [ ] Multi-user support: now or later?
- [ ] Database: stay SQLite or migrate to PostgreSQL?
- [ ] CLI tool: keep or deprecate?

---

## 📊 **PROGRESS TRACKING**

### Features Completed

- [x] Categories (API → Service → Repository → Model)

### Features In Progress

- [ ] Recipients (0/5 layers complete)
- [ ] Transactions (0/5 layers complete)
- [ ] Import/Export (0/5 layers complete)
- [ ] Statistics (0/5 layers complete)
- [ ] Admin (0/3 layers complete)

### Database

- [ ] Alembic initialized
- [ ] Indexes added
- [ ] Unused columns removed
- [ ] Schema optimized

### Security

- [ ] Input validation strengthened
- [ ] CORS configured properly
- [ ] Rate limiting added
- [ ] Audit logging implemented

### Testing

- [ ] Testing framework set up
- [ ] Unit tests: 0% coverage
- [ ] Integration tests: 0% coverage
- [ ] E2E tests: 0 scenarios

### Code Quality

- [ ] Linting tools configured
- [ ] Documentation complete
- [ ] Error handling standardized
- [ ] Type hints complete

---

## 🎯 **NEXT ACTIONS**

1. **Complete Recipients feature** (1-2 days)
    - Work through all 5 layers
    - Follow the checklist in section 1.2
    - Write tests as you go

2. **Complete Transactions feature** (2-3 days)
    - Consolidate services
    - Remove duplicate endpoints
    - Write comprehensive tests

3. **Complete Import/Export feature** (2-3 days)
    - Test all bank adapters
    - Add validation endpoint
    - Improve error reporting

4. **Complete Statistics feature** (1-2 days)
    - Optimize queries
    - Add caching if needed
    - Create dashboard-ready endpoints

5. **Complete Admin feature** (0.5-1 day)
    - Add health check
    - Add backup endpoint
    - Secure destructive operations

6. **Database optimization** (1 day)
    - Initialize Alembic
    - Add indexes
    - Clean up unused columns

7. **Security hardening** (1-2 days)
    - Strengthen validation
    - Configure CORS properly
    - Add rate limiting
    - Implement audit logging

8. **Testing** (2-3 days)
    - Set up framework
    - Write tests for all features
    - Achieve 70% coverage

9. **Code quality** (1 day)
    - Set up linting
    - Add documentation
    - Standardize error handling

---

## 🎖️ **PRODUCTION READINESS CHECKLIST**

**Before deploying to production, ensure ALL items are checked:**

### Security ✅

- [ ] All input validation implemented
- [ ] CORS configured for production domain only
- [ ] Rate limiting enabled
- [ ] SQL injection protection verified (ORM usage)
- [ ] No sensitive data in logs
- [ ] No stack traces exposed to clients
- [ ] HTTPS enforced (if applicable)
- [ ] Security headers configured (HSTS, CSP, etc.)
- [ ] Authentication implemented (if multi-user)
- [ ] Secrets stored securely (not in code)
- [ ] Database credentials secured
- [ ] File upload limits enforced
- [ ] Security audit completed
- [ ] Penetration testing done (if required)

### Code Quality ✅

- [ ] All code formatted with black
- [ ] All imports sorted with isort
- [ ] No linting errors (flake8, pylint)
- [ ] No type errors (mypy)
- [ ] No security issues (bandit)
- [ ] Code complexity acceptable (CC < 10)
- [ ] No code duplication
- [ ] All TODOs and FIXMEs resolved
- [ ] Code review completed
- [ ] Pre-commit hooks working

### Testing ✅

- [ ] 70%+ test coverage achieved
- [ ] All tests passing
- [ ] Unit tests for all services
- [ ] Integration tests for all endpoints
- [ ] E2E tests for critical workflows
- [ ] Performance tests completed
- [ ] Load testing done
- [ ] Error handling tested
- [ ] Edge cases covered

### Documentation ✅

- [ ] README.md complete with setup instructions
- [ ] ARCHITECTURE.md explains system design
- [ ] API_GUIDE.md for frontend developers
- [ ] DATABASE.md documents schema
- [ ] SECURITY.md explains security model
- [ ] DEPLOYMENT.md has deployment steps
- [ ] CONTRIBUTING.md has development guidelines
- [ ] All API endpoints documented
- [ ] All public methods have docstrings
- [ ] All classes documented
- [ ] Complex algorithms explained
- [ ] Database ERD created
- [ ] Environment variables documented

### Database ✅

- [ ] Alembic migrations set up
- [ ] All migrations tested
- [ ] Database indexes added
- [ ] Backup strategy implemented
- [ ] Backup restoration tested
- [ ] Database constraints in place
- [ ] Orphaned records cleaned
- [ ] Performance optimizations done
- [ ] Connection pooling configured
- [ ] Data retention policy defined

### Monitoring & Operations ✅

- [ ] Health check endpoint working
- [ ] Logging configured properly
- [ ] Log rotation set up
- [ ] Metrics collection enabled
- [ ] Error tracking configured (Sentry, etc.)
- [ ] Performance monitoring set up
- [ ] Alerting configured
- [ ] Slow query logging enabled
- [ ] Resource limits configured
- [ ] Deployment process documented
- [ ] Rollback procedure tested
- [ ] Incident response plan created

### Performance ✅

- [ ] API response times < 200ms for reads
- [ ] Import processing > 1000 rows/second
- [ ] Database queries optimized
- [ ] No N+1 query problems
- [ ] Caching implemented where beneficial
- [ ] Response compression enabled
- [ ] Connection pooling optimized
- [ ] Static file serving optimized (if any)

### Compliance & Legal ✅

- [ ] Data retention policy compliant
- [ ] Privacy policy created (if needed)
- [ ] Terms of service created (if needed)
- [ ] GDPR compliance verified (if applicable)
- [ ] Data export functionality (user rights)
- [ ] Data deletion functionality (right to be forgotten)
- [ ] Audit logging for compliance
- [ ] Regular security audits scheduled

---

## 🎯 **QUALITY GOALS SUMMARY**

To achieve a **well-documented backend with good code quality and security profile**, ensure:

### Documentation Excellence

- ✅ Every endpoint, class, and method documented
- ✅ Architecture and design decisions explained
- ✅ Setup and deployment guides complete
- ✅ API guide for frontend developers
- ✅ Security model documented

### Code Quality Excellence

- ✅ 70%+ test coverage
- ✅ All linting checks pass
- ✅ No security vulnerabilities
- ✅ Code complexity low (CC < 10)
- ✅ No code duplication
- ✅ Type hints everywhere
- ✅ Pre-commit hooks enforced

### Security Excellence

- ✅ All input validated
- ✅ CORS properly configured
- ✅ Rate limiting enabled
- ✅ No information leakage
- ✅ Audit logging implemented
- ✅ Secrets managed securely
- ✅ Security headers configured

---

**Last Updated:** January 17, 2026  
**Next Review:** After completing each feature  
**Production Ready:** When all checklist items are ✅
