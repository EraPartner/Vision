# Transaction Export Feature

This document describes how to export transactions from the database to CSV format.

## Features

- Export transactions from a specific date range
- Filter by bank account
- Filter by category
- Exports to standard CSV format with all transaction details
- Defaults to "from specified date until today" if no end date is provided

## Usage

### 1. Using the CLI

Export transactions from a specific date until today:

```bash
python cli.py export output.csv "Revolut" --from-date 2024-01-01
```

Export transactions for a specific date range:

```bash
python cli.py export transactions_2024.csv "KBC Checking Account" --from-date 2024-01-01 --to-date 2024-12-31
```

Export with category filter:

```bash
python cli.py export groceries.csv "Revolut" --from-date 2024-01-01 --category-id 3
```

Export all transactions for a bank account (no date filter):

```bash
python cli.py export all_transactions.csv "Belfius Checking Account"
```

### 2. Using the API

#### Backend API Endpoint

```
GET /export/csv
```

**Query Parameters:**

- `from_date` (optional): Start date in YYYY-MM-DD format
- `to_date` (optional): End date in YYYY-MM-DD format (defaults to today)
- `bank_account` (optional): Filter by specific bank account name
- `category_id` (optional): Filter by category ID

**Example:**

```bash
curl -O "http://localhost:8000/export/csv?from_date=2024-01-01&bank_account=Revolut"
```

#### Frontend API Endpoint

```
GET /api/export-csv
```

**Query Parameters:**

- `from_date` (optional): Start date in YYYY-MM-DD format
- `to_date` (optional): End date in YYYY-MM-DD format (defaults to today)
- `bank_account` (optional): Filter by specific bank account name

**Example:**

```bash
curl -O "http://localhost:8000/api/export-csv?from_date=2024-06-01"
```

### 3. Using Python Code Directly

```python
from datetime import date
from database.connection import SessionLocal
from services.transaction_service import TransactionImportService

db = SessionLocal()
service = TransactionImportService(db)

# Export transactions from January 1, 2024 until today
result = service.export_transactions_to_csv(
    file_path="my_export.csv",
    from_date=date(2024, 1, 1),
    to_date=None,  # Defaults to today
    bank_account="Revolut",
    category_id=None
)

if result['success']:
    print(f"Exported {result['count']} transactions to {result['file_path']}")
else:
    print(f"Export failed: {result['message']}")

db.close()
```

## CSV Output Format

The exported CSV file contains the following columns:

- **Date**: Transaction date (YYYY-MM-DD)
- **Bank Account**: Name of the bank account
- **Recipient**: Name of the recipient/merchant
- **Recipient Account**: Account number of recipient (if available)
- **Memo**: Transaction description/memo
- **Amount**: Transaction amount (negative for expenses, positive for income)
- **Currency**: Currency code (EUR, USD, etc.)
- **Balance**: Account balance after transaction (if available)
- **Category**: Assigned category name (if categorized)
- **Comment**: Additional bank-specific comments

## Examples

### Export all Revolut transactions from July 2024

```bash
python cli.py export revolut_july.csv "Revolut" --from-date 2024-07-01 --to-date 2024-07-31
```

### Export all transactions from the beginning of the year

```bash
python cli.py export year_to_date.csv "KBC Checking Account" --from-date 2024-01-01
```

### Via API with curl

```bash
# Download directly to file
curl -o transactions.csv "http://localhost:8000/export/csv?from_date=2024-01-01&to_date=2024-12-31&bank_account=Revolut"
```

## Return Values

The export function returns a dictionary with the following structure:

```python
{
    'success': True / False,
    'message': 'Success or error message',
    'count': 123,  # Number of transactions exported
    'file_path': '/path/to/export.csv',
    'date_range': {
        'from': '2024-01-01',
        'to': '2024-12-31'
    }
}
```

## Notes

- If no `to_date` is specified, the export will include all transactions up to today
- If no `from_date` is specified, all historical transactions will be exported
- The exported CSV uses UTF-8 encoding
- Transactions are exported in ascending date order (oldest first)
- Empty fields are left blank in the CSV output

