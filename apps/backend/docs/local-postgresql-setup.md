# Local PostgreSQL Setup Guide

This guide explains how to run PostgreSQL locally within your backend project directory, similar to how SQLite stores
its database file.

## Overview

Instead of using the system-wide PostgreSQL installation, you can run a **local PostgreSQL instance** that stores all
its data in your backend project folder at `postgres_data/`.

### Benefits

- ✅ **Self-contained**: All database files in your project directory
- ✅ **Portable**: Easy to backup and move with your project
- ✅ **Isolated**: No conflicts with system PostgreSQL
- ✅ **Development-friendly**: Easy to reset and reinitialize
- ✅ **Similar to SQLite**: Database files stay with your code
- ✅ **Passwordless option**: Just like SQLite - no password required! 🎉

### Comparison

| Feature        | SQLite                      | Local PostgreSQL           | System PostgreSQL                  |
|----------------|-----------------------------|----------------------------|------------------------------------|
| Location       | `financial_transactions.db` | `postgres_data/`           | `/opt/homebrew/var/postgresql@18/` |
| Port           | N/A                         | 5433 (custom)              | 5432 (default)                     |
| Server         | No                          | Yes (local)                | Yes (system-wide)                  |
| Authentication | None                        | **Passwordless (default)** | Password required                  |
| Scalability    | Limited                     | Full                       | Full                               |
| Backup         | Copy file                   | Copy directory or pg_dump  | pg_dump                            |

## Quick Start

### 1. Initial Setup

Run the local PostgreSQL setup script:

```bash
cd /Users/computer/Documents/Personal/Scripts/Projects/Vault\ Voyager/apps/backend
./utils/setup_local_postgres.sh
```

This will:

1. ✓ Check PostgreSQL is installed
2. ✓ Create `postgres_data/` directory
3. ✓ Initialize PostgreSQL database cluster
4. ✓ Configure to use port 5433 (non-default)
5. ✓ Start the local PostgreSQL server
6. ✓ Create database and user

### 2. Daily Usage

**Start the server:**

```bash
./utils/start_postgres.sh
```

**Stop the server:**

```bash
./utils/stop_postgres.sh
```

**Check status:**

```bash
./utils/status_postgres.sh
```

### 3. Connect to Database

Using psql:

```bash
psql -h localhost -p 5433 -d financial_transactions -U ftm_user
```

Using Python (add to `.env.local`):

```env
DATABASE_URL="postgresql://ftm_user:your_password@localhost:5433/financial_transactions"
```

## Directory Structure

After setup, your backend directory will contain:

```
backend/
├── financial_transactions.db     # Old SQLite database
├── postgres_data/                 # New PostgreSQL data directory
│   ├── base/                      # Database files
│   ├── global/                    # Cluster-wide data
│   ├── pg_wal/                    # Write-ahead logs
│   ├── log/                       # PostgreSQL logs
│   ├── postgresql.conf            # Configuration
│   ├── pg_hba.conf               # Authentication config
│   └── postmaster.pid            # Server process ID (when running)
├── utils/
│   ├── setup_local_postgres.sh   # One-time setup
│   ├── start_postgres.sh         # Start server
│   ├── stop_postgres.sh          # Stop server
│   └── status_postgres.sh        # Check status
└── ...
```

## Configuration Details

### Custom Port: 5433

The local PostgreSQL server uses **port 5433** (not the default 5432) to avoid conflicts with any system-wide PostgreSQL
installation. This allows both to run simultaneously if needed.

### Authentication

- **Superuser**: Your macOS username (e.g., `computer`)
- **Application user**: `ftm_user` (with password you set during setup)
- **Database**: `financial_transactions`

### Connection Methods

**For administration (as superuser):**

```bash
psql -h localhost -p 5433 -d postgres -U computer
```

**For application (as ftm_user):**

```bash
PGPASSWORD=your_password psql -h localhost -p 5433 -d financial_transactions -U ftm_user
```

**Connection URL format:**

```
postgresql://ftm_user:your_password@localhost:5433/financial_transactions
```

## Migration from SQLite

Once the local PostgreSQL server is running:

1. **Update `.env.local`:**
   ```env
   # Source database (existing SQLite)
   SOURCE_DATABASE_URL="sqlite:///Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db"
   
   # Target database (new local PostgreSQL)
   TARGET_DATABASE_URL="postgresql://ftm_user:your_password@localhost:5433/financial_transactions"
   ```

2. **Run migration:**
   ```bash
   python -m utils.migrate_sqlite_to_postgres
   ```

3. **Switch to PostgreSQL:**
   Update `DATABASE_URL` in `.env.local`:
   ```env
   DATABASE_URL="postgresql://ftm_user:your_password@localhost:5433/financial_transactions"
   ```

4. **Restart your application:**
   ```bash
   python main.py
   ```

## Server Management

### Starting on Boot (Optional)

If you want the local PostgreSQL server to start automatically when you log in:

**Create LaunchAgent:**

```bash
cat > ~/Library/LaunchAgents/local.postgresql.vault-voyager.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>local.postgresql.vault-voyager</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/postgres</string>
        <string>-D</string>
        <string>/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/postgres_data</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/postgres_data/postgres.log</string>
    <key>StandardOutPath</key>
    <string>/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/postgres_data/postgres.log</string>
</dict>
</plist>
EOF

# Load it
launchctl load ~/Library/LaunchAgents/local.postgresql.vault-voyager.plist
```

