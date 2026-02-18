"""
Migration script to create planned_transaction_executions table.

This table tracks the execution history of planned transactions, allowing
recurring transactions to be executed multiple times while maintaining a
complete audit trail.
"""

import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import create_engine, text
from database.connection import DATABASE_URL


def create_planned_transaction_executions_table():
    """Create the planned_transaction_executions table."""
    engine = create_engine(DATABASE_URL)

    create_table_sql = """
                       CREATE TABLE IF NOT EXISTS planned_transaction_executions
                       (
                           id
                           INTEGER
                           PRIMARY
                           KEY
                           AUTOINCREMENT,
                           planned_transaction_id
                           INTEGER
                           NOT
                           NULL,
                           executed_transaction_id
                           INTEGER
                           NOT
                           NULL,
                           execution_date
                           DATE
                           NOT
                           NULL,
                           created_at
                           DATETIME
                           DEFAULT (
                           datetime
                       (
                           'now',
                           'utc'
                       )),
                           FOREIGN KEY
                       (
                           planned_transaction_id
                       ) REFERENCES planned_transactions
                       (
                           id
                       ) ON DELETE CASCADE,
                           FOREIGN KEY
                       (
                           executed_transaction_id
                       ) REFERENCES transactions
                       (
                           id
                       )
                         ON DELETE CASCADE
                           ); \
                       """

    create_index_sql = """
                       CREATE INDEX IF NOT EXISTS idx_planned_txn_executions_planned_id
                           ON planned_transaction_executions(planned_transaction_id); \
                       """

    with engine.connect() as conn:
        conn.execute(text(create_table_sql))
        conn.execute(text(create_index_sql))
        conn.commit()
        print("✓ planned_transaction_executions table created successfully")


def add_last_executed_date_column():
    """Add last_executed_date column to planned_transactions table."""
    engine = create_engine(DATABASE_URL)

    alter_table_sql = """
                      ALTER TABLE planned_transactions
                          ADD COLUMN last_executed_date DATE NULL; \
                      """

    with engine.connect() as conn:
        try:
            conn.execute(text(alter_table_sql))
            conn.commit()
            print("✓ last_executed_date column added successfully")
        except Exception as e:
            if "duplicate column name" in str(e).lower():
                print("✓ last_executed_date column already exists")
            else:
                raise


if __name__ == "__main__":
    print("Creating planned_transaction_executions table...")
    create_planned_transaction_executions_table()
    print("\nAdding last_executed_date column...")
    add_last_executed_date_column()
    print("\n✓ Migration completed successfully!")
