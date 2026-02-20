# Alembic Database Migration Setup

## Overview

Alembic is now configured for the Financial Transaction Manager API to manage database schema migrations. This enables
version-controlled, trackable changes to the database schema.

## Configuration

### Files Configured

1. **`alembic.ini`** - Main Alembic configuration file
    - Located at project root
    - Database URL is configured programmatically via `env.py`

2. **`alembic/env.py`** - Migration environment configuration
    - Imports application models from `database.models`
    - Reads database URL from application settings (`config.config`)
    - Handles both SQLite (development) and PostgreSQL (production)

3. **`alembic/versions/`** - Migration scripts directory
    - Contains all migration files
    - Currently has initial migration: `a82e8e3148ec_initial_database_schema.py`

## Common Commands

### Check Current Migration Status

```bash
alembic current
```

Shows which migration version is currently applied to the database.

### Check if Database Matches Models

```bash
alembic check
```

Verifies if the database schema matches your SQLAlchemy models. Returns errors if migrations are needed.

### Create a New Migration

**Automatic (recommended):**

```bash
alembic revision --autogenerate -m "Description of changes"
```

**Manual:**

```bash
alembic revision -m "Description of changes"
```

### Apply Migrations

**Upgrade to latest:**

```bash
alembic upgrade head
```

**Upgrade by one version:**

```bash
alembic upgrade +1
```

**Upgrade to specific revision:**

```bash
alembic upgrade <revision_id>
```

### Rollback Migrations

**Downgrade by one version:**

```bash
alembic downgrade -1
```

**Downgrade to specific revision:**

```bash
alembic downgrade <revision_id>
```

**Downgrade all:**

```bash
alembic downgrade base
```

### View Migration History

```bash
alembic history
```

**Verbose output:**

```bash
alembic history -v
```

**Show current position:**

```bash
alembic history --indicate-current
```

## Workflow

### 1. Making Schema Changes

When you need to modify the database schema:

1. **Update your models** in `database/models.py`
   ```python
   # Example: Add a new column
   class Transaction(Base):
       # ...existing columns...
       new_field = Column(String(100), nullable=True)
   ```

2. **Generate migration**
   ```bash
   alembic revision --autogenerate -m "Add new_field to Transaction"
   ```

3. **Review the generated migration** in `alembic/versions/`
    - Check the `upgrade()` and `downgrade()` functions
    - Ensure they correctly represent your intended changes
    - Add any custom logic if needed (e.g., data migrations)

4. **Test the migration**
   ```bash
   # Apply migration
   alembic upgrade head
   
   # Test your application
   # If issues, rollback:
   alembic downgrade -1
   ```

5. **Commit the migration** to version control
   ```bash
   git add alembic/versions/<new_migration>.py
   git commit -m "Add new_field to Transaction table"
   ```

### 2. Data Migrations

For complex changes requiring data transformation:

```python
# In migration file
def upgrade():
    # Schema change
    op.add_column('transactions', sa.Column('status', sa.String(20)))

    # Data migration
    connection = op.get_bind()
    connection.execute(
        sa.text("UPDATE transactions SET status = 'active' WHERE is_active = true")
    )

    # Remove old column
    op.drop_column('transactions', 'is_active')


def downgrade():
    # Reverse operations in opposite order
    op.add_column('transactions', sa.Column('is_active', sa.Boolean()))

    connection = op.get_bind()
    connection.execute(
        sa.text("UPDATE transactions SET is_active = (status = 'active')")
    )

    op.drop_column('transactions', 'status')
```

### 3. Team Collaboration

When working with multiple developers:

1. **Before making changes:**
   ```bash
   git pull
   alembic upgrade head
   ```

2. **Handle migration conflicts:**
    - If two migrations were created independently, use `alembic merge`
   ```bash
   alembic merge <revision1> <revision2> -m "Merge migrations"
   ```

3. **Always apply migrations before running the application**

## Production Deployment

### Pre-deployment Checklist

- [ ] All migrations tested locally
- [ ] Migration files committed to repository
- [ ] Downgrade path verified
- [ ] Backup strategy in place
- [ ] Team notified of schema changes

### Deployment Steps

1. **Backup the database**
   ```bash
   # PostgreSQL example
   pg_dump -h localhost -U user -d financial_transactions > backup.sql
   ```

2. **Apply migrations**
   ```bash
   alembic upgrade head
   ```

3. **Verify application functionality**

4. **Rollback if needed**
   ```bash
   alembic downgrade -1
   # Restore from backup if necessary
   ```

## Best Practices

### DO

- ✅ Always use `--autogenerate` for schema changes
- ✅ Review generated migrations before applying
- ✅ Test both upgrade and downgrade paths
- ✅ Keep migrations small and focused
- ✅ Use descriptive migration messages
- ✅ Commit migrations with related code changes
- ✅ Include data migrations when renaming/removing columns
- ✅ Run migrations as part of deployment process

### DON'T

- ❌ Edit migrations after they've been applied
- ❌ Delete migration files
- ❌ Skip migrations (always apply in order)
- ❌ Use raw SQL without parameterisation for data migrations
- ❌ Forget to test downgrade paths
- ❌ Make schema changes without creating migrations
- ❌ Apply untested migrations to production

## Troubleshooting

### "New upgrade operations detected"

This means your database schema doesn't match your models. Generate and apply a migration:

```bash
alembic revision --autogenerate -m "Sync schema"
alembic upgrade head
```

### Migration already applied

If trying to apply a migration that's already been applied:

```bash
# Check current version
alembic current

# Check history
alembic history --indicate-current
```

### Conflicting migrations

If multiple developers create migrations simultaneously:

```bash
# Merge the migrations
alembic merge <rev1> <rev2> -m "Merge parallel migrations"
```

### Reset migration history (development only)

**⚠️ WARNING: This will destroy data!**

```bash
# Drop all tables
alembic downgrade base

# Or manually:
# DROP TABLE alembic_version;
# DROP TABLE ... (all other tables)

# Re-run all migrations
alembic upgrade head
```

### Database out of sync

If the database is in an unknown state:

```bash
# Stamp the database with current revision
alembic stamp head

# Or stamp with specific revision
alembic stamp <revision_id>
```

## Environment-Specific Notes

### SQLite (Development)

- Database: `financial_transactions.db`
- Migration tracking in `alembic_version` table
- Supports most operations, but some (like ALTER COLUMN) are limited

### PostgreSQL (Production)

- Connection pooling configured
- Full DDL support
- Transactions for migrations enabled by default
- Sequences auto-detected and managed

## References

- [Alembic Documentation](https://alembic.sqlalchemy.org/)
- [SQLAlchemy Documentation](https://docs.sqlalchemy.org/)
- [Database Migration Best Practices](https://docs.sqlalchemy.org/en/20/core/migrations.html)

## Initial Setup (Already Completed)

The following steps have already been completed for this project:

1. ✅ Installed Alembic
2. ✅ Initialised Alembic: `alembic init alembic`
3. ✅ Configured `alembic/env.py` to use application models
4. ✅ Configured database URL from application settings
5. ✅ Created initial migration: `a82e8e3148ec_initial_database_schema.py`

To verify the setup:

```bash
alembic check
```

To apply the initial migration (if not already applied):

```bash
alembic upgrade head
```

