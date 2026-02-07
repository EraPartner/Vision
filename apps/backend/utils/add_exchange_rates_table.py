"""
Migration script to create exchange_rates table for currency caching.

This migration adds the exchange_rates table to store currency exchange rates
in the database for faster lookups and offline operation.
"""
from sqlalchemy import create_engine, text

from config.logging_config import setup_logging
from database.connection import DATABASE_URL

logger = setup_logging(__name__)


def create_exchange_rates_table():
    """Create the exchange_rates table."""
    engine = create_engine(DATABASE_URL)

    create_table_sql = """
                       CREATE TABLE IF NOT EXISTS exchange_rates
                       (
                           id
                           INTEGER
                           PRIMARY
                           KEY
                           AUTOINCREMENT,
                           currency_code
                           VARCHAR
                       (
                           3
                       ) NOT NULL,
                           rate_to_eur DECIMAL
                       (
                           20,
                           10
                       ) NOT NULL,
                           rate_date DATE NOT NULL,
                           is_latest BOOLEAN DEFAULT 0,
                           fetched_at DATETIME NOT NULL DEFAULT
                       (
                           datetime
                       (
                           'now',
                           'utc'
                       )),
                           updated_at DATETIME,
                           CONSTRAINT uq_currency_date UNIQUE
                       (
                           currency_code,
                           rate_date
                       )
                           ); \
                       """

    create_indexes_sql = [
        "CREATE INDEX IF NOT EXISTS idx_exchange_rates_currency_code ON exchange_rates(currency_code);",
        "CREATE INDEX IF NOT EXISTS idx_exchange_rates_rate_date ON exchange_rates(rate_date);",
        "CREATE INDEX IF NOT EXISTS idx_exchange_rates_is_latest ON exchange_rates(is_latest);"
    ]

    try:
        with engine.connect() as conn:
            # Create table
            conn.execute(text(create_table_sql))
            logger.info("Created exchange_rates table")

            # Create indexes
            for index_sql in create_indexes_sql:
                conn.execute(text(index_sql))

            logger.info("Created indexes for exchange_rates table")
            conn.commit()

        logger.info("Migration completed successfully")
        return True

    except Exception as e:
        logger.error(f"Migration failed: {e}", exc_info=True)
        return False


if __name__ == "__main__":
    print("Creating exchange_rates table...")
    success = create_exchange_rates_table()
    if success:
        print("✓ Migration completed successfully")
    else:
        print("✗ Migration failed")
