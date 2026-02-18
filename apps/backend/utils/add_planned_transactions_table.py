"""
Migration script to create planned_transactions table for future transaction management.

This migration adds the planned_transactions table to store future/planned transactions
for budgeting, forecasting, and recurring transaction management.
"""
from sqlalchemy import create_engine, text

from config.logging_config import setup_logging
from database.connection import DATABASE_URL

logger = setup_logging(__name__)


def create_planned_transactions_table():
    """Create the planned_transactions table."""
    engine = create_engine(DATABASE_URL)

    create_table_sql = """
                       CREATE TABLE IF NOT EXISTS planned_transactions
                       (
                           id
                           INTEGER
                           PRIMARY
                           KEY
                           AUTOINCREMENT,
                           planned_date
                           DATE
                           NOT
                           NULL,
                           amount
                           DECIMAL
                       (
                           10,
                           2
                       ) NOT NULL,
                           currency VARCHAR
                       (
                           3
                       ),
                           memo TEXT,
                           comment TEXT,
                           bank_account TEXT,
                           recipient_id INTEGER NOT NULL,
                           category_id INTEGER,
                           is_recurring BOOLEAN DEFAULT 0 NOT NULL,
                           recurrence_pattern TEXT,
                           is_executed BOOLEAN DEFAULT 0 NOT NULL,
                           executed_transaction_id INTEGER,
                           is_active BOOLEAN DEFAULT 1 NOT NULL,
                           created_at DATETIME DEFAULT
                       (
                           datetime
                       (
                           'now',
                           'utc'
                       )),
                           updated_at DATETIME,
                           FOREIGN KEY
                       (
                           recipient_id
                       ) REFERENCES recipients
                       (
                           id
                       ),
                           FOREIGN KEY
                       (
                           category_id
                       ) REFERENCES categories
                       (
                           id
                       ),
                           FOREIGN KEY
                       (
                           executed_transaction_id
                       ) REFERENCES transactions
                       (
                           id
                       )
                           ); \
                       """

    create_indexes_sql = [
        "CREATE INDEX IF NOT EXISTS idx_planned_transactions_planned_date ON planned_transactions(planned_date);",
        "CREATE INDEX IF NOT EXISTS idx_planned_transactions_bank_account ON planned_transactions(bank_account);",
        "CREATE INDEX IF NOT EXISTS idx_planned_transactions_recipient_id ON planned_transactions(recipient_id);",
        "CREATE INDEX IF NOT EXISTS idx_planned_transactions_category_id ON planned_transactions(category_id);",
        "CREATE INDEX IF NOT EXISTS idx_planned_transactions_is_active ON planned_transactions(is_active);",
        "CREATE INDEX IF NOT EXISTS idx_planned_transactions_is_executed ON planned_transactions(is_executed);",
        "CREATE INDEX IF NOT EXISTS idx_planned_transactions_is_recurring ON planned_transactions(is_recurring);"
    ]

    try:
        with engine.connect() as conn:
            # Create table
            conn.execute(text(create_table_sql))
            logger.info("Created planned_transactions table")

            # Create indexes
            for index_sql in create_indexes_sql:
                conn.execute(text(index_sql))

            logger.info("Created indexes for planned_transactions table")
            conn.commit()

        logger.info("Migration completed successfully")
        return True

    except Exception as e:
        logger.error(f"Migration failed: {e}", exc_info=True)
        return False


if __name__ == "__main__":
    print("Creating planned_transactions table...")
    success = create_planned_transactions_table()
    if success:
        print("✓ Migration completed successfully")
    else:
        print("✗ Migration failed")
