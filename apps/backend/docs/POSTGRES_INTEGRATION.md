# PostgreSQL Server Management Integration

## Overview

The Financial Transaction Manager API now automatically manages the lifecycle of a local PostgreSQL server for
development and testing environments. This integration ensures that:

1. PostgreSQL data directory is automatically initialized if it doesn't exist
2. PostgreSQL server starts automatically when the application starts
3. PostgreSQL server stops gracefully when the application shuts down

## Architecture

### Components

#### 1. PostgresManager (`utils/postgres_manager.py`)

A comprehensive utility class that manages PostgreSQL server lifecycle operations:

- **Initialization Detection**: Checks if `postgres_data/base` directory exists
- **Automatic Setup**: Runs `setup_local_postgres.sh` if not initialized
- **Server Start**: Executes `start_postgres.sh` with error handling
- **Server Stop**: Executes `stop_postgres.sh` with graceful shutdown
- **Audit Logging**: Comprehensive structured logging for all operations

**Key Methods:**

- `is_initialized()`: Check if PostgreSQL is set up
- `setup()`: Run initial PostgreSQL setup
- `start()`: Start the PostgreSQL server
- `stop()`: Stop the PostgreSQL server
- `ensure_running()`: High-level method that handles setup and start

#### 2. Application Lifespan Integration (`main.py`)

The PostgreSQL manager is integrated into FastAPI's lifespan context manager:

**Startup Flow:**

1. Validate configuration
2. **Ensure PostgreSQL server is running** (new)
    - Check if initialized
    - Run setup if needed
    - Start server
3. Initialize database tables

**Shutdown Flow:**

1. **Stop PostgreSQL server gracefully** (new)
2. Log shutdown completion

## Usage

### Automatic Operation

No manual intervention required! The PostgreSQL server will be managed automatically:

```bash
# Start the application
python main.py
```

**What happens:**

1. Application checks if `postgres_data/base` exists
2. If not found, runs `./utils/setup_local_postgres.sh` (may prompt for configuration)
3. Starts PostgreSQL server on port 5433
4. Initializes database tables
5. Application ready to accept requests

When you stop the application (Ctrl+C), the PostgreSQL server stops automatically.

### Manual Override

You can still manage PostgreSQL manually if needed:

```bash
# Start PostgreSQL manually
./utils/start_postgres.sh

# Stop PostgreSQL manually
./utils/stop_postgres.sh

# Check status
./utils/status_postgres.sh

# Re-run setup (warning: may reset database)
./utils/setup_local_postgres.sh
```

## Configuration

### PostgreSQL Settings

Default configuration (from `setup_local_postgres.sh`):

- **Data Directory**: `./postgres_data`
- **Port**: `5433` (non-default to avoid conflicts)
- **Database Name**: `financial_transactions`
- **User**: `ftm_user`
- **Host**: `localhost`
- **Authentication**: Configurable (trust or password)

### Application Settings

Update your `.env` file or `config/config.py`:

```env
DATABASE_URL=postgresql://ftm_user@localhost:5433/financial_transactions
```

## Error Handling

### Startup Errors

If PostgreSQL fails to start, the application will:

1. Log detailed error information
2. Raise `RuntimeError` with context
3. Prevent application from starting in invalid state

**Common Issues:**

**PostgreSQL not installed:**

```
RuntimeError: PostgreSQL server initialization failed: Setup script failed...
```

**Solution:** Install PostgreSQL using `brew install postgresql@15`

**Port conflict (5433 already in use):**

```
RuntimeError: PostgreSQL server initialization failed: Start script failed...
```

**Solution:** Stop conflicting process or change port in setup script

**Permission issues:**

```
RuntimeError: PostgreSQL server initialization failed: Permission denied
```

**Solution:** Ensure execute permissions on scripts: `chmod +x utils/*.sh`

### Shutdown Errors

If PostgreSQL fails to stop gracefully:

