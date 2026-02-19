"""Database migration: Add recipient bank accounts many-to-many relationship.

This migration creates the recipient_bank_accounts junction table and adds
the normalized_name column to recipients for intelligent name matching.

Changes:
1. Add normalized_name column to recipients table (for matching "JOHN SMITH" vs "SMITH JOHN")
2. Create recipient_bank_accounts junction table
3. Add recipient_bank_account_id to transactions (optional FK)

This enables:
- One recipient to have multiple bank accounts
- Prevents duplicates when banks format names differently
- Maintains address per bank account instead of per recipient
"""
import sqlite3
import sys
from pathlib import Path

# Add parent directory to path to import database models
sys.path.insert(0, str(Path(__file__).parent.parent))

from config.logging_config import setup_logging
from services.text_normalization_service import TextNormalizationService

logger = setup_logging(__name__)


def migrate_database(db_path: str = "financial_transactions.db"):
    """Run the migration to add recipient bank accounts support.

    Args:
        db_path: Path to SQLite database file
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        logger.info("Starting recipient bank accounts migration...")

        # Step 1: Add normalized_name column to recipients
        logger.info("Adding normalized_name column to recipients...")
        try:
            cursor.execute("""
                           ALTER TABLE recipients
                               ADD COLUMN normalized_name TEXT
                           """)
            logger.info("✓ Added normalized_name column")
        except sqlite3.OperationalError as e:
            if "duplicate column name" in str(e):
                logger.warning("normalized_name column already exists, skipping")
            else:
                raise

        # Step 2: Populate normalized_name for existing recipients
        logger.info("Populating normalized_name for existing recipients...")
        cursor.execute("SELECT id, name FROM recipients")
        recipients = cursor.fetchall()

        for recipient_id, name in recipients:
            if name:
                normalized = TextNormalizationService.normalize_name_for_matching(name)
                cursor.execute(
                    "UPDATE recipients SET normalized_name = ? WHERE id = ?",
                    (normalized, recipient_id)
                )

        logger.info(f"✓ Updated {len(recipients)} recipients with normalized names")

        # Step 3: Create unique index on normalized_name
        logger.info("Creating unique index on normalized_name...")
        try:
            cursor.execute("""
                           CREATE UNIQUE INDEX idx_recipients_normalized_name
                               ON recipients (normalized_name)
                           """)
            logger.info("✓ Created unique index on normalized_name")
        except sqlite3.OperationalError as e:
            if "already exists" in str(e):
                logger.warning("Index already exists, skipping")
            else:
                raise

        # Step 4: Create recipient_bank_accounts table
        logger.info("Creating recipient_bank_accounts table...")
        cursor.execute("""
                       CREATE TABLE IF NOT EXISTS recipient_bank_accounts
                       (
                           id
                           INTEGER
                           PRIMARY
                           KEY
                           AUTOINCREMENT,
                           recipient_id
                           INTEGER
                           NOT
                           NULL,
                           account_number
                           TEXT
                           NOT
                           NULL
                           UNIQUE,
                           bank_name
                           TEXT,
                           account_label
                           TEXT,
                           address
                           TEXT,
                           is_primary
                           BOOLEAN
                           NOT
                           NULL
                           DEFAULT
                           0,
                           is_active
                           BOOLEAN
                           NOT
                           NULL
                           DEFAULT
                           1,
                           created_at
                           DATETIME
                           DEFAULT
                           CURRENT_TIMESTAMP,
                           updated_at
                           DATETIME,
                           FOREIGN
                           KEY
                       (
                           recipient_id
                       ) REFERENCES recipients
                       (
                           id
                       ) ON DELETE CASCADE
                           )
                       """)
        logger.info("✓ Created recipient_bank_accounts table")

        # Step 5: Create indexes for recipient_bank_accounts
        logger.info("Creating indexes for recipient_bank_accounts...")
        try:
            cursor.execute("""
                           CREATE INDEX idx_recipient_bank_accounts_recipient
                               ON recipient_bank_accounts (recipient_id)
                           """)
            cursor.execute("""
                           CREATE UNIQUE INDEX idx_recipient_bank_accounts_account
                               ON recipient_bank_accounts (account_number)
                           """)
            logger.info("✓ Created indexes for recipient_bank_accounts")
        except sqlite3.OperationalError as e:
            if "already exists" in str(e):
                logger.warning("Indexes already exist, skipping")
            else:
                raise

        # Step 6: Migrate existing account numbers to junction table
        logger.info("Migrating existing account numbers to junction table...")
        cursor.execute("""
                       SELECT id, account_number, address
                       FROM recipients
                       WHERE account_number IS NOT NULL
                         AND account_number != ''
                       """)
        recipients_with_accounts = cursor.fetchall()

        migrated_count = 0
        for recipient_id, account_number, address in recipients_with_accounts:
            # Check if already migrated
            cursor.execute(
                "SELECT COUNT(*) FROM recipient_bank_accounts WHERE account_number = ?",
                (account_number,)
            )
            exists = cursor.fetchone()[0] > 0

            if not exists:
                # Determine bank name from account number pattern (basic heuristic)
                bank_name = None
                if account_number.startswith("BE"):
                    bank_name = "BELGIAN BANK"
                elif account_number.startswith("NL"):
                    bank_name = "DUTCH BANK"

                cursor.execute("""
                               INSERT INTO recipient_bank_accounts
                               (recipient_id, account_number, bank_name, address, is_primary, is_active)
                               VALUES (?, ?, ?, ?, 1, 1)
                               """, (recipient_id, account_number, bank_name, address))
                migrated_count += 1

        logger.info(f"✓ Migrated {migrated_count} account numbers to junction table")

        # Step 7: Add recipient_bank_account_id to transactions
        logger.info("Adding recipient_bank_account_id column to transactions...")
        try:
            cursor.execute("""
                           ALTER TABLE transactions
                               ADD COLUMN recipient_bank_account_id INTEGER
                                   REFERENCES recipient_bank_accounts (id) ON DELETE SET NULL
                           """)
            logger.info("✓ Added recipient_bank_account_id column")
        except sqlite3.OperationalError as e:
            if "duplicate column name" in str(e):
                logger.warning("recipient_bank_account_id column already exists, skipping")
            else:
                raise

        # Step 8: Create index for recipient_bank_account_id
        logger.info("Creating index for transactions.recipient_bank_account_id...")
        try:
            cursor.execute("""
                           CREATE INDEX idx_transactions_recipient_bank_account
                               ON transactions (recipient_bank_account_id)
                           """)
            logger.info("✓ Created index on transactions.recipient_bank_account_id")
        except sqlite3.OperationalError as e:
            if "already exists" in str(e):
                logger.warning("Index already exists, skipping")
            else:
                raise

        # Commit all changes
        conn.commit()
        logger.info("=" * 60)
        logger.info("Migration completed successfully!")
        logger.info("=" * 60)

        # Print summary
        cursor.execute("SELECT COUNT(*) FROM recipients")
        total_recipients = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM recipient_bank_accounts")
        total_bank_accounts = cursor.fetchone()[0]

        logger.info(f"Total recipients: {total_recipients}")
        logger.info(f"Total bank accounts: {total_bank_accounts}")
        logger.info(
            f"Average accounts per recipient: {total_bank_accounts / total_recipients if total_recipients > 0 else 0:.2f}")

    except Exception as e:
        logger.error(f"Migration failed: {e}")
        conn.rollback()
        raise
    finally:
        conn.close()


def verify_migration(db_path: str = "financial_transactions.db"):
    """Verify the migration was successful.

    Args:
        db_path: Path to SQLite database file
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        logger.info("\nVerifying migration...")

        # Check normalized_name column exists
        cursor.execute("PRAGMA table_info(recipients)")
        columns = [col[1] for col in cursor.fetchall()]
        assert "normalized_name" in columns, "normalized_name column missing!"
        logger.info("✓ normalized_name column exists")

        # Check recipient_bank_accounts table exists
        cursor.execute("""
                       SELECT name
                       FROM sqlite_master
                       WHERE type = 'table'
                         AND name = 'recipient_bank_accounts'
                       """)
        assert cursor.fetchone() is not None, "recipient_bank_accounts table missing!"
        logger.info("✓ recipient_bank_accounts table exists")

        # Check recipient_bank_account_id column in transactions
        cursor.execute("PRAGMA table_info(transactions)")
        columns = [col[1] for col in cursor.fetchall()]
        assert "recipient_bank_account_id" in columns, "recipient_bank_account_id column missing!"
        logger.info("✓ recipient_bank_account_id column exists in transactions")

        # Check normalized_name is populated
        cursor.execute("SELECT COUNT(*) FROM recipients WHERE normalized_name IS NULL")
        null_count = cursor.fetchone()[0]
        if null_count > 0:
            logger.warning(f"⚠ {null_count} recipients have NULL normalized_name")
        else:
            logger.info("✓ All recipients have normalized_name populated")

        logger.info("\n✓ Migration verification passed!")

    finally:
        conn.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Migrate database to support recipient bank accounts")
    parser.add_argument(
        "--db-path",
        default="financial_transactions.db",
        help="Path to SQLite database file (default: financial_transactions.db)"
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Only verify migration, don't run it"
    )

    args = parser.parse_args()

    if args.verify_only:
        verify_migration(args.db_path)
    else:
        migrate_database(args.db_path)
        verify_migration(args.db_path)
