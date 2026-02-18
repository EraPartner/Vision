"""
Migration script to remove deprecated executed_transaction_id column from planned_transactions.

The executed_transaction_id column is now redundant since we have the
planned_transaction_executions table that tracks all executions with full history.

The executed_transaction_id is now a computed property that returns the most recent
execution from the executions relationship.
"""

import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import create_engine, text
from database.connection import DATABASE_URL


def remove_executed_transaction_id_column():
    """Remove the executed_transaction_id column from planned_transactions table."""
    engine = create_engine(DATABASE_URL)

    # Note: SQLite doesn't support DROP COLUMN directly
    # We need to recreate the table without that column

    migration_sql = """
                    -- Create new table without executed_transaction_id
                    CREATE TABLE planned_transactions_new
                    (
                        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                        planned_date       DATE               NOT NULL,
                        amount             DECIMAL(10, 2)     NOT NULL,
                        currency           VARCHAR(3),
                        memo               TEXT,
                        comment            TEXT,
                        bank_account       TEXT,
                        recipient_id       INTEGER            NOT NULL,
                        category_id        INTEGER,
                        is_recurring       BOOLEAN  DEFAULT 0 NOT NULL,
                        recurrence_pattern TEXT,
                        is_executed        BOOLEAN  DEFAULT 0 NOT NULL,
                        last_executed_date DATE,
                        is_active          BOOLEAN  DEFAULT 1 NOT NULL,
                        created_at         DATETIME DEFAULT (datetime('now', 'utc')),
                        updated_at         DATETIME,
                        FOREIGN KEY (recipient_id) REFERENCES recipients (id),
                        FOREIGN KEY (category_id) REFERENCES categories (id)
                    );

                    -- Copy data from old table to new table
                    INSERT INTO planned_transactions_new
                    (id, planned_date, amount, currency, memo, comment, bank_account,
                     recipient_id, category_id, is_recurring, recurrence_pattern,
                     is_executed, last_executed_date, is_active, created_at, updated_at)
                    SELECT id,
                           planned_date,
                           amount,
                           currency,
                           memo,
                           comment,
                           bank_account,
                           recipient_id,
                           category_id,
                           is_recurring,
                           recurrence_pattern,
                           is_executed,
                           last_executed_date,
                           is_active,
                           created_at,
                           updated_at
                    FROM planned_transactions;

                    -- Drop old table
                    DROP TABLE planned_transactions;

                    -- Rename new table
                    ALTER TABLE planned_transactions_new RENAME TO planned_transactions;

                    -- Recreate indexes
                    CREATE INDEX IF NOT EXISTS idx_planned_transactions_planned_date
                        ON planned_transactions(planned_date);
                    CREATE INDEX IF NOT EXISTS idx_planned_transactions_bank_account
                        ON planned_transactions(bank_account); \
                    """

    with engine.connect() as conn:
        # Execute migration as a single transaction
        for statement in migration_sql.split(';'):
            statement = statement.strip()
            if statement:
                conn.execute(text(statement))
        conn.commit()
        print("✓ Successfully removed executed_transaction_id column from planned_transactions")


if __name__ == "__main__":
    print("Removing deprecated executed_transaction_id column...")
    print("This column is now a computed property from the executions relationship.")
    print()

    try:
        remove_executed_transaction_id_column()
        print("\n✓ Migration completed successfully!")
        print("\nThe executed_transaction_id is now available as a computed property")
        print("that returns the most recent execution from the executions table.")
    except Exception as e:
        print(f"\n✗ Migration failed: {e}")
        raise
