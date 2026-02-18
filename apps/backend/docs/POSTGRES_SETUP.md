# Quick Start: Local PostgreSQL Setup

Follow these steps to set up PostgreSQL in your backend directory (like SQLite, but with full PostgreSQL features).

## Prerequisites

✅ PostgreSQL installed via Homebrew
✅ You're in the backend directory

## Step-by-Step Setup

### Step 1: Run the Setup Script

```bash
cd "/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend"
./utils/setup_local_postgres.sh
```

**What this does:**

- Creates `postgres_data/` directory in your backend folder
- Initializes PostgreSQL database cluster
- Configures PostgreSQL to use port 5433 (to avoid conflicts)
- Starts the local PostgreSQL server
- Creates the `financial_transactions` database
- Creates the `ftm_user` database user

**You'll be prompted to:**

- Choose authentication method:
    - **Option 1 (Recommended): Passwordless (trust)** - No password needed, just like SQLite! 🎉
    - **Option 2: Password** - Require password for connections
- If you choose password authentication, you'll enter and confirm a password

**Expected output:**

```
╔════════════════════════════════════════════════════════════════╗
║   Local PostgreSQL Setup for Financial Transaction Manager    ║
╚════════════════════════════════════════════════════════════════╝

[1/6] Checking PostgreSQL installation...
✓ PostgreSQL 15.x is installed

[2/6] Checking local PostgreSQL data directory...
✓ Created data directory at: /Users/computer/.../postgres_data

[3/6] Initializing PostgreSQL database cluster...
✓ Database cluster initialized

[4/6] Configuring PostgreSQL...
✓ Configuration updated

[5/6] Starting local PostgreSQL server...
✓ PostgreSQL server started successfully

[6/6] Database user configuration...
[Enter your password]

✓ Database connection successful!

╔════════════════════════════════════════════════════════════════╗
║                     Setup Completed Successfully!              ║
╚════════════════════════════════════════════════════════════════╝

Database Configuration:
  Database Name: financial_transactions
  Database User: ftm_user
  Host:          localhost
  Port:          5433 (custom port to avoid conflicts)
  Data Directory: /Users/computer/.../postgres_data

Connection String:
  postgresql://ftm_user:your_password@localhost:5433/financial_transactions
```

### Step 2: Install Python PostgreSQL Driver

```bash
pip install psycopg2-binary
```

**Note:** If you get an import error about `RequirementInformation`, upgrade pip first:

```bash
pip install --upgrade pip
pip install psycopg2-binary
```

### Step 3: Configure Environment Variables

Create or update `config/.env.local` with these values:

**If you chose passwordless authentication (Option 1):**

```env
# Source database (existing SQLite)
SOURCE_DATABASE_URL="sqlite:///Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db"

# Target database (new local PostgreSQL - NO PASSWORD!)
TARGET_DATABASE_URL="postgresql://ftm_user@localhost:5433/financial_transactions"

# Active database (keep SQLite for now, switch after migration)
DATABASE_URL="sqlite:///Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db"
```

**If you chose password authentication (Option 2):**

```env
# Source database (existing SQLite)
SOURCE_DATABASE_URL="sqlite:///Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db"

# Target database (new local PostgreSQL)
TARGET_DATABASE_URL="postgresql://ftm_user:YOUR_PASSWORD_HERE@localhost:5433/financial_transactions"

# Active database (keep SQLite for now, switch after migration)
DATABASE_URL="sqlite:///Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db"
```

**Note:** If you chose password authentication, replace `YOUR_PASSWORD_HERE` with your actual password!

### Step 4: Verify Setup

Check that your local PostgreSQL server is running:

```bash
./utils/status_postgres.sh
```

**Expected output:**

```
Local PostgreSQL Server Status:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
pg_ctl: server is running (PID: xxxxx)
...

Database Information:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       database        |  size
-----------------------+---------
 financial_transactions | 8012 kB
(1 row)
```

### Step 5: Migrate Data from SQLite to PostgreSQL

Run the migration script:

```bash
python -m utils.migrate_sqlite_to_postgres
```

**This will:**

- Read data from your SQLite database
- Convert and insert it into PostgreSQL
- Validate data integrity
- Show migration summary

### Step 6: Switch to PostgreSQL

After successful migration, update `config/.env.local`:

**If using passwordless authentication:**

```env
DATABASE_URL="postgresql://ftm_user@localhost:5433/financial_transactions"
```

**If using password authentication:**

```env
DATABASE_URL="postgresql://ftm_user:YOUR_PASSWORD@localhost:5433/financial_transactions"
```

### Step 7: Test Your Application

Start your application to verify it works with PostgreSQL:

```bash
python main.py
```

Visit `http://localhost:8000/docs` to test the API.

## Daily Usage

### Starting Your Work Session

```bash
# Start PostgreSQL server
./utils/start_postgres.sh

# Start your application
python main.py
```

### Ending Your Work Session

```bash
# Stop your application (Ctrl+C)

# Stop PostgreSQL server (optional, but saves resources)
./utils/stop_postgres.sh
```

### Checking Server Status

```bash
./utils/status_postgres.sh
```

## Troubleshooting

### Problem: "psql: command not found"

**Solution:** Add PostgreSQL to your PATH:

```bash
echo 'export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Problem: "Port 5433 already in use"

**Solution:** Stop any existing server:

```bash
./utils/stop_postgres.sh
```

Or check what's using the port:

```bash
lsof -i :5433
```

### Problem: "Cannot connect to database"

**Solution:** Verify server is running:

```bash
./utils/status_postgres.sh
./utils/start_postgres.sh
```

### Problem: Need to reset everything

**Solution:** Complete reset (deletes all data):

```bash
./utils/stop_postgres.sh
rm -rf postgres_data
./utils/setup_local_postgres.sh
```

## Where Are My Database Files?

Your PostgreSQL database is stored at:

```
/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/postgres_data/
```

This directory contains:

- `base/` - Actual database files
- `log/` - PostgreSQL logs
- `postgresql.conf` - Configuration
- Other PostgreSQL system files

**Just like SQLite**, your database is now stored alongside your code!

## Backup Your Database

### Quick Backup

```bash
pg_dump -h localhost -p 5433 -U ftm_user -d financial_transactions > backup_$(date +%Y%m%d).sql
```

### Restore from Backup

```bash
psql -h localhost -p 5433 -U ftm_user -d financial_transactions < backup_20260218.sql
```

## Next Steps

✅ Local PostgreSQL is running in your backend directory
✅ Database files are stored at `postgres_data/`
✅ Server uses port 5433 (no conflicts with system PostgreSQL)
✅ You can start/stop the server with simple scripts

**You now have a local PostgreSQL database that works just like SQLite, but with full PostgreSQL power!** 🎉

## Quick Command Reference

```bash
# Setup (one-time)
./utils/setup_local_postgres.sh

# Daily use
./utils/start_postgres.sh                # Start server
./utils/stop_postgres.sh                 # Stop server
./utils/status_postgres.sh               # Check status

# Migration
python -m utils.migrate_sqlite_to_postgres

# Connect directly
psql -h localhost -p 5433 -d financial_transactions -U ftm_user

# Backup
pg_dump -h localhost -p 5433 -U ftm_user -d financial_transactions > backup.sql
```

## Need More Details?

See `docs/local-postgresql-setup.md` for comprehensive documentation.



