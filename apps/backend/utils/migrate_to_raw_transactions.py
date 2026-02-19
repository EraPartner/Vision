"""Migration script to add raw transaction tables.

This migration adds the new architecture with bank-specific raw transaction tables.

Changes:
1. Create belfius_raw_transactions table
2. Create revolut_raw_transactions table
3. Create kbc_raw_transactions table
4. Create transaction_raw_references table
5. Remove original_raw_data and bank_reference columns from transactions table

Run this migration after backing up your database.
"""
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import text, inspect
from database.connection import get_engine, get_session
from database.raw_transaction_models import (
    BelfiusRawTransaction,
    RevolutRawTransaction,
    KBCRawTransaction,
    TransactionRawReference
)
from config.logging_config import setup_logging

logger = setup_logging(__name__)


def check_column_exists(engine, table_name: str, column_name: str) -> bool:
    """Check if a column exists in a table.

    Args:
        engine: SQLAlchemy engine
        table_name: Name of the table
        column_name: Name of the column

    Returns:
        True if column exists, False otherwise
    """
    inspector = inspect(engine)
    columns = [col['name'] for col in inspector.get_columns(table_name)]
    return column_name in columns


def check_table_exists(engine, table_name: str) -> bool:
    """Check if a table exists in the database.

    Args:
        engine: SQLAlchemy engine
        table_name: Name of the table

    Returns:
        True if table exists, False otherwise
    """
    inspector = inspect(engine)
    return table_name in inspector.get_table_names()


def create_raw_transaction_tables(engine):
    """Create all raw transaction tables.

    Args:
        engine: SQLAlchemy engine
    """
    logger.info("Creating raw transaction tables...")

    # Create tables using SQLAlchemy models
    tables_to_create = [
        BelfiusRawTransaction.__table__,
        RevolutRawTransaction.__table__,
        KBCRawTransaction.__table__,
        TransactionRawReference.__table__
    ]

    for table in tables_to_create:
        if not check_table_exists(engine, table.name):
            logger.info(f"Creating table: {table.name}")
            table.create(engine, checkfirst=True)
        else:
            logger.info(f"Table {table.name} already exists, skipping...")

    logger.info("Raw transaction tables created successfully")


