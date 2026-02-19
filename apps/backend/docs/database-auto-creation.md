# Automatic PostgreSQL Database Creation

## Overview

The Financial Transaction Manager API now automatically creates PostgreSQL databases on startup if they don't exist.
This feature ensures a smooth deployment experience and eliminates manual database creation steps.

## Implementation Details

### Architecture

The automatic database creation feature consists of two main components:

1. **`ensure_postgresql_database_exists()`** in `database/connection.py`
    - Checks if the target PostgreSQL database exists
    - Creates the database if it doesn't exist
    - Idempotent - safe to call multiple times

2. **Enhanced startup sequence** in `main.py`
    - Calls `ensure_postgresql_database_exists()` before table initialization
    - Integrated into the existing retry logic for robustness

### How It Works

1. **Startup Trigger**: When the application starts, the `lifespan()` function calls `_initialise_database_with_retry()`

2. **Database Check**:
    - Parses the `DATABASE_URL` to extract the target database name
    - Connects to the PostgreSQL server using the `postgres` database (which always exists)
    - Queries `pg_database` to check if the target database exists

3. **Database Creation**:
    - If the database doesn't exist, executes `CREATE DATABASE` command
    - Logs the creation for audit trails
    - Disposes of the temporary connection

4. **Table Initialization**:
    - After ensuring the database exists, proceeds with normal table creation using SQLAlchemy's
      `Base.metadata.create_all()`

### Database Type Handling

- **PostgreSQL**: Full automatic database creation is performed
- **SQLite**: No-op (SQLite databases are created automatically by SQLAlchemy when accessing the file)

## Configuration

The feature uses the existing `DATABASE_URL` configuration from `.env.local`:

```env
DATABASE_URL="postgresql://ftm_user@localhost:5433/financial_transactions"
```

### URL Format

**PostgreSQL**: `postgresql://[user[:password]@][host][:port]/database_name`

Example:

- `postgresql://ftm_user@localhost:5433/financial_transactions`
- `postgresql://user:pass@db.example.com:5432/myapp`

**SQLite**: `sqlite:///path/to/database.db`

Example:

- `sqlite:///financial_transactions.db`
- `sqlite:////absolute/path/to/database.db`

## Requirements

### PostgreSQL User Privileges

The PostgreSQL user specified in `DATABASE_URL` must have:

- `CONNECT` privilege to the PostgreSQL server
- `CREATE DATABASE` privilege

To grant these privileges:

```sql
-- Connect as postgres superuser
psql
-U postgres

-- Grant CREATE DATABASE privilege
ALTER
USER ftm_user CREATEDB;

-- Verify privileges
\du
ftm_user
```

### Network Connectivity

- The application must be able to connect to the PostgreSQL server
- Firewall rules must allow connections on the specified port (default: 5432)

## Error Handling

### Connection Failures

If the application cannot connect to the PostgreSQL server:

```
ERROR: Failed to connect to PostgreSQL server: could not connect to server
```

**Resolution**:

1. Verify PostgreSQL server is running
2. Check `DATABASE_URL` host and port
3. Verify network connectivity and firewall rules

### Permission Denied

If the user lacks `CREATE DATABASE` privilege:

```
ERROR: permission denied to create database
```

**Resolution**:

```sql
ALTER
USER ftm_user CREATEDB;
```

### Database Already Exists

If the database already exists, the function logs and continues normally:

```
INFO: PostgreSQL database 'financial_transactions' already exists
```

This is expected behaviour and requires no action.

## Logging

The feature provides comprehensive logging for audit trails:

### Successful Creation

```json
{
  "operation": "database_create",
  "resource_type": "database",
  "database_name": "financial_transactions",
  "status": "success"
}
```

### Database Already Exists

```json
{
  "operation": "database_check",
  "resource_type": "database",
  "database_name": "financial_transactions",
  "status": "exists"
}
```

### Connection Failure

```json
{
  "operation": "database_check",
  "resource_type": "database",
  "status": "connection_failed",
  "error_type": "OperationalError"
}
```

## Testing

### Manual Testing

1. **Test with non-existent database**:
   ```bash
   # Drop the database if it exists
   psql -U postgres -c "DROP DATABASE IF EXISTS financial_transactions;"
   
   # Start the application
   uvicorn main:app --reload
   
   # Verify database was created
   psql -U postgres -c "\l" | grep financial_transactions
   ```

