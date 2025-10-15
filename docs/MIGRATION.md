# Migration Summary: SQLite Backend Architecture

## Current Architecture

**Backend**: Python FastAPI + SQLAlchemy + SQLite  
**Frontend**: React + TypeScript + Vite

### Benefits
1. **Full Control**: Own your data and backend logic
2. **No Vendor Lock-in**: Standard SQL database (SQLite)
3. **Easier Debugging**: Direct access to backend code
4. **Cost**: No external service fees
5. **Flexibility**: Easy to extend and customize
6. **Simplicity**: Single file database, easy to backup and manage

## Backend Structure

### Core Files
- `apps/backend/main.py` - FastAPI server with all endpoints
- `apps/backend/database/models.py` - SQLAlchemy database models
- `apps/backend/database/connection.py` - Database configuration
- `apps/backend/services/bank_adapters.py` - Bank CSV format adapters
- `apps/backend/services/transaction_service.py` - Transaction business logic
- `apps/backend/cli.py` - Command-line interface for imports
- `apps/backend/requirements.txt` - Python dependencies
- `apps/backend/financial_transactions.db` - SQLite database file

### Frontend Integration
- `apps/frontend/src/lib/api.ts` - API client for backend communication
- Direct REST API calls to Python backend
- No external dependencies for data management

### Database Schema
- Transactions table (date, description, amount, category, bank_source)
- Recipients table (for transaction counterparties)
- Bank account tracking
- Automatic duplicate detection

## CSV Import

- Direct Python function with pandas
- Multi-bank support (Belfius, KBC, Revolut, Chase, etc.)
- Configurable adapters for any CSV format
- Runs locally with your backend
- Auto-categorization capabilities

## Authentication Status

**Currently**: No authentication (removed for simplicity)  
**Future**: Can implement custom JWT auth when needed
- Will use Python backend for auth
- No Supabase required
- Complete control over auth flow

## Running the Application

```bash
./start.sh  # Starts both backend and frontend
```

Or separately:
```bash
# Backend
cd apps/backend && python main.py

# Frontend
npm run dev
```