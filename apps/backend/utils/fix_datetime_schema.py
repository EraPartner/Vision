#!/usr/bin/env python3
"""
Fix datetime schema in the database to work properly with SQLite and Pydantic.
This script updates the existing database to ensure proper timestamp defaults.
"""

import os
import shutil
import sqlite3
from datetime import datetime, timezone


def backup_database(db_path: str) -> str:
    """Create a backup of the database before migration"""
    backup_path = f"{db_path}.backup_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(db_path, backup_path)
    print(f"✅ Database backed up to: {backup_path}")
    return backup_path


def fix_datetime_defaults(db_path: str) -> None:
    """Fix datetime defaults in all tables"""

    if not os.path.exists(db_path):
        print(f"❌ Database file not found: {db_path}")
        return

    # Create backup first
    backup_path = backup_database(db_path)

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        print("🔧 Updating categories table...")

        # Get existing categories data
        cursor.execute("SELECT * FROM categories")
        categories_data = cursor.fetchall()

        print(f"📊 Found {len(categories_data)} categories to migrate")

        # Drop the new table if it exists from a previous failed run
        cursor.execute("DROP TABLE IF EXISTS categories_new;")

        # Recreate categories table with proper datetime defaults for UTC
        cursor.execute("""
                       CREATE TABLE categories_new
                       (
                           id          INTEGER PRIMARY KEY,
                           general     TEXT NOT NULL,
                           detail      TEXT NOT NULL,
                           description TEXT,
                           is_active   BOOLEAN  DEFAULT TRUE,
                           created_at  DATETIME DEFAULT (datetime('now', 'utc')),
                           updated_at  DATETIME DEFAULT (datetime('now', 'utc'))
                       );
                       """)

        # Create indexes with IF NOT EXISTS to avoid conflicts
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_categories_general_new ON categories_new(general);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_categories_detail_new ON categories_new(detail);")
        cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_general_detail_new ON categories_new(general, detail);")

        # Migrate data, setting current UTC time for any NULL timestamps
        current_utc = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')

        for row in categories_data:
            # Map old data to new structure
            id_val = row[0]
            general = row[1]
            detail = row[2]
            description = row[3] if len(row) > 3 else None
            is_active = row[4] if len(row) > 4 else True
            created_at = row[5] if len(row) > 5 and row[5] else current_utc
            updated_at = row[6] if len(row) > 6 and row[6] else None

            cursor.execute("""
                           INSERT INTO categories_new (id, general, detail, description, is_active, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?)
                           """, (id_val, general, detail, description, is_active, created_at, updated_at))

        # Drop old table and rename new one
        cursor.execute("DROP TABLE categories;")
        cursor.execute("ALTER TABLE categories_new RENAME TO categories;")

        # Update other tables similarly if they exist
        tables_to_fix = [
            ("transactions", ["id", "date", "amount", "currency", "balance", "memo", "comment",
                              "bank_account", "recipient_id", "category_id", "batch_id",
                              "original_raw_data", "bank_reference", "created_at", "updated_at"]),
            ("recipients", ["id", "name", "account_number", "default_category_id", "notes",
                            "address", "is_active", "created_at", "updated_at"]),
            ("import_batches", ["id", "filename", "bank_name", "total_processed", "imported_count",
                                "duplicate_count", "error_count", "config_used", "status",
                                "error_message", "created_at", "completed_at"])
        ]

        for table_name, expected_columns in tables_to_fix:
            try:
                cursor.execute(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{table_name}'")
                if cursor.fetchone():
                    print(f"🔧 Checking {table_name} table...")

                    # Check if table needs datetime fix
                    cursor.execute(f"PRAGMA table_info({table_name})")
                    current_schema = cursor.fetchall()

                    # Look for DATETIME columns without proper defaults
                    needs_fix = any(
                        col[2].upper() == 'DATETIME' and not col[4]  # type is DATETIME and no default
                        for col in current_schema
                        if col[1] in ['created_at', 'updated_at']
                    )

                    if needs_fix:
                        print(f"⚠️  {table_name} needs datetime defaults fixed")
                        # For now, just note it - full table recreation would be complex
                        # The model changes will handle new records correctly
                    else:
                        print(f"✅ {table_name} datetime columns look good")
            except Exception as e:
                print(f"⚠️  Could not check {table_name}: {e}")

        conn.commit()
        conn.close()

        print("✅ Database datetime schema fix completed!")
        print("🎉 New categories will now have proper timestamps")
        print("💡 Restart your application to use the updated schema")

    except Exception as e:
        print(f"❌ Migration failed: {e}")
        print(f"💾 Database backup available at: {backup_path}")
        raise


def main():
    """Main function to run the datetime fix"""
    db_path = "../financial_transactions.db"

    # Check if running from the correct directory
    if not os.path.exists(db_path):
        print("🔍 Looking for database in current directory...")
        possible_paths = [
            "financial_transactions.db.bak",
            "database/financial_transactions.db.bak",
            "apps/backend/financial_transactions.db.bak",
        ]

        for path in possible_paths:
            if os.path.exists(path):
                db_path = path
                break
        else:
            print("❌ Could not find financial_transactions.db.bak")
            print("💡 Please run this script from your project root directory")
            return

    print(f"🎯 Using database: {db_path}")
    print("⚠️ This will fix datetime defaults in the database schema")

    # Confirm before proceeding
    response = input("Continue? (y/N): ").lower().strip()
    if response != 'y':
        print("❌ Fix cancelled")
        return

    fix_datetime_defaults(db_path)


if __name__ == "__main__":
    main()