def remove_old_columns_from_transactions(engine):
    """Remove original_raw_data and bank_reference columns from transactions table.

    Note: SQLite doesn't support DROP COLUMN directly, so we need to:
    1. Create a new table without the columns
    2. Copy data
    3. Drop old table
    4. Rename new table

    For PostgreSQL, we can use ALTER TABLE DROP COLUMN directly.

    Args:
        engine: SQLAlchemy engine
    """
    logger.info("Checking for old columns in transactions table...")

    # Check if columns exist
    has_original_raw_data = check_column_exists(engine, 'transactions', 'original_raw_data')
    has_bank_reference = check_column_exists(engine, 'transactions', 'bank_reference')

    if not has_original_raw_data and not has_bank_reference:
        logger.info("Columns already removed, skipping...")
        return

    # Determine database type
    db_dialect = engine.dialect.name

    if db_dialect == 'postgresql':
        logger.info("Using PostgreSQL ALTER TABLE DROP COLUMN...")

        with engine.begin() as conn:
            if has_original_raw_data:
                logger.info("Dropping column: original_raw_data")
                conn.execute(text("ALTER TABLE transactions DROP COLUMN IF EXISTS original_raw_data"))

            if has_bank_reference:
                logger.info("Dropping column: bank_reference")
                conn.execute(text("ALTER TABLE transactions DROP COLUMN IF EXISTS bank_reference"))

        logger.info("Columns removed successfully (PostgreSQL)")

    elif db_dialect == 'sqlite':
        logger.info("Using SQLite table recreation method...")

        # SQLite requires table recreation
        with engine.begin() as conn:
            # Check if backup table exists
            if check_table_exists(engine, 'transactions_backup'):
                logger.warning("Backup table exists, removing it first...")
                conn.execute(text("DROP TABLE transactions_backup"))

            # Create backup
            logger.info("Creating backup: transactions_backup")
            conn.execute(text("ALTER TABLE transactions RENAME TO transactions_backup"))

            # Create new table without the columns
            logger.info("Creating new transactions table without old columns...")
            conn.execute(text("""
                              CREATE TABLE transactions
                              (
                                  id           INTEGER PRIMARY KEY,
                                  date         DATE               NOT NULL,
                                  amount       NUMERIC(10, 2)     NOT NULL,
                                  currency     VARCHAR(3),
                                  balance      NUMERIC(12, 2),
                                  memo         TEXT,
                                  comment      TEXT,
                                  bank_account TEXT,
                                  recipient_id INTEGER            NOT NULL,
                                  category_id  INTEGER,
                                  batch_id     INTEGER,
                                  is_active    BOOLEAN  DEFAULT 1 NOT NULL,
                                  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
                                  updated_at   DATETIME,
                                  FOREIGN KEY (recipient_id) REFERENCES recipients (id),
                                  FOREIGN KEY (category_id) REFERENCES categories (id),
                                  FOREIGN KEY (batch_id) REFERENCES import_batches (id)
                              )
                              """))

            # Copy data
            logger.info("Copying data from backup to new table...")
            conn.execute(text("""
                              INSERT INTO transactions (id, date, amount, currency, balance, memo, comment,
                                                        bank_account, recipient_id, category_id, batch_id,
                                                        is_active, created_at, updated_at)
                              SELECT id, date, amount, currency, balance, memo, comment, bank_account, recipient_id, category_id, batch_id, is_active, created_at, updated_at
                              FROM transactions_backup
                              """))

            # Recreate indexes
            logger.info("Recreating indexes...")
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_transactions_id ON transactions(id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_transactions_date ON transactions(date)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_transactions_bank_account ON transactions(bank_account)"))

            # Drop backup table
            logger.info("Dropping backup table...")
            conn.execute(text("DROP TABLE transactions_backup"))

        logger.info("Columns removed successfully (SQLite)")

    else:
        logger.error(f"Unsupported database dialect: {db_dialect}")
        raise ValueError(f"Unsupported database dialect: {db_dialect}")


def run_migration():
    """Run the complete migration."""
    logger.info("=" * 60)
    logger.info("Starting Raw Transaction Tables Migration")
    logger.info("=" * 60)

    engine = get_engine()

    try:
        # Step 1: Create new raw transaction tables
        logger.info("\n[Step 1/2] Creating raw transaction tables...")
        create_raw_transaction_tables(engine)

        # Step 2: Remove old columns from transactions table
        logger.info("\n[Step 2/2] Removing old columns from transactions table...")
        remove_old_columns_from_transactions(engine)

        logger.info("\n" + "=" * 60)
        logger.info("Migration completed successfully!")
        logger.info("=" * 60)
        logger.info("\nNew tables created:")
        logger.info("  - belfius_raw_transactions")
        logger.info("  - revolut_raw_transactions")
        logger.info("  - kbc_raw_transactions")
        logger.info("  - transaction_raw_references")
        logger.info("\nColumns removed from transactions table:")
        logger.info("  - original_raw_data")
        logger.info("  - bank_reference")
        logger.info("\nNext steps:")
        logger.info("  1. Update your import code to use RawTransactionImportService")
        logger.info("  2. Test imports with the new architecture")
        logger.info("  3. Existing transactions will work normally (no raw references)")

    except Exception as e:
        logger.error(f"\nMigration failed: {e}", exc_info=True)
        logger.error("\nPlease restore from backup if necessary")
        raise
    finally:
        engine.dispose()


def rollback_migration():
    """Rollback the migration (add columns back).

    This is a safety mechanism in case the migration needs to be rolled back.
    """
    logger.info("=" * 60)
    logger.info("Rolling back Raw Transaction Tables Migration")
    logger.info("=" * 60)

    engine = get_engine()
    db_dialect = engine.dialect.name

    try:
        with engine.begin() as conn:
            if db_dialect == 'postgresql':
                logger.info("Adding columns back to transactions table (PostgreSQL)...")
                conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS original_raw_data TEXT"))
                conn.execute(text("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS bank_reference TEXT"))

            elif db_dialect == 'sqlite':
                logger.info("Cannot add columns back in SQLite easily.")
                logger.info("Please restore from backup if needed.")
                raise NotImplementedError("SQLite rollback requires manual backup restoration")

        logger.info("Rollback completed successfully")

    except Exception as e:
        logger.error(f"Rollback failed: {e}", exc_info=True)
        raise
    finally:
        engine.dispose()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Migrate to raw transaction architecture")
    parser.add_argument(
        '--rollback',
        action='store_true',
        help='Rollback the migration (add columns back)'
    )

    args = parser.parse_args()

    if args.rollback:
        rollback_migration()
    else:
        run_migration()
