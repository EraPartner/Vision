# Test Database Isolation

## Overview

This document explains how test database isolation is implemented to **completely prevent data spillover** between test
and production databases.

## Critical Problem

Without proper isolation, tests can accidentally write data to or delete data from the production database, causing:

- Data corruption
- Data loss
- Test failures that affect production
- Production data contaminating test results

## Solution Architecture

### 1. Separate Test Database

Tests use a completely different database:

- **Production Database**: `financial_transactions`
- **Test Database**: `financial_transactions_test`

Both databases run on the same PostgreSQL instance (port 5433) but are completely separate.

### 2. Environment Variable Override

The test database isolation works through a **three-layer protection mechanism**:

#### Layer 1: Pre-Import Environment Setup (conftest.py)

```python
# In tests/conftest.py - BEFORE ANY IMPORTS
TEST_DATABASE_URL = "postgresql://ftm_user@localhost:5433/financial_transactions_test"
os.environ["DATABASE_URL"] = TEST_DATABASE_URL

# NOW safe to import application modules
from config.config import get_settings
from main import app
```

**Why this matters**: Python imports are cached. If any module reads `DATABASE_URL` at import time, we must set it
BEFORE importing.

#### Layer 2: Config Loading Protection (config/config.py)

```python
# Only load .env.local if not in test mode
existing_db_url = os.getenv("DATABASE_URL", "")
is_test_mode = "test" in existing_db_url.lower()

if is_test_mode:
    # DO NOT load .env.local - preserve test DATABASE_URL
    pass
else:
    # Load .env.local but don't override existing environment variables
    load_dotenv(ENV_LOCAL_PATH, override=False)
```

**Why this matters**: The `.env.local` file contains the production `DATABASE_URL`. Without this check, it would
override the test database URL.

#### Layer 3: Runtime Verification (conftest.py)

Multiple safety checks ensure the correct database is being used:

```python
# Verify environment variable wasn't changed
if os.environ.get("DATABASE_URL") != TEST_DATABASE_URL:
    raise RuntimeError("DATABASE_URL was changed!")

# Verify config is using test database
settings = get_settings()
if "financial_transactions_test" not in settings.database.url:
    raise RuntimeError("Config not using test database!")
```

### 3. Database Lifecycle Management

Each test session:

1. **Setup** (once per session):
    - Creates `financial_transactions_test` database
    - Grants permissions to `ftm_user`
    - Creates all tables

2. **Per Test** (once per test function):
    - Creates a fresh database session
    - Runs the test
    - Rolls back any uncommitted changes
    - Drops all tables (cleanup)

3. **Teardown** (once per session):
    - Drops `financial_transactions_test` database

## Verification

### Automated Verification

Run the verification script to confirm isolation:

```bash
python3 verify_test_isolation.py
```

Expected output:

```
✓ DATABASE ISOLATION VERIFICATION PASSED

Conclusion:
  • Production database will NOT be affected by tests
  • Tests use a separate 'financial_transactions_test' database
  • Environment variable override mechanism is working correctly
  • conftest.py properly sets DATABASE_URL before any imports

✓ No data spillover between test and production databases!
```

### Manual Verification

Check which database is being used during tests:

```bash
# Run tests with verbose output
pytest tests/test_main.py::test_health_check -v -s

# Check the output for "Test database isolation verified"
```

## Common Issues

### Issue 1: Config Cache Not Cleared

**Symptom**: Tests use production database even with environment variable set

**Cause**: `get_settings()` uses `@lru_cache`, so it caches the first call

**Solution**: The config module now detects test mode and skips loading `.env.local`

### Issue 2: .env.local Override

**Symptom**: `DATABASE_URL` environment variable is overridden by `.env.local`

**Cause**: `load_dotenv(override=True)` replaces environment variables

**Solution**: Changed to `load_dotenv(override=False)` and skip loading in test mode

### Issue 3: Import Order

**Symptom**: Some modules use production database, others use test database

**Cause**: Environment variable set after some modules are imported

**Solution**: Set `DATABASE_URL` BEFORE importing any application modules in `conftest.py`

## Best Practices

1. **Never manually set DATABASE_URL in test files**
    - Always rely on `conftest.py` to set it

2. **Always use the `test_db` fixture**
   ```python
   def test_something(test_db):
       # test_db is automatically connected to test database
       result = test_db.query(Model).all()
   ```

3. **Use the `client` fixture for API tests**
   ```python
   def test_api_endpoint(client):
       # client automatically uses test database
       response = client.get("/api/endpoint")
   ```

4. **Run verification before committing**
   ```bash
   python3 verify_test_isolation.py
   ```

## Security Implications

Proper test database isolation is critical for:

- **Data Integrity**: Production data is never modified by tests
- **Compliance**: Test data doesn't mix with real financial data
- **Privacy**: Test users don't see production data
- **Reliability**: Tests are reproducible and don't depend on production data state

## Troubleshooting

### Check Current Database Connection

```python
from config.config import get_settings

settings = get_settings()
print(f"Current database: {settings.database.url}")
```

### Verify PostgreSQL Databases

```bash
psql -U ftm_user -h localhost -p 5433 -d postgres -c "\l"
```

Should show both databases:

- `financial_transactions` (production)
- `financial_transactions_test` (tests only)

### Check Active Connections

```bash
psql -U ftm_user -h localhost -p 5433 -d postgres -c "SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname;"
```

## Summary

✓ **Complete Separation**: Test and production databases are completely separate

✓ **No Data Spillover**: Tests cannot access or modify production data

✓ **Automatic Verification**: Multiple safety checks ensure correct database is used

✓ **Clean State**: Each test starts with a clean database state

✓ **Fail-Safe**: Tests fail immediately if wrong database is detected