**Remove auto-start:**

```bash
launchctl unload ~/Library/LaunchAgents/local.postgresql.vault-voyager.plist
rm ~/Library/LaunchAgents/local.postgresql.vault-voyager.plist
```

### Manual Control

**Start:**

```bash
pg_ctl -D "/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/postgres_data" start
```

**Stop:**

```bash
pg_ctl -D "/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/postgres_data" stop
```

**Status:**

```bash
pg_ctl -D "/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/postgres_data" status
```

**Restart:**

```bash
pg_ctl -D "/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/postgres_data" restart
```

## Backup and Restore

### Full Backup (All Databases)

**Using pg_dumpall:**

```bash
pg_dumpall -h localhost -p 5433 -U computer > backup_$(date +%Y%m%d).sql
```

**Using directory copy (server must be stopped):**

```bash
./utils/stop_postgres.sh
cp -r postgres_data postgres_data_backup_$(date +%Y%m%d)
./utils/start_postgres.sh
```

### Database-Specific Backup

**Backup financial_transactions database:**

```bash
pg_dump -h localhost -p 5433 -U ftm_user -d financial_transactions > financial_transactions_backup_$(date +%Y%m%d).sql
```

**Restore from backup:**

```bash
psql -h localhost -p 5433 -U ftm_user -d financial_transactions < financial_transactions_backup_20260218.sql
```

### Automated Backup Script

Create a backup script at `utils/backup_postgres.sh`:

```bash
#!/bin/zsh
BACKEND_DIR="/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend"
BACKUP_DIR="$BACKEND_DIR/Backups/postgres"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/financial_transactions_$TIMESTAMP.sql"

pg_dump -h localhost -p 5433 -U ftm_user -d financial_transactions > "$BACKUP_FILE"

echo "✓ Backup saved to: $BACKUP_FILE"
echo "  Size: $(du -h "$BACKUP_FILE" | cut -f1)"

# Keep only last 10 backups
ls -t "$BACKUP_DIR"/*.sql | tail -n +11 | xargs rm -f
```

## Troubleshooting

### Server Won't Start

**Check logs:**

```bash
tail -f postgres_data/log/postgresql-*.log
```

**Common issues:**

- Port 5433 already in use → Change port in `postgresql.conf`
- Permission issues → `chmod 700 postgres_data`
- Corrupted data → Reinitialize with `./utils/setup_local_postgres.sh`

### Connection Refused

**Verify server is running:**

```bash
./utils/status_postgres.sh
```

**Check port:**

```bash
lsof -i :5433
```

**Test connection:**

```bash
pg_isready -h localhost -p 5433
```

### Reset Database

**To completely reset (deletes all data):**

```bash
./utils/stop_postgres.sh
rm -rf postgres_data
./utils/setup_local_postgres.sh
```

### View Active Connections

```bash
psql -h localhost -p 5433 -d postgres -U computer -c "SELECT datname, usename, application_name, client_addr FROM pg_stat_activity WHERE datname = 'financial_transactions';"
```

## Performance Tuning

For local development, you can optimize PostgreSQL configuration in `postgres_data/postgresql.conf`:

```conf
# Memory settings (adjust based on your Mac's RAM)
shared_buffers = 256MB          # 25% of RAM for database only
effective_cache_size = 1GB      # 50-75% of RAM
work_mem = 16MB                 # Memory for sorts/joins
maintenance_work_mem = 64MB     # Memory for maintenance operations

# Connection settings
max_connections = 20            # Fewer connections for local dev

# Logging (helpful for development)
log_statement = 'all'           # Log all SQL statements
log_duration = on               # Log query duration
```

Restart after changes:

```bash
./utils/stop_postgres.sh
./utils/start_postgres.sh
```

## Comparison with System PostgreSQL

### Local PostgreSQL (This Setup)

- **Pros**: Self-contained, portable, isolated, easy to reset
- **Cons**: Manual start/stop, separate instance per project
- **Best for**: Development, testing, isolated environments

### System PostgreSQL (`setup_postgres.sh`)

- **Pros**: Always running, shared across projects, production-like
- **Cons**: Shared state, harder to reset, system-wide changes
- **Best for**: Production-like development, multiple projects

## Security Notes

### Local Development

The local PostgreSQL setup is configured for **development convenience**:

- Listens on localhost only
- Uses custom port to avoid conflicts
- Password authentication for ftm_user
- Trust authentication for superuser (local connections)

### Production

For production deployments, use the system PostgreSQL (`setup_postgres.sh`) with:

- SSL/TLS encryption
- Strong passwords
- Restricted network access
- Regular backups
- Monitoring and alerting

## Additional Resources

- [PostgreSQL Documentation](https://www.postgresql.org/docs/current/)
- [pg_ctl Command Reference](https://www.postgresql.org/docs/current/app-pg-ctl.html)
- [PostgreSQL Configuration](https://www.postgresql.org/docs/current/runtime-config.html)
- [Backup and Restore](https://www.postgresql.org/docs/current/backup.html)

## Summary

You now have a **local PostgreSQL instance** running in your backend directory at `postgres_data/`, just like your
SQLite database file. Use the helper scripts to manage it:

```bash
./utils/start_postgres.sh    # Start the server
./utils/stop_postgres.sh     # Stop the server
./utils/status_postgres.sh   # Check status
```

Your database files are now located alongside your code, making them easy to backup, move, and manage! 🎉