1. Error is logged but not raised (graceful degradation)
2. Application shutdown continues
3. PostgreSQL may remain running (check with `./utils/status_postgres.sh`)

## Logging

All PostgreSQL operations are logged with structured metadata for audit trails:

```json
{
  "operation": "postgres_ensure_running",
  "resource_type": "database",
  "status": "success",
  "timestamp": "2026-02-19T10:30:00Z"
}
```

**Key Operations Logged:**

- `postgres_init_check`: Initialization detection
- `postgres_setup`: Setup script execution
- `postgres_start`: Server start
- `postgres_stop`: Server stop
- `postgres_ensure_running`: High-level startup flow

## Testing

### Unit Tests

Test the PostgresManager in isolation:

```python
import pytest
from utils.postgres_manager import PostgresManager


@pytest.mark.asyncio
async def test_postgres_manager_initialization():
    manager = PostgresManager()
    assert manager.postgres_data_dir.name == "postgres_data"
```

### Integration Tests

Test the full application lifecycle:

```python
import pytest
from fastapi.testclient import TestClient
from main import app


def test_application_startup_with_postgres():
    # TestClient automatically handles lifespan
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200
```

## Security Considerations

1. **Local Development Only**: This automated setup is designed for local development. Production environments should
   use managed PostgreSQL services.

2. **Password Authentication**: The setup script offers password authentication option. For production, always use
   strong passwords and SSL connections.

3. **Port Exposure**: PostgreSQL runs on `localhost:5433` and is not exposed to external networks by default.

4. **Audit Logging**: All PostgreSQL operations are logged for security auditing.

## Production Deployment

**Important:** Do not use this automated PostgreSQL management in production!

For production deployments:

1. Use managed PostgreSQL services (AWS RDS, Google Cloud SQL, Azure Database)
2. Configure connection pooling (PgBouncer)
3. Set up proper backup and disaster recovery
4. Implement SSL/TLS for connections
5. Use strong authentication and authorization
6. Remove or disable the PostgresManager initialization

Update `main.py` for production:

```python
# In production, use managed PostgreSQL - skip local server management
if settings.server.environment != "production":
    await _ensure_postgres_server()
```

## Troubleshooting

### PostgreSQL won't start

1. Check if already running: `./utils/status_postgres.sh`
2. Review logs: `cat postgres_data/postgres.log`
3. Check port availability: `lsof -i :5433`
4. Verify PostgreSQL installation: `which postgres`

### Application hangs on startup

1. Check if setup script is waiting for input
2. Run setup manually: `./utils/setup_local_postgres.sh`
3. Check application logs for detailed error messages

### PostgreSQL won't stop

1. Try manual stop: `./utils/stop_postgres.sh`
2. Force stop: `pg_ctl -D ./postgres_data stop -m immediate`
3. Last resort: `pkill -9 postgres` (warning: may cause data corruption)

### Data directory corruption

1. Stop PostgreSQL completely
2. Backup existing data: `cp -r postgres_data postgres_data.backup`
3. Remove corrupted directory: `rm -rf postgres_data`
4. Restart application (will re-initialize)

## Future Enhancements

Potential improvements for this integration:

1. **Environment Detection**: Automatically disable for production environments
2. **Health Checks**: Periodic PostgreSQL health checks during runtime
3. **Graceful Degradation**: Fallback to SQLite if PostgreSQL setup fails
4. **Performance Monitoring**: Track PostgreSQL performance metrics
5. **Automatic Backups**: Scheduled database backups during runtime

## References

- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [FastAPI Lifespan Events](https://fastapi.tiangolo.com/advanced/events/)
- [Asyncio Subprocess](https://docs.python.org/3/library/asyncio-subprocess.html)

## Change Log

### 2026-02-19 - Initial Integration

- Created `PostgresManager` utility class
- Integrated into FastAPI lifespan
- Added startup and shutdown handlers
- Implemented comprehensive error handling
- Added structured audit logging
- Created documentation

