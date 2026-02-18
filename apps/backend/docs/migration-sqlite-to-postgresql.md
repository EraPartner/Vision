# SQLite to PostgreSQL Migration Guide

## Overview

This guide provides step-by-step instructions for migrating your Financial Transaction Manager from SQLite to PostgreSQL
while preserving all data, relationships, and integrity.

## Prerequisites

### 1. PostgreSQL Installation

**macOS (using Homebrew):**

```bash
# Install PostgreSQL
brew install postgresql@15

# Start PostgreSQL service
brew services start postgresql@15

# Verify installation
psql --version
```

**Linux (Ubuntu/Debian):**

```bash
# Install PostgreSQL
sudo apt update
sudo apt install postgresql postgresql-contrib

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Verify installation
psql --version
```

**Windows:**

- Download and install from: https://www.postgresql.org/download/windows/
- Use the installer and follow the setup wizard

### 2. Create PostgreSQL Database

```bash
# Connect to PostgreSQL as the default user
psql -U postgres

# Inside psql, create database and user
CREATE DATABASE financial_transactions;
CREATE USER ftm_user WITH PASSWORD 'your_secure_password_here';
GRANT ALL PRIVILEGES ON DATABASE financial_transactions TO ftm_user;

# Grant schema privileges (PostgreSQL 15+)
\c financial_transactions
GRANT ALL ON SCHEMA public TO ftm_user;

# Exit psql
\q
```

**Alternative: Using a single command**

```bash
# Create database
createdb -U postgres financial_transactions

# Create user with password
psql -U postgres -c "CREATE USER ftm_user WITH PASSWORD 'your_secure_password_here';"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE financial_transactions TO ftm_user;"
psql -U postgres -d financial_transactions -c "GRANT ALL ON SCHEMA public TO ftm_user;"
```

### 3. Install Python Dependencies

```bash
# Navigate to backend directory
cd /path/to/backend

# Install updated requirements including PostgreSQL driver
pip install -r config/requirements.txt

# Or install just the PostgreSQL driver
pip install psycopg2-binary>=2.9.9
```

## Migration Steps

### Step 1: Backup Your SQLite Database

**Critical: Always create a backup before migration!**

```bash
# Navigate to backend directory
cd /Users/computer/Documents/Personal/Scripts/Projects/Vault\ Voyager/apps/backend

# Create backup directory if it doesn't exist
mkdir -p Backups

# Copy current database with timestamp
cp financial_transactions.db "Backups/financial_transactions_$(date +%Y%m%d_%H%M%S).db"

# Verify backup
ls -lh Backups/
```

### Step 2: Configure Environment Variables

Create or update your `.env.local` file with both database URLs:

```bash
# Edit the .env.local file
cd config
nano .env.local
```

Add these variables (keep existing SQLite URL for migration):

```env
# Existing SQLite database (source)
SOURCE_DATABASE_URL="sqlite:////Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db"

# New PostgreSQL database (target)
TARGET_DATABASE_URL="postgresql://ftm_user:your_secure_password_here@localhost:5432/financial_transactions"

# Other existing settings
PORT=3002
CORS_ORIGINS=http://localhost:8080
```

**Important Security Note:**

- Replace `your_secure_password_here` with your actual password
- Never commit `.env.local` to version control (should be in .gitignore)

### Step 3: Test PostgreSQL Connection

Before migration, verify PostgreSQL connectivity:

```bash
# Test connection using psql
psql -U ftm_user -d financial_transactions -h localhost

# If successful, you'll see:
# financial_transactions=>

# Test with SQLAlchemy (Python)
python3 -c "
from sqlalchemy import create_engine
engine = create_engine('postgresql://ftm_user:your_password@localhost:5432/financial_transactions')
conn = engine.connect()
print('✓ PostgreSQL connection successful!')
conn.close()
"
```

### Step 4: Run the Migration Script

```bash
# Navigate to backend directory
cd /Users/computer/Documents/Personal/Scripts/Projects/Vault\ Voyager/apps/backend

# Run migration script
python -m utils.migrate_sqlite_to_postgres
```

**Expected Output:**

