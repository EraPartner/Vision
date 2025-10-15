# Setup and Running Guide

## Summary of Changes

### Authentication Removed
- ✅ Removed all authentication logic from frontend and backend
- ✅ Removed Supabase integration completely
- ✅ App now loads directly to Dashboard without login

### Backend API Configuration
- ✅ Added CORS middleware to allow frontend connections
- ✅ Created frontend-compatible API endpoints with `/api` prefix
- ✅ Mapped backend database schema to frontend expectations

## Architecture

**Frontend**: React + TypeScript + Vite (Port 8080)  
**Backend**: FastAPI + SQLAlchemy + SQLite (Port 8000)  
**Database**: SQLite (`apps/backend/financial_transactions.db`)

## Starting the Application

### Option 1: Using start.sh (Recommended)
```bash
./start.sh
```

This will:
1. Check for compatible Python version (3.10-3.13)
2. Create virtual environment if needed
3. Install Python dependencies
4. Start FastAPI backend on http://localhost:8000
5. Start frontend on http://localhost:8080

### Option 2: Manual Start

**Backend:**
```bash
cd apps/backend

# Create virtual environment (first time only)
python3 -m venv venv

# Activate virtual environment
source venv/bin/activate  # bash/zsh
# OR
source venv/bin/activate.fish  # fish shell

# Install dependencies (first time only)
pip install -r requirements.txt

# Start the backend
python main.py
```

**Frontend (in a new terminal):**
```bash
npm run dev
```

## API Endpoints

### Frontend Endpoints (with /api prefix)
- `GET /api/transactions` - Get all transactions
- `POST /api/transactions` - Create new transaction
- `PUT /api/transactions/{id}` - Update transaction
- `DELETE /api/transactions/{id}` - Delete transaction
- `POST /api/import-csv` - Import CSV content
- `GET /api/supported-banks` - Get supported bank list

### Backend/CLI Endpoints (no /api prefix)
- `GET /transactions` - Get transactions with filters
- `POST /import/csv` - Import CSV file (multipart)
- `GET /supported-banks` - Get supported banks

## Data Structure Mapping

**Frontend expects:**
```typescript
{
  id: number
  transaction_date: string  // ISO format
  description: string       // recipient name
  amount: number
  category: string          // category name
  bank_source: string       // bank account
}
```

**Backend database has:**
- `date` (Date field)
- `recipient` (foreign key to Recipients table)
- `category_id` (foreign key to Categories table)
- `bank_account` (string)
- `amount` (Numeric)

The API layer handles the mapping between these two formats.

## CLI Usage

You can still use the CLI for importing:
```bash
cd apps/backend
source venv/bin/activate
python cli.py import --file path/to/file.csv --bank revolut
```

## Troubleshooting

### Backend won't start
1. Check Python version: `python3 --version` (should be 3.10-3.13)
2. Check virtual environment: `ls apps/backend/venv`
3. Check dependencies: `cd apps/backend && source venv/bin/activate && pip list`
4. Check logs: Look for error messages in terminal

### CORS errors
- Backend must be running on http://localhost:8000
- Frontend must be on http://localhost:8080, :5173, or :3000
- These are configured in `apps/backend/main.py` CORS middleware

### Select component errors
- Fixed: SelectItem components now use proper string values (no empty strings)
- Initial state is set to "auto-detect" instead of empty string

## Next Steps

When you're ready to implement authentication:
1. The Auth page and AuthForm components are still available
2. Update `App.tsx` to add auth routing back
3. Add authentication middleware to FastAPI backend
4. Implement JWT tokens or other auth method
5. Update API client with token management

See `docs/AUTH_REMOVAL.md` for more details.
