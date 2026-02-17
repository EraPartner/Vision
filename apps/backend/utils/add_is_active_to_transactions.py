#!/usr/bin/env python3
"""
Add is_active column to transactions table for soft deletion support.

This migration adds the is_active boolean field to the transactions table,
following the same pattern used in categories and recipients tables.
"""

import os
import shutil
import sqlite3
from datetime import datetime, timezone


def backup_database(db_path: str) -> str:
    """Create a backup of the database before migration.

    Args:
        db_path: Path to the database file

    Returns:
        Path to the backup file
    """
    backup_path = f"{db_path}.backup_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(db_path, backup_path)
    print(f"✅ Database backed up to: {backup_path}")
    return backup_path


def add_is_active_to_transactions(db_path: str) -> None:
    """Add is_active column to transactions table.

    Args:
        db_path: Path to the database file
    """
    if not os.path.exists(db_path):
        print(f"❌ Database file not found: {db_path}")
        return

    # Create backup first
    backup_path = backup_database(db_path)

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        print("🔧 Adding is_active column to transactions table...")

        # Check if column already exists
        cursor.execute("PRAGMA table_info(transactions)")
        columns = [row[1] for row in cursor.fetchall()]

        if 'is_active' in columns:
            print("⚠️  is_active column already exists in transactions table")
            conn.close()
            return

        # Add is_active column with default value of TRUE
        cursor.execute("""
                       ALTER TABLE transactions
                           ADD COLUMN is_active BOOLEAN DEFAULT TRUE NOT NULL
                       """)

        # Update all existing transactions to be active
        cursor.execute("""
                       UPDATE transactions
                       SET is_active = TRUE
                       WHERE is_active IS NULL
                       """)

        # Get count of updated records
        cursor.execute("SELECT COUNT(*) FROM transactions")
        total_count = cursor.fetchone()[0]

        conn.commit()

        print(f"✅ Successfully added is_active column to transactions table")
        print(f"✅ Updated {total_count} existing transactions to is_active=TRUE")
        print(f"✅ Migration completed successfully!")

        conn.close()

    except Exception as e:
        print(f"❌ Migration failed: {e}")
        print(f"💾 Database backup available at: {backup_path}")
        raise


def main():
    """Main migration entry point."""
    # Determine database path
    script_dir = os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.dirname(script_dir)
    db_path = os.path.join(backend_dir, "financial_transactions.db")

    print("=" * 60)
    print("Transaction Soft Deletion Migration")
    print("=" * 60)
    print(f"Database: {db_path}")
    print()

    if not os.path.exists(db_path):
        print(f"❌ Database not found at: {db_path}")
        print("Please ensure the database exists before running this migration.")
        return

    # Confirm migration
    response = input("Proceed with migration? (yes/no): ").strip().lower()
    if response not in ['yes', 'y']:
        print("❌ Migration cancelled")
        return

    # Run migration
    add_is_active_to_transactions(db_path)


if __name__ == "__main__":
    main()