```
================================================================================
SQLite to PostgreSQL Migration
================================================================================
Source: sqlite:////path/to/financial_transactions.db
Target: postgresql://ftm_user:***@localhost:5432/fin...

WARNING: This will create tables and migrate all data to the target database.
================================================================================

Proceed with migration? (yes/no): yes

[INFO] Connecting to source database...
[INFO] Source database contains 7 tables: transactions, categories, recipients, ...
[INFO] Source database statistics:
[INFO]   - Transactions: 1250
[INFO]   - Categories: 45
[INFO]   - Recipients: 230

[INFO] Creating target database schema...
[INFO] Target schema created successfully

[INFO] Migrating data...
[INFO] Migrating table: categories
[INFO]   ✓ Migrated 45 records from categories
[INFO] Migrating table: recipients
[INFO]   ✓ Migrated 230 records from recipients
[INFO] Migrating table: import_batches
[INFO]   ✓ Migrated 12 records from import_batches
[INFO] Migrating table: transactions
[INFO]   ✓ Migrated 1250 records from transactions
[INFO] Migrating table: planned_transactions
[INFO]   ✓ Migrated 8 records from planned_transactions
[INFO] Migrating table: exchange_rates
[INFO]   ✓ Migrated 150 records from exchange_rates
[INFO] Migrating table: planned_transaction_executions
[INFO]   ✓ Migrated 3 records from planned_transaction_executions

[INFO] ✓ Successfully migrated 1698 total records

[INFO] Resetting PostgreSQL sequences...
[INFO]   ✓ Reset sequence categories_id_seq to 46
[INFO]   ✓ Reset sequence recipients_id_seq to 231
...

[INFO] Verifying migration...
[INFO]   ✓ categories: 45 records (match)
[INFO]   ✓ recipients: 230 records (match)
[INFO]   ✓ import_batches: 12 records (match)
[INFO]   ✓ transactions: 1250 records (match)
[INFO]   ✓ planned_transactions: 8 records (match)
[INFO]   ✓ exchange_rates: 150 records (match)
[INFO]   ✓ planned_transaction_executions: 3 records (match)

================================================================================
✓ Migration completed successfully in 0:00:03.456789
================================================================================
```

### Step 5: Update Application Configuration

Update your `.env.local` to use PostgreSQL as the primary database:

```env
# Use PostgreSQL as primary database
DATABASE_URL="postgresql://ftm_user:your_secure_password_here@localhost:5432/financial_transactions"

# Keep other settings
PORT=3002
CORS_ORIGINS=http://localhost:8080

# Optional: Keep SQLite URL for reference (commented out)
# SOURCE_DATABASE_URL="sqlite:////Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db"
```

### Step 6: Restart and Verify Application

```bash
# Navigate to backend directory
cd /Users/computer/Documents/Personal/Scripts/Projects/Vault\ Voyager/apps/backend

# Start the application
python main.py

# Or if using uvicorn directly
uvicorn main:app --host 0.0.0.0 --port 3002 --reload
```

**Verification Checklist:**

- [ ] Application starts without errors
- [ ] Database connection logs show PostgreSQL
- [ ] Can view all transactions
- [ ] Can create new transactions
- [ ] Can view categories and recipients
- [ ] All existing data is accessible
- [ ] API endpoints respond correctly

### Step 7: Verify Data Integrity

```bash
# Connect to PostgreSQL and run verification queries
psql -U ftm_user -d financial_transactions

# Check record counts
SELECT 
    (SELECT COUNT(*) FROM transactions) as transactions,
    (SELECT COUNT(*) FROM categories) as categories,
    (SELECT COUNT(*) FROM recipients) as recipients,
    (SELECT COUNT(*) FROM planned_transactions) as planned,
    (SELECT COUNT(*) FROM exchange_rates) as exchange_rates;

# Check sample transactions
SELECT id, date, amount, currency 
FROM transactions 
ORDER BY date DESC 
LIMIT 10;

# Check foreign key integrity
SELECT 
    t.id, 
    t.date, 
    t.amount, 
    r.name as recipient, 
    c.general || ':' || c.detail as category
FROM transactions t
JOIN recipients r ON t.recipient_id = r.id
LEFT JOIN categories c ON t.category_id = c.id
LIMIT 10;

# Exit psql
\q
```

## Troubleshooting

### Issue: "psycopg2" module not found

**Solution:**

```bash
pip install psycopg2-binary
```

### Issue: "FATAL: password authentication failed"

**Solution:**

1. Verify password in `.env.local` matches PostgreSQL user
2. Check `pg_hba.conf` authentication method
3. Reset password:

```bash
psql -U postgres
ALTER USER ftm_user WITH PASSWORD 'new_secure_password';
\q
```

### Issue: "could not connect to server"

