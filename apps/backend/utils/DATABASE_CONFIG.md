# Merge Recipients Script - Configuration

## Hardcoded Database URL

The `merge_recipients.py` script now uses a **hardcoded database URL** instead of reading from the environment
configuration:

```python
HARDCODED_DATABASE_URL = "sqlite:///financial_transactions.db"
```

This means the script will **always** connect to `financial_transactions.db` in the current working directory,
regardless of any `DATABASE_URL` environment variable or configuration file settings.

## Location

The database file is expected to be at:

```
/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db
```

(Or wherever you run the script from, as it uses a relative path)

## How It Works

1. The script creates its own SQLAlchemy engine and session using the hardcoded URL
2. It does **not** use the `database.connection` module's engine/session
3. This ensures it always connects to the correct database file

## Verification

When you run the script, it will display:

```
================================================================================
RECIPIENT MERGE UTILITY - STARTING
================================================================================
Database: sqlite:///financial_transactions.db
================================================================================

Database engine: sqlite:///financial_transactions.db
Database file size: X,XXX,XXX bytes (X.XX MB)
Total recipients in database: XXX (active: XXX)
```

This confirms which database file is being used.

## Usage

Run from the backend directory:

```bash
cd /Users/computer/Documents/Personal/Scripts/Projects/Vault\ Voyager/apps/backend
python -m utils.merge_recipients --dry-run
```

The script will use `financial_transactions.db` in that directory.

