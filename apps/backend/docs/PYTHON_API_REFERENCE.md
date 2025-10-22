##### `auto_categorize_by_name_patterns()`

Automatically categorizes recipients based on keyword patterns.

**Built-in Patterns:**

- **Food:** groceries, restaurants, coffee shops
- **Transportation:** gas stations, rideshare, public transit
- **Entertainment:** streaming services, movies
- **Shopping:** online, electronics
- **Healthcare:** pharmacies, doctors
- **Bills:** utilities, internet, phone

**Process:**

- Gets uncategorized recipients
- Matches names against keyword patterns
- Assigns appropriate categories
- Reports results

---

##### `complete_setup(csv_file: str)`

Runs complete category setup workflow.

**Steps:**

1. Import category mappings from CSV
2. Auto-categorize by name patterns
3. Apply categories to transactions
4. Show statistics
5. Show hierarchy
6. Show remaining uncategorized items
7. Export backup

---

##### `main()`

CLI entry point with argparse command routing.

**Available Commands:**

- `complete-setup <csv_file>`: Complete setup workflow
- `import <csv_file>`: Import category mappings
- `import-activity <files...>`: Import from activity CSVs
- `apply`: Apply categories to transactions
- `stats`: Show statistics
- `hierarchy`: Show category tree
- `uncategorized`: Show uncategorized items
- `assign <recipient_id> <category_path>`: Assign category
- `bulk-assign <recipient_ids> <category_path>`: Bulk assign
- `auto-categorize`: Auto-categorize by patterns
- `export <output_file>`: Export mappings

---

## Main Application

### main.py

FastAPI application providing REST API for transaction management.

#### Application Setup

```python
app = FastAPI(
    title="Financial Transaction Manager",
    description="Import and manage financial transactions from various banks",
    version="1.0.0"
)
```

**CORS Configuration:**

- Allowed origins: localhost:8080, localhost:5173, localhost:3000
- Allows credentials
- Allows all methods and headers

---

#### API Endpoints

##### Health Check

###### `GET /`

**Description:** Health check endpoint

**Returns:**

```json
{
  "message": "Financial Transaction Manager API",
  "status": "running"
}
```

---

##### Bank Configuration

###### `GET /supported-banks`

**Description:** Get list of supported bank configurations

**Returns:**

```json
{
  "banks": [
    "revolut",
    "belfius",
    "kbc"
  ]
}
```

---

###### `GET /api/supported-banks`

**Description:** Frontend-compatible version of supported banks endpoint

---

##### Transaction Import

###### `POST /import/csv`

**Description:** Import transactions from CSV file

**Parameters:**

- File upload: `file` (CSV file)
- Query parameter: `bank_name` (required)

**Returns:** `ImportResult` model

---

###### `POST /import/csv/custom`

**Description:** Import with custom CSV configuration

**Parameters:**

- File upload: `file`
- Query parameters: `bank_name`, `date_format`, `date_column`, `recipient_column`, `amount_column`, `memo_column`,
  `separator`, `encoding`, `skip_rows`

**Returns:** `ImportResult` model

---

###### `POST /api/import-csv`

**Description:** Frontend-compatible import endpoint (accepts CSV content as string)

**Body:**

```json
{
  "csv_content": "...",
  "bank_source": "..."
}
```

**Returns:** `CSVImportResponse` model

---

##### Transaction Queries

###### `GET /transactions`

**Description:** Get transactions with filters

**Query Parameters:**

- `bank_account` (str): Bank account filter
- `start_date` (datetime): Minimum date
- `end_date` (datetime): Maximum date
- `category_id` (int): Category filter
- `limit` (int): Results limit (default: 100)
- `offset` (int): Pagination offset (default: 0)

**Returns:** List of `TransactionResponse` models

---

###### `GET /api/transactions`

**Description:** Frontend-compatible transaction list

**Returns:** List of `TransactionFrontend` models (simplified format)

---

###### `GET /transactions/summary`

**Description:** Get transaction summary statistics

**Query Parameters:**

- `bank_account`, `start_date`, `end_date`: Filters

**Returns:** `TransactionSummary` model

---

###### `PUT /transactions/{transaction_id}/category`

**Description:** Update category for transaction

**Parameters:**

- Path: `transaction_id` (int)
- Query: `category_id` (int)

**Returns:** Success message

---

##### Transaction CRUD (Frontend)

###### `POST /api/transactions`

**Description:** Create new transaction (frontend)

**Body:** `TransactionFrontend` model

**Returns:** Created transaction

---

###### `PUT /api/transactions/{transaction_id}`

**Description:** Update transaction (frontend)

**Body:** `TransactionFrontend` model

**Returns:** Updated transaction

---

###### `DELETE /api/transactions/{transaction_id}`

**Description:** Delete transaction (frontend)

**Returns:** Success message

---

##### Bank & Recipient Queries

###### `GET /banks`

**Description:** Get list of all bank accounts in database

**Returns:**

```json
{
  "banks": [
    "Revolut",
    "KBC Checking Account",
    ...
  ]
}
```

---

###### `GET /recipients`

**Description:** Get all recipients

**Returns:** List of `RecipientResponse` models

---

###### `GET /recipients/{recipient_id}`

**Description:** Get specific recipient

**Returns:** `RecipientResponse` model

---

##### Category Endpoints

###### `GET /api/categories`

**Description:** Get all active categories

**Returns:** List of category objects

---

###### `POST /api/categories`

**Description:** Create new category

**Body:**

