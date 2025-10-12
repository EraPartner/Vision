# Finance Tracker - Personal Finance Management

A full-stack personal finance tracking application with **multi-bank CSV import** capabilities, transaction management, and spending analytics.

## Architecture

This project uses:
- **Frontend**: React + TypeScript + Vite + Tailwind CSS + shadcn/ui
- **Backend**: Python FastAPI + SQLAlchemy + **Bank-Specific CSV Parsers**
- **Database**: SQLite (default) or PostgreSQL

## 🏦 Multi-Bank Support

Import transactions from **7+ major banks** with automatic format detection:
- ✅ Chase Bank
- ✅ Bank of America
- ✅ Wells Fargo
- ✅ Capital One
- ✅ Citi Bank
- ✅ Discover Card
- ✅ American Express
- ✅ Generic parser for any other bank

Each bank has a dedicated parser that understands its unique CSV format!

## Project Structure

```
/backend          - Python FastAPI backend
  /main.py        - API server with all endpoints
  /models.py      - SQLAlchemy database models
  /schemas.py     - Pydantic schemas for validation
  /auth.py        - JWT authentication
  /bank_parsers.py         - Bank-specific CSV parsers (NEW!)
  /csv_parser_manager.py   - Smart bank detection & routing (NEW!)
  /database.py    - Database connection and configuration
  /sample_csv/    - Sample CSV files for each bank (NEW!)
  /.env           - Environment variables

/src              - React frontend
  /lib/api.ts     - API client for backend communication
  /pages          - Page components
  /components     - Reusable components
    /dashboard/CSVImport.tsx - Multi-bank import UI (UPDATED!)
```

## Setup Instructions

### Backend Setup

1. Navigate to the backend directory:
```bash
cd backend
```

2. Create a virtual environment:
```bash
python3 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. Install dependencies:
```bash
pip install -r requirements.txt
```

4. Configure environment variables:
```bash
# Edit backend/.env if needed
# Default uses SQLite - no additional setup required
```

5. Start the backend server:
```bash
python main.py
```

The API will be available at http://localhost:8000
API documentation: http://localhost:8000/docs

### Frontend Setup

1. From the project root, install dependencies:
```bash
npm install
```

2. Configure environment variables:
```bash
# Edit .env if needed
# VITE_API_URL should point to your backend (default: http://localhost:8000)
```

3. Start the development server:
```bash
npm run dev
```

The frontend will be available at http://localhost:5173

## Features

- **User Authentication**: Secure JWT-based authentication
- **Transaction Management**: View, add, edit, and delete transactions
- **Multi-Bank CSV Import**: Import from 7+ banks with automatic format detection 🆕
- **Bank-Specific Parsers**: Dedicated parser for each bank's unique format 🆕
- **Smart Bank Detection**: Automatically identifies your bank from CSV structure 🆕
- **Auto-Categorization**: Smart categorization of transactions based on merchant names
- **Duplicate Prevention**: Automatically skips duplicate transactions
- **Spending Analytics**: Visual charts and statistics of your spending habits
- **Multi-Account Support**: Import from different banks into one dashboard

## 🚀 Quick Start with Sample Data

Test the multi-bank import with provided sample files:

```bash
# Sample CSV files in backend/sample_csv/
- chase_sample.csv
- bank_of_america_sample.csv
- capital_one_sample.csv
- discover_sample.csv
- amex_sample.csv
- citi_sample.csv
```

1. Login to the app
2. Go to Dashboard
3. Select "Import Transactions"
4. Choose a bank from dropdown
5. Upload one of the sample CSV files
6. Watch your transactions populate! ✨

## CSV Import Format

The application **automatically detects** CSV formats from various banks. Each bank has its own parser:

### Chase Format
```csv
Transaction Date,Post Date,Description,Category,Type,Amount,Memo
10/01/2025,10/02/2025,WHOLE FOODS,Groceries,Sale,-45.32,
```

### Bank of America Format
```csv
Date,Description,Amount,Running Bal.
10/01/2025,TRADER JOES,-52.18,2500.00
```

### Capital One Format
```csv
Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
10/01/2025,10/02/2025,1234,SAFEWAY,Merchandise,43.76,
```

**Don't see your bank?** No problem! The generic parser handles most standard CSV formats.

📖 **Full Details**: See [MULTI_BANK_IMPORT.md](MULTI_BANK_IMPORT.md) and [BANK_IMPORT_QUICK_REF.md](BANK_IMPORT_QUICK_REF.md)

## Database Options

### SQLite (Default)
No additional setup required. Database file (`finance.db`) is created automatically.

### PostgreSQL
1. Create a PostgreSQL database
2. Update `backend/.env`:
```
DATABASE_URL=postgresql://user:password@localhost/finance_db
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login and get JWT token
- `GET /api/auth/me` - Get current user info

### Transactions
- `GET /api/transactions` - Get all transactions
- `POST /api/transactions` - Create new transaction
- `PUT /api/transactions/{id}` - Update transaction
- `DELETE /api/transactions/{id}` - Delete transaction

### CSV Import (NEW!)
- `POST /api/import-csv` - Import transactions from CSV (bank-specific parsing)
- `GET /api/supported-banks` - Get list of supported banks

## Development

### Running Both Servers

Terminal 1 (Backend):
```bash
cd backend
source venv/bin/activate
python main.py
```

Terminal 2 (Frontend):
```bash
npm run dev
```

### Quick Start Script
```bash
./start.sh
```

## Building for Production

Frontend:
```bash
npm run build
```

Backend:
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

## 📚 Documentation

- **[QUICKSTART.md](QUICKSTART.md)** - Get started in 5 minutes
- **[MULTI_BANK_IMPORT.md](MULTI_BANK_IMPORT.md)** - Complete multi-bank import guide
- **[BANK_IMPORT_QUICK_REF.md](BANK_IMPORT_QUICK_REF.md)** - Quick reference card
- **[MIGRATION.md](MIGRATION.md)** - Migration from Supabase to Python backend

## Adding Your Own Bank

Want to add support for your bank? It's easy!

1. Create a parser class in `backend/bank_parsers.py`
2. Register it in `backend/csv_parser_manager.py`
3. Add detection logic (optional)
4. Test with your bank's CSV

See [MULTI_BANK_IMPORT.md](MULTI_BANK_IMPORT.md) for detailed instructions.

## Project info

**URL**: https://lovable.dev/projects/411315a2-2e01-4fef-93ea-e7d6cdab8261