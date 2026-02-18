# PostgreSQL Setup Script Fix

## Issue

The `setup_postgres.sh` script failed on macOS with the error:

```
psql: error: connection to server at "localhost" (::1), port 5432 failed: 
FATAL: role "postgres" does not exist
```

## Root Cause

PostgreSQL installed via Homebrew on macOS does **not** create a default `postgres` superuser. Instead, it creates a
superuser with the same name as the current macOS user account.

The original script hardcoded `-U postgres` when connecting to PostgreSQL, which works on Linux but fails on macOS
Homebrew installations.

## Solution

Added automatic PostgreSQL superuser detection to the script:

### Changes Made

1. **Added `PG_SUPERUSER` variable** to store the detected superuser name

2. **Added `detect_pg_superuser()` function** that:
    - On macOS: Uses the current macOS username (`whoami`)
    - On Linux: Uses the traditional `postgres` user
    - Verifies the connection before proceeding
    - Falls back to trying `postgres` if the first attempt fails

3. **Updated all `psql` commands** to use `$PG_SUPERUSER` instead of hardcoded `postgres`

4. **Updated step numbering** from [1/6] through [6/6] to [1/6] through [7/7] to accommodate the new detection step

### Technical Details

#### macOS Homebrew Behaviour

When PostgreSQL is installed via Homebrew on macOS:

```bash
brew install postgresql@15
```

The installation:

- Creates a superuser with your macOS username
- Does NOT create a `postgres` user by default
- Uses peer authentication for local connections

#### Connecting to PostgreSQL on macOS

```bash
# Correct (uses current user)
psql postgres
psql -U $(whoami) postgres

# Incorrect (will fail unless you manually create the postgres role)
psql -U postgres postgres
```

#### Creating the postgres Role (Optional)

If you need the `postgres` role for compatibility:

```bash
psql postgres -c "CREATE ROLE postgres WITH SUPERUSER LOGIN;"
```

## Usage

The script now automatically detects the correct superuser and proceeds without errors:

```bash
./utils/setup_postgres.sh
```

The script will:

1. Check PostgreSQL installation
2. Check PostgreSQL service status
3. **Detect the correct superuser** (NEW)
4. Prompt for the database user password
5. Create the database and user
6. Set up schema permissions
7. Test the connection

## Benefits

- ✅ Works on macOS (Homebrew PostgreSQL)
- ✅ Works on Linux (standard PostgreSQL installations)
- ✅ Automatic detection eliminates manual configuration
- ✅ Clear error messages if detection fails
- ✅ Falls back gracefully if the first detection method fails

## Testing

Tested on:

- macOS with Homebrew PostgreSQL 15.x
- Current user as superuser

## Related Documentation

- See `docs/migration-sqlite-to-postgresql.md` for the full migration guide
- PostgreSQL documentation: https://www.postgresql.org/docs/current/auth-peer.html

