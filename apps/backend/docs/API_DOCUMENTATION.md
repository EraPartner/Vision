# Vault Voyager API Documentation

## Overview

FastAPI-based REST API for managing financial transactions. Provides endpoints for importing, querying, and managing
transactions from various bank sources.

## Starting the API

### Option 1: Using the startup script

```bash
./start_api.sh
```

### Option 2: Manual start

```bash
source venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at:

- **API Base URL**: http://localhost:8000
- **Interactive Docs**: http://localhost:8000/docs
- **Alternative Docs**: http://localhost:8000/redoc

## API Endpoints

### Frontend Endpoints (Recommended for new frontends)

#### Transactions

- `GET /api/transactions` - Get all transactions (simplified format)
- `POST /api/transactions` - Create a new transaction
- `PUT /api/transactions/{id}` - Update a transaction
- `DELETE /api/transactions/{id}` - Delete a transaction

#### Categories

- `GET /api/categories` - Get all categories
- `POST /api/categories` - Create a new category

#### CSV Import

- `POST /api/import-csv` - Import transactions from CSV content
    - Body: `{"csv_content": "...", "bank_source": "KBC"}`
- `GET /api/supported-banks` - Get list of supported bank formats

#### Statistics

- `GET /api/statistics` - Get dashboard statistics
    - Returns: total transactions, total amount, category breakdown

### Advanced Endpoints

#### Transaction Management

- `GET /transactions` - Get transactions with filters
    - Query params: `bank_account`, `start_date`, `end_date`, `category_id`, `limit`, `offset`
- `GET /transactions/summary` - Get transaction summary statistics
- `PUT /transactions/{id}/category` - Update transaction category

#### Bank & Recipient Management

- `GET /banks` - Get list of all bank accounts in database
- `GET /recipients` - Get all recipients
- `GET /recipients/{id}` - Get specific recipient details

#### File Upload

- `POST /import/csv` - Import CSV file
    - Requires: file upload + bank_name parameter
- `POST /import/csv/custom` - Import with custom CSV configuration

## Example Usage

### JavaScript/TypeScript Frontend

```typescript
// Fetch all transactions
const response = await fetch('http://localhost:8000/api/transactions');
const transactions = await response.json();

// Create a transaction
await fetch('http://localhost:8000/api/transactions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    transaction_date: '2025-10-15',
    description: 'Grocery Store',
    amount: -45.50,
    category: 'Food',
    bank_source: 'KBC'
  })
});

// Get statistics
const stats = await fetch('http://localhost:8000/api/statistics');
const data = await stats.json();
console.log(data.total_transactions, data.total_amount);

// Import CSV
await fetch('http://localhost:8000/api/import-csv', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    csv_content: csvFileContent,
    bank_source: 'KBC'
  })
});
```

### Python Client

```python
import requests

BASE_URL = "http://localhost:8000"

# Get all transactions
transactions = requests.get(f"{BASE_URL}/api/transactions").json()

# Get categories
categories = requests.get(f"{BASE_URL}/api/categories").json()

# Get statistics
stats = requests.get(f"{BASE_URL}/api/statistics").json()
print(f"Total: {stats['total_transactions']} transactions, ${stats['total_amount']}")

# Create category
new_category = requests.post(
    f"{BASE_URL}/api/categories",
    json={"name": "Entertainment", "color": "#FF5733"}
).json()
```

### cURL Examples

```bash
# Health check
curl http://localhost:8000/

# Get transactions
curl http://localhost:8000/api/transactions

# Get statistics
curl http://localhost:8000/api/statistics

# Create a category
curl -X POST http://localhost:8000/api/categories \
  -H "Content-Type: application/json" \
  -d '{"name": "Travel", "description": "Travel expenses", "color": "#4A90E2"}'

# Get supported banks
curl http://localhost:8000/api/supported-banks
```

## Supported Query Types

FastAPI excels at all the query types you'd need for a financial dashboard:

### 1. **Filtering** - Get specific transactions

```
GET /transactions?bank_account=KBC&start_date=2025-01-01&end_date=2025-12-31
```

### 2. **Pagination** - Handle large datasets

```
GET /transactions?limit=50&offset=0
```

### 3. **Aggregations** - Get summaries and statistics

```
GET /transactions/summary?bank_account=KBC
GET /api/statistics
```

### 4. **Category Analysis** - Breakdown by category

```
GET /api/statistics
```

### 5. **Time-based Queries** - Filter by date ranges

```
GET /transactions?start_date=2025-10-01&end_date=2025-10-31
```

### 6. **CRUD Operations** - Create, Read, Update, Delete

- Create: `POST /api/transactions`
- Read: `GET /api/transactions`
- Update: `PUT /api/transactions/{id}`
- Delete: `DELETE /api/transactions/{id}`

## CORS Configuration

The API allows requests from these origins:

- http://localhost:8080
- http://localhost:5173 (Vite default)
- http://localhost:3000 (React/Next.js default)

To add more origins, edit the `allow_origins` list in `main.py`.

## Data Models

### Transaction (Frontend Format)

```json
{
  "id": 1,
  "transaction_date": "2025-10-15",
  "description": "Grocery Store",
  "amount": -45.50,
  "category": "Food",
  "bank_source": "KBC"
}
```

### Category

```json
{
  "id": 1,
  "name": "Food",
  "description": "Groceries and dining",
  "color": "#FF5733"
}
```

### Statistics

```json
{
  "total_transactions": 150,
  "total_amount": -5432.10,
  "categories": [
    {
      "name": "Food",
      "count": 45,
      "total": -1234.56
    }
  ]
}
```

## Why FastAPI is Perfect for This Project

1. **Auto-generated Documentation** - Visit /docs to see interactive API docs
2. **Type Safety** - Pydantic models ensure data validation
3. **Fast Performance** - Async-capable for concurrent requests
4. **Easy Frontend Integration** - Works with any frontend (React, Vue, Angular, etc.)
5. **Flexible Queries** - Supports all types of filtering, pagination, aggregation
6. **Modern Python** - Uses type hints and modern features
7. **Built-in CORS** - Easy to configure for frontend access

## Next Steps

1. Start the API: `./start_api.sh`
2. Visit http://localhost:8000/docs to explore the interactive documentation
3. Test endpoints using the Swagger UI
4. Build your frontend using the `/api/*` endpoints
5. Import your bank CSV files using `/api/import-csv`

## Troubleshooting

If the API doesn't start:

1. Ensure virtual environment is activated: `source venv/bin/activate`
2. Check dependencies are installed: `pip install -r requirements.txt`
3. Verify port 8000 is not in use: `lsof -i :8000`
   #!/bin/bash

# Activate virtual environment and start FastAPI server

cd "$(dirname "$0")"
source venv/bin/activate
echo "Starting Vault Voyager API on http://localhost:8000"
echo "API Documentation available at http://localhost:8000/docs"
uvicorn main:app --reload --host 0.0.0.0 --port 8000

