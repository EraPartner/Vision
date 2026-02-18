# Database Utilities

This directory contains scripts and utilities for database management and migration.

## PostgreSQL Setup Scripts

### Local PostgreSQL (Recommended for Development)

**`setup_local_postgres.sh`** - One-time setup for local PostgreSQL

- Creates a PostgreSQL instance in `postgres_data/`
- Database files stored alongside your code (like SQLite)
- Uses port 5433 to avoid conflicts
- Self-contained and portable

```bash
./utils/setup_local_postgres.sh
```

**Helper Scripts:**

- `start_postgres.sh` - Start the local PostgreSQL server
- `stop_postgres.sh` - Stop the local PostgreSQL server
- `status_postgres.sh` - Check server status and database info

**Documentation:** See `docs/local-postgresql-setup.md`

### System PostgreSQL (Alternative)

**`setup_postgres.sh`** - Setup using system-wide PostgreSQL

- Uses the system PostgreSQL installation
- Database stored in `/opt/homebrew/var/postgresql@18/`
- Uses standard port 5432
- Suitable for production-like development

```bash
./utils/setup_postgres.sh
```

**Documentation:** See `docs/migration-sqlite-to-postgresql.md`

## Migration Scripts

**`migrate_sqlite_to_postgres.py`** - Migrate data from SQLite to PostgreSQL

- Preserves all data and relationships
- Handles schema conversion
- Validates data integrity

```bash
# After setting up PostgreSQL and configuring .env.local
python -m utils.migrate_sqlite_to_postgres
```

## Bank Import Adapters

**`bank_adapters.py`** - Import transaction data from bank CSV files

- Supports multiple bank formats
- Automatic transaction parsing
- Category mapping

## Quick Reference

### Initial Setup (Choose One)

**Option A: Local PostgreSQL (Recommended)**

```bash
./utils/setup_local_postgres.sh
./utils/start_postgres.sh
```

**Option B: System PostgreSQL**

```bash
./utils/setup_postgres.sh
```

### Daily Workflow (Local PostgreSQL)

**Start working:**

```bash
./utils/start_postgres.sh
python main.py
```

**Stop working:**

```bash
./utils/stop_postgres.sh
```

**Check status:**

```bash
./utils/status_postgres.sh
```

### Migration Workflow

1. Set up PostgreSQL (local or system)
2. Configure `.env.local` with SOURCE and TARGET database URLs
3. Run migration: `python -m utils.migrate_sqlite_to_postgres`
4. Update `DATABASE_URL` in `.env.local` to use PostgreSQL
5. Restart application

## File Overview

```
utils/
├── setup_local_postgres.sh       # Setup local PostgreSQL instance
├── setup_postgres.sh             # Setup system PostgreSQL
├── start_postgres.sh             # Start local PostgreSQL
├── stop_postgres.sh              # Stop local PostgreSQL
├── status_postgres.sh            # Check PostgreSQL status
├── migrate_sqlite_to_postgres.py # Data migration script
├── bank_adapters.py              # Bank CSV importers
└── README.md                     # This file
```

## Configuration Files

All scripts read configuration from `config/.env.local`:

```env
# SQLite (source database)
SOURCE_DATABASE_URL="sqlite:///path/to/financial_transactions.db"

# PostgreSQL (target database)
# Local PostgreSQL (port 5433)
TARGET_DATABASE_URL="postgresql://ftm_user:password@localhost:5433/financial_transactions"

# Or System PostgreSQL (port 5432)
# TARGET_DATABASE_URL="postgresql://ftm_user:password@localhost:5432/financial_transactions"

# Active database (switch after migration)
DATABASE_URL="postgresql://ftm_user:password@localhost:5433/financial_transactions"
```

## Support

For detailed documentation:

- **Local PostgreSQL**: `docs/local-postgresql-setup.md`
- **System PostgreSQL**: `docs/migration-sqlite-to-postgresql.md`
- **Migration Guide**: `docs/migration-sqlite-to-postgresql.md`

For issues or questions, check the troubleshooting sections in the documentation.