2. **Test with existing database**:
   ```bash
   # Start the application (database already exists)
   uvicorn main:app --reload
   
   # Should log "database already exists" and continue normally
   ```

3. **Test with SQLite**:
   ```bash
   # Update .env.local to use SQLite
   DATABASE_URL="sqlite:///./financial_transactions.db"
   
   # Start the application
   uvicorn main:app --reload
   
   # Should skip PostgreSQL checks and create SQLite file
   ```

### Automated Testing

Add tests to verify the database creation logic:

```python
def test_ensure_postgresql_database_exists():
    """Test that ensure_postgresql_database_exists creates database if missing"""
    # Test implementation here
    pass


def test_ensure_postgresql_database_exists_idempotent():
    """Test that calling ensure_postgresql_database_exists multiple times is safe"""
    # Test implementation here
    pass


def test_sqlite_database_creation_skipped():
    """Test that SQLite databases skip the PostgreSQL creation logic"""
    # Test implementation here
    pass
```

## Security Considerations

### Database Credentials

- **Never hardcode credentials** in the application code
- Store `DATABASE_URL` in `.env.local` (excluded from version control)
- Use environment variables in production deployments
- Consider using secrets management services (AWS Secrets Manager, HashiCorp Vault) for production

### Privilege Management

- Follow the **principle of least privilege**
- The application user only needs `CREATE DATABASE` for initial setup
- Consider using a separate migration user with elevated privileges
- Application runtime user can have reduced privileges after setup

### SQL Injection Protection

The implementation uses:

- **Parameterised queries** for checking database existence (`:dbname` parameter)
- **Proper identifier quoting** for `CREATE DATABASE` statement
- No user input is directly interpolated into SQL commands

## Deployment Scenarios

### First-Time Deployment

1. Configure `DATABASE_URL` with target database name
2. Ensure PostgreSQL user has `CREATE DATABASE` privilege
3. Start the application
4. Database is automatically created and tables are initialized

### Existing Deployment

1. Application detects existing database
2. Skips database creation
3. Proceeds with table initialization (idempotent)
4. No disruption to existing data

### Container Deployments (Docker/Kubernetes)

```dockerfile
# Dockerfile
FROM python:3.12-slim

# ... installation steps ...

# Database is automatically created on container startup
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Cloud Deployments

- **AWS RDS**: Ensure security group allows connections from application
- **Google Cloud SQL**: Configure Cloud SQL Proxy or direct connection
- **Azure Database**: Use connection string from Azure Portal

## Troubleshooting

### Issue: "relation does not exist" after database creation

**Cause**: Tables not created after database creation

**Resolution**: Check `init_db()` is called after `ensure_postgresql_database_exists()`

### Issue: "database already exists" error during creation

**Cause**: Race condition in multi-instance deployments

**Resolution**: This is handled gracefully - the function checks existence before creation

### Issue: Application hangs during startup

**Cause**: Cannot connect to PostgreSQL server

**Resolution**:

1. Check PostgreSQL server status: `systemctl status postgresql`
2. Verify connection parameters in `DATABASE_URL`
3. Check application logs for connection errors

## Best Practices

1. **Use separate databases for different environments**:
    - Development: `financial_transactions_dev`
    - Testing: `financial_transactions_test`
    - Production: `financial_transactions`

2. **Monitor database creation events** in production logs for security auditing

3. **Consider database migrations** (Alembic) for production schema changes

4. **Backup before major deployments** to prevent data loss

5. **Test database creation** in staging environment before production deployment

## Future Enhancements

Potential improvements to consider:

1. **Database template support**: Create databases from custom templates
2. **Charset and collation configuration**: Specify database encoding settings
3. **Database owner specification**: Set database owner during creation
4. **Connection pooling for database checks**: Reuse connections for efficiency
5. **Health check endpoint**: Expose database status for monitoring

## References

- [PostgreSQL CREATE DATABASE Documentation](https://www.postgresql.org/docs/current/sql-createdatabase.html)
- [SQLAlchemy Core Documentation](https://docs.sqlalchemy.org/en/20/core/)
- [FastAPI Startup Events](https://fastapi.tiangolo.com/advanced/events/)

## Changelog

### Version 1.0.0 (2026-02-19)

- Initial implementation of automatic PostgreSQL database creation
- Integration with existing startup sequence
- Comprehensive logging and error handling
- Documentation and testing guidelines