```json
{
  "name": "...",
  "description": "...",
  "color": "#RRGGBB"
}
```

**Returns:** Created category

---

##### Statistics

###### `GET /api/statistics`

**Description:** Dashboard statistics

**Returns:**

```json
{
  "total_transactions": int,
  "total_amount": float,
  "categories": [
    {
      "name": str,
      "count": int,
      "total": float
    }
  ]
}
```

---

##### Export

###### `GET /export/csv`

**Description:** Export transactions to CSV

**Query Parameters:**

- `from_date` (str): YYYY-MM-DD format
- `to_date` (str): YYYY-MM-DD format
- `bank_account` (str): Filter
- `category_id` (int): Filter

**Returns:** CSV file download

---

#### Pydantic Models

##### `TransactionFrontend`

Simplified transaction model for frontend.

**Fields:** id, transaction_date, description, amount, category, bank_source

##### `TransactionResponse`

Complete transaction response model.

**Fields:** id, date, bank_account, recipient, memo, amount, currency, balance, category_id, created_at

##### `ImportResult`

Import operation result.

**Fields:** batch_id, total_processed, imported, duplicates, errors, status, error_message

##### `TransactionSummary`

Transaction statistics.

**Fields:** total_transactions, total_amount, average_amount, min_amount, max_amount, date_range

##### `RecipientResponse`

Recipient details.

**Fields:** id, name, account_number, default_category_id, created_at, updated_at

##### `CSVImportRequest`

Frontend CSV import request.

**Fields:** csv_content, bank_source

##### `CSVImportResponse`

Frontend CSV import response.

**Fields:** imported, message

---

## Testing

### test_backend.py

Test script for verifying backend imports and startup.

#### Functions

The script runs sequential import tests:

1. **Standard Library Test:** tempfile, datetime, typing
2. **FastAPI Test:** FastAPI, middleware, pydantic
3. **SQLAlchemy Test:** Session
4. **Database Connection Test:** get_db, init_db
5. **Bank Adapters Test:** BankAdapterFactory
6. **Transaction Service Test:** TransactionImportService
7. **Main Module Test:** main.py imports
8. **Server Startup:** Attempts to start uvicorn server

**Usage:**

```bash
python test_backend.py
```

**Exit Codes:**

- 0: All tests passed, server started
- 1: Test failure

---

## Usage Examples

### Import Transactions from CSV

```python
from database.connection import SessionLocal
from services.transaction_service import TransactionImportService

db = SessionLocal()
service = TransactionImportService(db)

result = service.import_csv(
    file_path="/path/to/transactions.csv",
    bank_name="revolut"
)

print(f"Imported: {result['imported']}, Duplicates: {result['duplicates']}")
```

---

### Import Category Mappings from Activity CSVs

```python
from database.connection import SessionLocal
from services.category_service import CategoryService

db = SessionLocal()
service = CategoryService(db)

stats = service.import_recipient_categories_from_activity_csv(
    files=["export_2024.csv", "export_2025.csv"],
    create_missing_recipients=True,
    apply_to_existing_transactions=True
)

print(f"Recipients updated: {stats['recipients_updated']}")
print(f"Categories created: {stats['categories_created']}")
```

---

### Query Transactions with Filters

```python
from datetime import datetime

transactions = service.get_transactions(
    bank_account="Revolut",
    start_date=datetime(2025, 1, 1),
    end_date=datetime(2025, 10, 19),
    limit=50
)

for txn in transactions:
    print(f"{txn.date}: {txn.recipient.name} - €{txn.amount}")
```

---

### Create Hierarchical Categories

```python
from services.category_service import CategoryService

service = CategoryService(db)

# Create parent and child automatically
category = service.get_or_create_category(
    category_path="Food:Groceries",
    description="Supermarket purchases",
    color="#4CAF50"
)

print(f"Category ID: {category.id}, Full Path: {category.full_path}")
```

---

### Auto-Categorize Recipients

```python
# Via CLI
python
category_script.py
auto - categorize

# Programmatically
from category_script import auto_categorize_by_name_patterns

count = auto_categorize_by_name_patterns()
print(f"Categorized {count} recipients")
```

---

### Export Transactions to CSV

```python
from datetime import date

result = service.export_transactions_to_csv(
    file_path="export_2025.csv",
    from_date=date(2025, 1, 1),
    to_date=date(2025, 10, 19),
    bank_account="KBC Checking Account"
)

if result['success']:
    print(f"Exported {result['count']} transactions to {result['file_path']}")
```

---

## Database Schema Summary

### Core Tables

```
transactions
├── id (PK)
├── date
├── amount
├── currency
├── balance
├── memo
├── comment
├── bank_account
├── recipient_id (FK→recipients)
├── category_id (FK→categories)
├── batch_id (FK→import_batches)
├── original_raw_data
├── bank_reference
├── created_at
└── updated_at

categories
├── id (PK)
├── name
├── description
├── color
├── parent_id (FK→categories, self-ref)
├── is_active
├── category_type ('general'|'detailed')
├── full_path (unique)
├── created_at
└── updated_at

recipients
├── id (PK)
├── name
├── account_number
├── default_category_id (FK→categories)
├── notes
├── is_active
├── created_at
└── updated_at

import_batches
├── id (PK)
├── filename
├── bank_name
├── total_processed
├── imported_count
├── duplicate_count
├── error_count
├── config_used (JSON)
├── status
├── error_message
├── created_at
└── completed_at
```

---

## Configuration

### Environment Variables

- `DATABASE_URL`: Database connection string (default: SQLite in backend directory)