**Solution:**

1. Verify PostgreSQL is running:

```bash
# macOS
brew services list | grep postgresql

# Linux
sudo systemctl status postgresql
```

2. Start PostgreSQL if stopped:

```bash
# macOS
brew services start postgresql@15

# Linux
sudo systemctl start postgresql
```

### Issue: "permission denied for schema public"

**Solution:**

```bash
psql -U postgres -d financial_transactions
GRANT ALL ON SCHEMA public TO ftm_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ftm_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ftm_user;
\q
```

### Issue: Migration verification fails

**Solution:**

1. Check migration logs for specific errors
2. Verify source database is accessible
3. Check PostgreSQL disk space
4. Re-run migration after fixing issues

### Issue: "relation does not exist" errors

**Solution:**
The schema wasn't created properly. Drop and recreate:

```bash
psql -U postgres
DROP DATABASE financial_transactions;
CREATE DATABASE financial_transactions;
GRANT ALL PRIVILEGES ON DATABASE financial_transactions TO ftm_user;
\c financial_transactions
GRANT ALL ON SCHEMA public TO ftm_user;
\q

# Re-run migration
python -m utils.migrate_sqlite_to_postgres
```

## Performance Tuning (Optional)

### PostgreSQL Configuration

For better performance with your workload, consider these PostgreSQL settings:

```bash
# Edit postgresql.conf (location varies by OS)
# macOS: /opt/homebrew/var/postgresql@15/postgresql.conf
# Linux: /etc/postgresql/15/main/postgresql.conf

# Recommended settings for development/small production
shared_buffers = 256MB
effective_cache_size = 1GB
maintenance_work_mem = 64MB
work_mem = 16MB
max_connections = 100

# Restart PostgreSQL after changes
brew services restart postgresql@15  # macOS
sudo systemctl restart postgresql    # Linux
```

### Connection Pooling

Your application already supports connection pooling. Adjust in `.env.local`:

```env
# PostgreSQL connection pool settings
DB_POOL_SIZE=5
DB_MAX_OVERFLOW=10
DB_ECHO=False
```

## Rollback Plan

If you need to rollback to SQLite:

```bash
# 1. Stop the application
# Ctrl+C or kill the process

# 2. Update .env.local to use SQLite
DATABASE_URL="sqlite:////Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db"

# 3. Restore from backup if needed
cp Backups/financial_transactions_YYYYMMDD_HHMMSS.db financial_transactions.db

# 4. Restart application
python main.py
```

## Production Deployment Considerations

### Security

- Use strong passwords for PostgreSQL users
- Enable SSL/TLS for PostgreSQL connections in production
- Store credentials in environment variables or secrets manager
- Restrict PostgreSQL network access (pg_hba.conf)
- Regular security updates for PostgreSQL

### Backups

```bash
# Automated PostgreSQL backup script
pg_dump -U ftm_user -d financial_transactions -F c -b -v -f "backup_$(date +%Y%m%d_%H%M%S).dump"

# Restore from backup
pg_restore -U ftm_user -d financial_transactions -v backup_file.dump
```

### Monitoring

- Set up PostgreSQL monitoring (pg_stat_statements extension)
- Monitor connection pool usage
- Track query performance
- Set up alerts for connection exhaustion

### High Availability

- Consider PostgreSQL replication for production
- Use managed PostgreSQL services (AWS RDS, Google Cloud SQL, Azure Database)
- Implement regular backup automation
- Test disaster recovery procedures

## Next Steps

After successful migration:

1. **Monitor Performance**: Watch application logs and PostgreSQL logs for any issues
2. **Run Tests**: Execute your test suite to ensure compatibility
3. **Update Documentation**: Document your PostgreSQL connection details
4. **Archive SQLite**: Keep SQLite backup for a few weeks before archiving
5. **Team Communication**: Inform team members of the database change

## Additional Resources

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [SQLAlchemy PostgreSQL Dialect](https://docs.sqlalchemy.org/en/20/dialects/postgresql.html)
- [psycopg2 Documentation](https://www.psycopg.org/docs/)
- [PostgreSQL Performance Tuning](https://wiki.postgresql.org/wiki/Performance_Optimization)

## Support

If you encounter issues not covered in this guide:

1. Check application logs in the backend directory
2. Review PostgreSQL logs (usually in `/var/log/postgresql/`)
3. Verify all environment variables are set correctly
4. Ensure PostgreSQL service is running and accessible