### Supported Banks (Pre-configured)

1. **Revolut** (`revolut`)
    - Format: CSV, comma-separated
    - Date: YYYY-MM-DD HH:MM:SS

2. **Belfius** (`belfius`)
    - Format: CSV, semicolon-separated
    - Date: DD/MM/YYYY
    - Decimal: Comma

3. **KBC** (`kbc`)
    - Format: CSV, semicolon-separated
    - Date: DD/MM/YYYY
    - Decimal: Comma

### Custom Bank Configuration

```python
custom_config = {
    "bank_name": "MyBank",
    "encoding": "utf-8",
    "separator": ",",
    "skip_rows": 1,
    "date_format": "%d/%m/%Y",
    "column_mapping": {
        "date": "Transaction Date",
        "recipient": "Payee",
        "amount": "Amount",
        "memo": "Description",
        "currency": "CCY",
        "balance": "Balance"
    }
}
```

---

## Error Handling

### Common Errors

1. **ValueError**: Bank not found, invalid date format
2. **sqlite3.OperationalError**: Missing database columns (run migrations)
3. **FileNotFoundError**: CSV file not found
4. **HTTPException**: API endpoint errors (404, 400)

### Duplicate Detection

Transactions are deduplicated using SHA256 hash of:

- Original CSV row data (preferred), or
- Combination of: date + amount + recipient + memo

---

## Best Practices

1. **Always run init_db()** before using database (automatically runs migrations)
2. **Use hierarchical categories** with "General:Detailed" format
3. **Import activity CSVs** to automatically learn recipient→category mappings
4. **Apply categories to transactions** after updating recipient mappings
5. **Export backups** before bulk operations
6. **Use transactions** (database commits) appropriately for data integrity
7. **Filter queries** with date ranges and pagination for large datasets

---

## Changelog & Notes

- **Hierarchical Categories**: Supports two-level hierarchy (General:Detailed)
- **Recipient Tracking**: Automatic recipient creation and account number tracking
- **Import Batches**: Full audit trail of imports with statistics
- **Duplicate Detection**: Hash-based duplicate detection prevents reimports
- **Activity CSV Import**: Intelligent aggregation chooses most common category per recipient
- **Migrations**: Lightweight schema migrations for SQLite databases
- **Multi-Bank Support**: Extensible adapter pattern for adding new banks

---

**End of Documentation**

*Generated: October 19, 2025*  
*Version: 1.0*  
*Project: Vault Voyager - Financial Transaction Manager*

# Vault Voyager Backend - Python API Reference

**Generated:** October 19, 2025  
**Project:** Financial Transaction Management System

This document provides comprehensive documentation for all Python scripts, classes, functions, and methods in the Vault
Voyager backend.

---

## Table of Contents

1. [Services](#services)
    - [bank_adapters.py](#bank_adapterspy)
    - [transaction_service.py](#transaction_servicepy)
    - [category_service.py](#category_servicepy)
2. [Database](#database)
    - [models.py](#modelspy)
    - [connection.py](#connectionpy)
    - [migrations.py](#migrationspy)
3. [CLI & Scripts](#cli--scripts)
    - [cli.py](#clipy)
    - [category_script.py](#category_scriptpy)
4. [Main Application](#main-application)
    - [main.py](#mainpy)
5. [Testing](#testing)
    - [test_backend.py](#test_backendpy)

---

## Services

### bank_adapters.py

Handles CSV parsing for different bank formats and provides a factory pattern for creating appropriate adapters.

#### Classes

##### `TransactionData` (dataclass)

Standardized transaction data structure used across all bank adapters.

**Attributes:**

- `date` (datetime): Transaction date
- `bank_account` (str): Bank/account identifier
- `recipient` (str): Transaction recipient/payee name
- `memo` (Optional[str]): Transaction memo/description
- `amount` (float): Transaction amount
- `currency` (Optional[str]): Currency code (EUR, USD, etc.)
- `balance` (Optional[float]): Account balance after transaction
- `recipient_account` (Optional[str]): Recipient's account number
- `comment` (Optional[str]): Additional bank-specific comments
- `raw_data` (str): Original CSV row for hashing/duplicate detection

---

##### `BaseBankAdapter` (ABC)

Abstract base class for all bank-specific adapters.

**Constructor:**

```python
def __init__(self, config: Dict[str, Any])
```

- `config`: Dictionary containing bank configuration (bank_name, encoding, etc.)

**Methods:**

###### `parse_csv(file_path: str) -> List[TransactionData]`

Abstract method that must be implemented by subclasses. Parses a CSV file and returns standardized transaction data.

**Parameters:**

- `file_path` (str): Path to the CSV file to parse

**Returns:** List of `TransactionData` objects

---

###### `_create_hash(raw_data: str) -> str`

Creates SHA256 hash for transaction deduplication.

**Parameters:**

- `raw_data` (str): Raw transaction data string

**Returns:** SHA256 hash string

---

##### `BelfiusAdapter(BaseBankAdapter)`

Specialized adapter for Belfius Bank CSV format (Belgian bank, semicolon-separated).

**CSV Format:**

- Delimiter: Semicolon (;)
- Date format: DD/MM/YYYY
- Decimal separator: Comma (,)
- Metadata lines: First 13 lines (skipped)
- Header line: Line 14
- Data starts: Line 15

**Column Mapping:**

1. Account number
2. Transaction date (Boekingsdatum)
3. Statement number
4. Transaction number
5. Recipient account
6. Recipient name
7. Street and number
8. Postal code and place
9. Transaction description
10. Value date
11. Amount (Bedrag)
12. Currency (Devies)
13. BIC
14. Country code
15. Additional messages (Mededelingen)

**Methods:**

###### `parse_csv(file_path: str) -> List[TransactionData]`

Parses Belfius CSV format.

**Special Features:**

- Extracts last balance from line 10 (header)
- Combines recipient name with address for full identification
- Converts comma decimal separator to dot
- Skips metadata and header lines automatically

---

##### `RevolutAdapter(BaseBankAdapter)`

Specialized adapter for Revolut CSV format (comma-separated).

**CSV Format:**

- Delimiter: Comma (,)
- Date format: YYYY-MM-DD HH:MM:SS
- Header: Line 1
- Data starts: Line 2

**Column Mapping:**

1. Type
2. Product
3. Started Date
4. Completed Date
5. Description
6. Amount
7. Fee
8. Currency
9. State
10. Balance

**Methods:**

###### `parse_csv(file_path: str) -> List[TransactionData]`

Parses Revolut CSV format.

**Special Features:**

- Skips PENDING transactions (only imports COMPLETED)
- Uses completed date for transaction date
- Combines transaction type and product in memo field
- Handles multiple date formats (with/without seconds, date-only)

---

##### `KBCAdapter(BaseBankAdapter)`

Specialized adapter for KBC Bank CSV format (Belgian bank, semicolon-separated).

**CSV Format:**

- Delimiter: Semicolon (;)
- Date format: DD/MM/YYYY
- Decimal separator: Comma (,)
- Header: Line 1 (starts with "Rekeningnummer")

**Column Mapping:**

1. Account identifier (IBAN)
2. Empty field
3. Account holder/description
4. Currency (EUR)
5. Reference number
6. Transaction date
7. Memo/Description
8. Value date
9. Amount
10. Account balance
11. Additional amount field
12. Empty/additional field
13. Recipient account
14. Bank code
15. Recipient name
16. Address/Location
17. Additional info (comment)

**Methods:**

###### `parse_csv(file_path: str) -> List[TransactionData]`

Parses KBC CSV format.

**Special Features:**

- Detects account type from IBAN (BE61xxx = Checking, BE34xxx = Savings)
- Combines recipient name with address
- Converts comma decimal separator to dot
- Uses field 17 for additional comments

---

##### `GenericCSVAdapter(BaseBankAdapter)`

Configurable adapter for custom/generic CSV formats.

**Configuration Required:**

- `encoding`: File encoding (default: "utf-8")
- `separator`: CSV delimiter (default: ",")
- `skip_rows`: Number of header rows to skip (default: 0)
- `date_format`: Python datetime format string
- `column_mapping`: Dictionary mapping field names to column names
    - Required: `date`, `recipient`, `amount`
    - Optional: `memo`, `currency`, `balance`

**Methods:**

###### `parse_csv(file_path: str) -> List[TransactionData]`

Parses CSV using configuration mapping. Uses pandas for parsing.

###### `_parse_amount(amount_str: str) -> float`

Parses amount strings handling various formats.

**Features:**

- Removes currency symbols ($, €, £)
- Removes commas
- Handles negative amounts in parentheses: (100.50) → -100.50
- Strips whitespace

---

##### `BankAdapterFactory`

Factory class for creating appropriate bank adapters.

**Static Methods:**

###### `create_adapter(bank_name: str, custom_config: Optional[Dict] = None) -> BaseBankAdapter`

Creates the appropriate adapter for the specified bank.

**Parameters:**

- `bank_name` (str): Bank identifier (e.g., "revolut", "belfius", "kbc")
- `custom_config` (Optional[Dict]): Custom configuration for GenericCSVAdapter

**Returns:** Instance of appropriate `BaseBankAdapter` subclass

**Raises:** `ValueError` if bank name not found and no custom config provided

**Supported Banks:**

- `revolut` → RevolutAdapter
- `belfius` → BelfiusAdapter
- `kbc` → KBCAdapter
- Custom configuration → GenericCSVAdapter

---

###### `get_supported_banks() -> List[str]`

Returns list of pre-configured bank identifiers.

**Returns:** `['revolut', 'belfius', 'kbc']`

---

### transaction_service.py

Manages financial transaction imports, processing, and queries.

#### Classes

##### `TransactionImportService`

Service class for importing and managing financial transactions.

**Constructor:**

```python
def __init__(self, db_session: Session)
```

- `db_session`: SQLAlchemy database session

---

**Methods:**

###### `import_csv(file_path: str, bank_name: str, custom_config: Optional[Dict] = None) -> Dict[str, Any]`

Imports transactions from a CSV file using appropriate bank adapter.

**Parameters:**

- `file_path` (str): Path to CSV file
- `bank_name` (str): Bank identifier
- `custom_config` (Optional[Dict]): Custom adapter configuration

**Returns:** Dictionary with import statistics:

```python
{
    'batch_id': int,  # Import batch ID
    'total_processed': int,  # Total rows processed
    'imported': int,  # Successfully imported
    'duplicates': int,  # Duplicate transactions skipped
    'errors': int,  # Errors encountered
    'status': str,  # 'completed', 'completed_with_errors', or 'failed'
    'error_message': str  # Error details (if failed)
}
```

**Process:**

1. Creates ImportBatch record
2. Gets appropriate bank adapter
3. Parses CSV file
4. Processes transactions (creates/updates recipients, checks duplicates)
5. Updates batch statistics
6. Commits to database

---

###### `_process_transactions(transaction_data_list: List[TransactionData], batch_id: int) -> Dict[str, int]`

Internal method to process parsed transaction data into database records.

**Parameters:**

- `transaction_data_list`: List of `TransactionData` objects
- `batch_id`: Import batch ID

**Returns:** Processing statistics dictionary

**Process:**

- Creates transaction hash for duplicate detection
- Gets or creates recipient
- Creates Transaction record
- Handles errors gracefully

---

###### `_create_transaction_hash(transaction_data: TransactionData) -> str`

Creates unique hash for duplicate detection.

**Parameters:**

- `transaction_data`: Transaction data object

**Returns:** SHA256 hash string

**Logic:**

- Uses raw_data if available
- Falls back to key fields: date|amount|recipient|memo

---

###### `_is_duplicate_transaction(transaction_hash: str) -> bool`

Checks if transaction with hash already exists.

**Parameters:**

- `transaction_hash` (str): Transaction hash to check

**Returns:** True if duplicate exists, False otherwise

---

###### `_get_or_create_recipient(name: str, account_number: Optional[str] = None) -> Recipient`

Gets existing recipient or creates new one.

**Parameters:**

- `name` (str): Recipient name
- `account_number` (Optional[str]): Recipient account number

**Returns:** Recipient model instance

**Logic:**

- Searches by exact name match
- Updates account number if provided and not already set
- Creates new recipient if not found

---

###### `_generate_bank_reference(transaction_data: TransactionData) -> str`

Generates bank reference (currently uses transaction hash).

**Parameters:**

- `transaction_data`: Transaction data object

**Returns:** Reference string

---

###### `get_recipients_with_account_numbers() -> List[Recipient]`

Retrieves all recipients that have account numbers.

**Returns:** List of Recipient objects with non-null account_number

---

###### `update_recipient_category(recipient_id: int, category_id: Optional[int]) -> bool`

Updates default category for a recipient.

**Parameters:**

- `recipient_id` (int): Recipient ID
- `category_id` (Optional[int]): Category ID to assign (None to clear)

**Returns:** True if successful, False if recipient not found

---

###### `get_transactions(...) -> List[Transaction]`

Retrieves transactions with optional filters.

**Parameters:**

- `bank_account` (Optional[str]): Filter by bank account (partial match)
- `start_date` (Optional[datetime]): Minimum transaction date
- `end_date` (Optional[datetime]): Maximum transaction date
- `category_id` (Optional[int]): Filter by category
- `recipient_id` (Optional[int]): Filter by recipient ID
- `recipient_name` (Optional[str]): Filter by recipient name (partial match)
- `limit` (int): Maximum results (default: 100)
- `offset` (int): Result offset for pagination (default: 0)

**Returns:** List of Transaction objects ordered by date descending

---

######

`get_transaction_summary(start_date: Optional[datetime] = None, end_date: Optional[datetime] = None) -> Dict[str, Any]`

Calculates transaction statistics.

**Parameters:**

- `start_date` (Optional[datetime]): Filter start date
- `end_date` (Optional[datetime]): Filter end date

**Returns:** Summary dictionary:

```python
{
    'total_transactions': int,
    'total_amount': float,
    'average_amount': float,
    'min_amount': float,
    'max_amount': float,
    'date_range': {
        'start': date,
        'end': date
    }
}
```

---

###### `update_transaction_category(transaction_id: int, category_id: int) -> bool`

Updates category for a specific transaction.

**Parameters:**

- `transaction_id` (int): Transaction ID
- `category_id` (int): Category ID to assign

**Returns:** True if successful, False if transaction not found

---

######

`export_transactions_to_csv(file_path: str, from_date: Optional[date] = None, to_date: Optional[date] = None, bank_account: Optional[str] = None, category_id: Optional[int] = None) -> Dict[str, Any]`

Exports transactions to CSV file.

**Parameters:**

- `file_path` (str): Output file path
- `from_date` (Optional[date]): Start date filter
- `to_date` (Optional[date]): End date filter (defaults to today)
- `bank_account` (Optional[str]): Bank account filter
- `category_id` (Optional[int]): Category filter

**Returns:** Export result dictionary:

```python
{
    'success': bool,
    'message': str,
    'count': int,
    'file_path': str
}
```

**CSV Columns:**

- Date, Bank Account, Recipient, Recipient Account, Memo, Amount, Currency, Balance, Category, Comment

---

### category_service.py

Manages hierarchical categories and recipient-to-category mappings.

#### Classes

##### `CategoryService`

Service for managing hierarchical categories (General:Detailed format).

**Constructor:**

```python
def __init__(self, db_session: Session)
```

- `db_session`: SQLAlchemy database session

---

**Methods:**

###### `parse_category_path(category_path: str) -> Tuple[str, Optional[str]]`

Parses category path in format "General:Detailed".

**Parameters:**

- `category_path` (str): Category path (e.g., "Food:Groceries")

**Returns:** Tuple of (general, detailed) where detailed can be None

**Examples:**

- "Food:Groceries" → ("Food", "Groceries")
- "Transportation" → ("Transportation", None)

---

######

`get_or_create_category(category_path: str, description: Optional[str] = None, color: Optional[str] = None) -> Category`

Gets existing category or creates new one from path.

**Parameters:**

- `category_path` (str): Category path
- `description` (Optional[str]): Category description
- `color` (Optional[str]): Hex color code (#RRGGBB)

**Returns:** Category model instance

**Logic:**

- Creates parent (general) category if needed
- Creates child (detailed) category if path contains ":"
- Sets category_type appropriately ('general' or 'detailed')
- Sets full_path for efficient querying

---

######

`_get_or_create_general_category(name: str, description: Optional[str] = None, color: Optional[str] = None) -> Category`

Internal method to get/create general (parent) category.

**Parameters:**

- `name` (str): Category name
- `description` (Optional[str]): Description
- `color` (Optional[str]): Color code

**Returns:** Category instance

---

######

`import_category_mappings_from_csv(file_path: str, recipient_column: str = 'Recipient', category_column: str = 'Category', has_header: bool = True) -> Dict[str, Any]`

Imports recipient→category mappings from simple CSV.

**Parameters:**

- `file_path` (str): CSV file path
- `recipient_column` (str): Column name for recipients
- `category_column` (str): Column name for categories
- `has_header` (bool): Whether CSV has header row

**Expected CSV Format:**

```csv
Recipient,Category
"Starbucks","Food:Coffee"
"Shell","Transportation:Gas"
```

**Returns:** Import statistics:

```python
{
    'total_processed': int,
    'mappings_created': int,
    'categories_created': int,
    'recipients_not_found': List[str],
    'errors': List[str]
}
```

**Note:** Only updates existing recipients (doesn't create new ones)

---

######

`import_recipient_categories_from_activity_csv(files: Iterable[str], recipient_columns: Iterable[str] = ("Recipient", "Payee", "Description"), category_columns: Iterable[str] = ("Category",), delimiter_candidates: Iterable[str] = (",", ";", "\t"), create_missing_recipients: bool = True, apply_to_existing_transactions: bool = False) -> Dict[str, Any]`

Aggregates recipient→category mappings from activity/transaction CSV files.

**Parameters:**

- `files` (Iterable[str]): List of CSV file paths
- `recipient_columns` (Iterable[str]): Possible recipient column names (case-insensitive)
- `category_columns` (Iterable[str]): Possible category column names
- `delimiter_candidates` (Iterable[str]): Delimiters to try
- `create_missing_recipients` (bool): Create recipients if not in database
- `apply_to_existing_transactions` (bool): Apply to uncategorized transactions after import

**Expected CSV Format:**

```csv
Date,Check,Recipient,Category,Memo,...
2025-01-01,,Starbucks,Food:Coffee,Latte
2025-01-02,,Starbucks,Food:Restaurants,Breakfast
```

**Logic:**

1. For each file, detects delimiter by trying candidates
2. Identifies recipient and category columns (case-insensitive match)
3. Tallies categories per recipient across all files
4. Chooses most common category for each recipient (handles duplicates)
5. Creates/updates categories using hierarchical structure
6. Updates recipient default_category_id
7. Optionally applies to existing transactions

**Returns:** Import statistics:

```python
{
    'files_processed': int,
    'rows_read': int,
    'recipients_considered': int,
    'recipients_updated': int,
    'recipients_created': int,
    'categories_created': int,
    'skipped_files': List[Dict],
    'errors': List[str],
    'applied_to_transactions': Dict  # if apply_to_existing_transactions=True
}
```

**Use Case:** Import existing categorized transaction exports to automatically set up recipient→category mappings

---

######

`apply_recipient_categories_to_transactions(recipient_id: Optional[int] = None, overwrite_existing: bool = False) -> Dict[str, int]`

Applies default recipient categories to transactions.

**Parameters:**

- `recipient_id` (Optional[int]): Apply only for specific recipient
- `overwrite_existing` (bool): Overwrite transactions that already have categories

**Returns:** Statistics dictionary:

```python
{
    'updated': int,
    'total_checked': int
}
```

**Logic:**

- Joins transactions with recipients
- Filters to recipients with default_category_id set
- Optionally filters to uncategorized transactions only
- Updates transaction.category_id

---

###### `get_all_categories_hierarchical() -> List[Dict[str, Any]]`

Retrieves all categories in hierarchical structure.

**Returns:** List of general categories with nested children:

```python
[
    {
        'id': int,
        'name': str,
        'full_path': str,
        'type': 'general',
        'description': str,
        'color': str,
        'transaction_count': int,
        'children': [
            {
                'id': int,
                'name': str,
                'full_path': str,
                'type': 'detailed',
                'transaction_count': int,
                ...
            }
        ]
    }
]
```

---

###### `get_category_by_path(path: str) -> Optional[Category]`

Finds category by full path.

**Parameters:**

- `path` (str): Full category path (e.g., "Food:Meat")

**Returns:** Category instance or None

---

###### `get_uncategorized_recipients() -> List[Recipient]`

Gets all active recipients without default category.

**Returns:** List of Recipient objects

---

###### `get_uncategorized_transactions(limit: int = 100) -> List[Transaction]`

Gets transactions without assigned category.

**Parameters:**

- `limit` (int): Maximum results

**Returns:** List of Transaction objects (most recent first)

---

###### `get_category_statistics() -> Dict[str, Any]`

Calculates comprehensive category statistics.

**Returns:** Statistics dictionary:

```python
{
    'total_categories': int,
    'general_categories': int,
    'detailed_categories': int,
    'categorized_transactions': int,
    'uncategorized_transactions': int,
    'categorized_recipients': int,
    'uncategorized_recipients': int
}
```

---

###### `suggest_category_for_recipient(recipient_name: str) -> Optional[str]`

Suggests category based on similar recipient names.

**Parameters:**

- `recipient_name` (str): Recipient name

**Returns:** Most common category path among similar recipients, or None

**Logic:**

- Finds recipients with similar names (ILIKE match) that have categories
- Returns most frequently used category among matches

---

###### `bulk_assign_category(recipient_ids: List[int], category_path: str) -> Dict[str, int]`

Assigns category to multiple recipients at once.

**Parameters:**

- `recipient_ids` (List[int]): List of recipient IDs
- `category_path` (str): Category path to assign

**Returns:** `{'updated': int}` - count of recipients updated

---

###### `export_category_mappings_to_csv(file_path: str, include_uncategorized: bool = False) -> Dict[str, Any]`

Exports recipient→category mappings to CSV.

**Parameters:**

- `file_path` (str): Output file path
- `include_uncategorized` (bool): Include recipients without categories

**Returns:** Export result:

```python
{
    'success': bool,
    'count': int,
    'file_path': str,
    'error': str  # if success=False
}
```

**CSV Format:**

```csv
Recipient,Category,Transaction Count
"Starbucks","Food:Coffee",25
"Shell","Transportation:Gas",15
```

---

## Database

### models.py

SQLAlchemy ORM models for the database schema.

#### Models

##### `Transaction`

Represents a financial transaction.

**Table:** `transactions`

**Columns:**

- `id` (Integer, PK): Transaction ID
- `date` (Date, indexed): Transaction date
- `amount` (Numeric(10,2)): Transaction amount
- `currency` (String(3)): Currency code (EUR, USD, etc.)
- `balance` (Numeric(12,2)): Account balance after transaction
- `memo` (Text): Transaction memo/description
- `comment` (Text): Additional bank-specific comments
- `bank_account` (String(100), indexed): Bank/account identifier
- `recipient_id` (Integer, FK→recipients.id): Recipient foreign key
- `category_id` (Integer, FK→categories.id): Category foreign key (nullable)
- `batch_id` (Integer, FK→import_batches.id): Import batch foreign key (nullable)
- `original_raw_data` (Text): Original CSV row
- `bank_reference` (String(100)): Transaction hash for duplicate detection
- `created_at` (DateTime): Creation timestamp
- `updated_at` (DateTime): Last update timestamp

**Relationships:**

- `recipient` → Recipient (many-to-one)
- `category` → Category (many-to-one)
- `import_batch` → ImportBatch (many-to-one)

---

##### `Category`

Represents a transaction category with hierarchical structure.

**Table:** `categories`

**Columns:**

- `id` (Integer, PK): Category ID
- `name` (String(100), indexed): Category name
- `description` (Text): Category description
- `color` (String(7)): Hex color code (#RRGGBB)
- `parent_id` (Integer, FK→categories.id): Parent category (nullable)
- `is_active` (Boolean): Whether category is active
- `category_type` (String(20)): 'general' or 'detailed'
- `full_path` (String(200), unique, indexed): Full path (e.g., "Food:Groceries")
- `created_at` (DateTime): Creation timestamp
- `updated_at` (DateTime): Last update timestamp

**Relationships:**

- `recipients` → Recipient (one-to-many)
- `transactions` → Transaction (one-to-many)
- `parent` → Category (self-referential)
- `children` → Category (self-referential)

**Indexes:**

- idx_category_path on full_path

---

##### `Recipient`

Represents a transaction recipient/payee.

**Table:** `recipients`

**Columns:**

- `id` (Integer, PK): Recipient ID
- `name` (String(255), indexed): Recipient name
- `account_number` (String(50)): Recipient account number (nullable)
- `default_category_id` (Integer, FK→categories.id): Default category (nullable)
- `notes` (Text): Additional notes
- `is_active` (Boolean): Whether recipient is active
- `created_at` (DateTime): Creation timestamp
- `updated_at` (DateTime): Last update timestamp

**Relationships:**

- `transactions` → Transaction (one-to-many)
- `default_category` → Category (many-to-one)

---

##### `ImportBatch`

Tracks CSV import operations.

**Table:** `import_batches`

**Columns:**

- `id` (Integer, PK): Batch ID
- `filename` (String(255)): CSV filename
- `bank_name` (String(100)): Bank identifier
- `total_processed` (Integer): Total rows processed
- `imported_count` (Integer): Successfully imported transactions
- `duplicate_count` (Integer): Duplicate transactions skipped
- `error_count` (Integer): Errors encountered
- `config_used` (Text): JSON configuration for reproducibility
- `status` (String(20)): 'processing', 'completed', 'completed_with_errors', 'failed'
- `error_message` (Text): Error details (if failed)
- `created_at` (DateTime): Creation timestamp
- `completed_at` (DateTime): Completion timestamp (nullable)

**Relationships:**

- `transactions` → Transaction (one-to-many)

---

##### `BankAdapter`

Stores bank adapter configurations (currently unused in code).

**Table:** `bank_adapters`

**Columns:**

- `id` (Integer, PK): Adapter ID
- `bank_name` (String(100), unique): Bank name
- `adapter_config` (Text): JSON configuration
- `is_active` (String(10)): Whether adapter is active
- `created_at` (DateTime): Creation timestamp
- `updated_at` (DateTime): Last update timestamp

---

### connection.py

Database connection and initialization.

#### Functions

##### `get_db() -> Generator[Session, None, None]`

FastAPI dependency for database sessions.

**Yields:** SQLAlchemy Session

**Usage:**

```python
@app.get("/transactions")
async def get_transactions(db: Session = Depends(get_db)):
    # Use db session
    pass
```

---

##### `init_db() -> None`

Initializes database tables and runs migrations.

**Process:**

1. Runs lightweight SQLite migrations (if applicable)
2. Creates all tables defined in models.py

**Called:** On application startup, before handling requests

---

#### Variables

- `DATABASE_URL` (str): Database connection string (from env or default SQLite)
- `engine` (Engine): SQLAlchemy engine instance
- `SessionLocal` (sessionmaker): Session factory
- `Base` (declarative_base): Base class for ORM models

---

### migrations.py

Lightweight migrations for SQLite schema alignment.

#### Functions

##### `_get_columns(engine: Engine, table: str) -> Set[str]`

Internal helper to get existing columns in a table.

**Parameters:**

- `engine` (Engine): SQLAlchemy engine
- `table` (str): Table name

**Returns:** Set of column names

---

##### `migrate(engine: Engine) -> None`

Applies non-destructive migrations to align schema with current models.

**Parameters:**

- `engine` (Engine): SQLAlchemy engine

**Process:**

- Checks existing columns in `categories` and `recipients` tables
- Adds missing columns using ALTER TABLE
- Creates indexes if they don't exist

**Migrations Applied:**

**Categories Table:**

- description (TEXT)
- color (VARCHAR(7))
- parent_id (INTEGER)
- is_active (BOOLEAN)
- category_type (VARCHAR(20))
- full_path (VARCHAR(200))
- created_at (DATETIME)
- updated_at (DATETIME)
- Index: idx_category_path on full_path

**Recipients Table:**

- account_number (VARCHAR(50))
- default_category_id (INTEGER)
- notes (TEXT)
- is_active (BOOLEAN)
- created_at (DATETIME)
- updated_at (DATETIME)

**Note:** Non-destructive - only adds missing columns, never removes or modifies existing data

---

## CLI & Scripts

### cli.py

Command-line interface for managing transactions and categories.

#### Functions

##### `import_csv_command(args)`

Handles CSV import via CLI.

**Arguments from argparse:**

- `file`: CSV file path
- `bank`: Bank name
- `custom`: Whether to use custom configuration
- Additional custom config flags (date_format, date_column, etc.)

**Process:**

1. Creates TransactionImportService
2. Builds custom config if specified
3. Imports CSV
4. Prints results

---

##### `export_csv_command(args)`

Handles CSV export via CLI.

**Arguments from argparse:**

- `output`: Output file path
- `from_date`: Start date (YYYY-MM-DD)
- `to_date`: End date (YYYY-MM-DD)
- `bank_account`: Bank filter
- `category_id`: Category filter

---

##### `list_transactions_command(args)`

Lists transactions with filters.

**Arguments:**

- `start_date`, `end_date`: Date range
- `bank_account`: Bank filter
- `category_id`, `recipient_id`, `recipient_name`: Filters
- `limit`, `offset`: Pagination

**Output:** Formatted table to console

---

##### `list_recipients_command(args)`

Lists recipients.

**Arguments:**

- `with_accounts`: Show only recipients with account numbers

---

##### `update_recipient_command(args)`

Updates recipient details.

**Arguments:**

- `recipient_id`: Recipient ID
- `account_number`: New account number
- `category_id`: New default category
- `notes`: New notes

---

##### `create_category_command(args)`

Creates a new category.

**Arguments:**

- `name`: Category name/path
- `description`: Description
- `color`: Color code

---

##### `list_categories_command(args)`

Lists all categories.

**Arguments:**

- `hierarchical`: Show hierarchical tree view vs flat list

---

##### `assign_category_command(args)`

Assigns category to recipient(s).

**Arguments:**

- `recipient_id`: Single recipient ID
- `recipient_ids`: Comma-separated IDs for bulk
- `category_path`: Category path to assign

---

##### `export_category_mappings_command(args)`

Exports recipient→category mappings.

**Arguments:**

- `output`: Output file path
- `include_uncategorized`: Include uncategorized recipients

---

### category_script.py

Specialized script for category management with advanced features.

#### Functions

##### `import_categories_from_csv(csv_file: str, recipient_col: str = "Recipient", category_col: str = "Category")`

Imports category mappings from simple CSV.

**Calls:** `CategoryService.import_category_mappings_from_csv()`

---

##### `import_activity_mappings(files: list[str], apply_to_transactions: bool = True)`

Imports recipient→category mappings from activity CSVs using majority vote.

**Parameters:**

- `files`: List of CSV file paths
- `apply_to_transactions`: Apply to existing transactions after import

**Calls:** `CategoryService.import_recipient_categories_from_activity_csv()`

**Output:** Detailed statistics printed to console

---

##### `apply_categories_to_transactions(recipient_id: int = None, overwrite: bool = False)`

Applies recipient categories to transactions.

---

##### `show_category_statistics()`

Displays comprehensive category statistics.

**Output:**

- Total categories (general/detailed breakdown)
- Transaction categorization coverage
- Recipient categorization coverage

---

##### `show_category_hierarchy()`

Displays category tree structure.

**Output:** Formatted tree with transaction counts

---

##### `show_uncategorized_items(item_type: str = "all", limit: int = 50)`

Shows uncategorized recipients and/or transactions.

**Parameters:**

- `item_type`: 'recipients', 'transactions', or 'all'
- `limit`: Maximum items to display

---

##### `assign_category_to_recipient(recipient_id: int, category_path: str, apply_to_transactions: bool = True)`

Assigns category to specific recipient.

---

##### `bulk_assign_categories(recipient_ids: list, category_path: str)`

Assigns category to multiple recipients.

---

##### `export_category_mappings(output_file: str, include_uncategorized: bool = False)`

Exports category mappings to CSV.

---

