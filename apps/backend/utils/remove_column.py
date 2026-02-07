#!/usr/bin/env python3
"""
Database migration script to remove the colour/color column from the categories table.
This script safely recreates the table structure without the colour column while preserving all data.
"""

import os
import shutil
import sqlite3
from datetime import datetime


def backup_database(db_path: str) -> str:
    """Create a backup of the database before migration"""
    backup_path = f"{db_path}.backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(db_path, backup_path)
    print(f"✅ Database backed up to: {backup_path}")
    return backup_path


def remove_colour_column(db_path: str) -> None:
    """Remove the colour/color column from the categories table"""

    if not os.path.exists(db_path):
        print(f"❌ Database file not found: {db_path}")
        return

    # Create backup first
    backup_path = backup_database(db_path)

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()

        # Check if the table exists and get current structure
        cursor.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='categories';")
        result = cursor.fetchone()

        if not result:
            print("❌ Categories table not found in database")
            return

        print("📊 Current table structure:")
        print(result[0])

        # Get current data
        cursor.execute("SELECT COUNT(*) FROM categories")
        row_count = cursor.fetchone()[0]
        print(f"📈 Found {row_count} records to migrate")

        # Create new table without colour column
        create_new_table_sql = """
                               CREATE TABLE categories_new
                               (
                                   id          INTEGER PRIMARY KEY,
                                   general     TEXT NOT NULL,
                                   detail      TEXT NOT NULL,
                                   description TEXT,
                                   is_active   BOOLEAN DEFAULT TRUE,
                                   created_at  DATETIME,
                                   updated_at  DATETIME
                               ); \
                               """

        print("🔧 Creating new table structure...")
        cursor.execute(create_new_table_sql)

        # Copy data from old table to new table (excluding colour column)
        copy_data_sql = """
                        INSERT INTO categories_new (id, general, detail, description, is_active, created_at, updated_at)
                        SELECT id, general, detail, description, is_active, created_at, updated_at
                        FROM categories; \
                        """

        print("📋 Migrating data...")
        cursor.execute(copy_data_sql)

        # Drop the old table
        print("🗑️ Removing old table...")
        cursor.execute("DROP TABLE categories;")

        # Rename the new table
        print("🔄 Renaming new table...")
        cursor.execute("ALTER TABLE categories_new RENAME TO categories;")

        # Recreate indexes
        print("🔍 Creating indexes...")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_categories_general ON categories(general);")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_categories_detail ON categories(detail);")

        # Verify the migration
        cursor.execute("SELECT COUNT(*) FROM categories")
        new_row_count = cursor.fetchone()[0]

        cursor.execute("PRAGMA table_info(categories);")
        columns = cursor.fetchall()

        conn.commit()
        conn.close()

        print("✅ Migration completed successfully!")
        print(f"📊 Records migrated: {new_row_count}")
        print("🏗️ New table structure:")
        for col in columns:
            print(f"  - {col[1]} ({col[2]})")
        # Verify no colour column exists
        column_names = [col[1] for col in columns]
        if 'colour' not in column_names and 'color' not in column_names:
            print("✅ Confirmed: No colour/color column in new table")
        else:
            print("⚠️ Warning: colour/color column still exists")

    except Exception as e:
        print(f"❌ Migration failed: {e}")
        print(f"💾 Database backup available at: {backup_path}")
        raise


def main():
    """Main function to run the migration"""
    # Update this path to match your database location
    db_path = "/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend/financial_transactions.db"

    # Check if running from the correct directory
    if not os.path.exists(db_path):
        print("🔍 Looking for database in current directory...")
        # Try common locations
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
            print("💡 Or update the db_path variable in this script")
            return

    print(f"🎯 Using database: {db_path}")
    print("⚠️ This will remove the colour/color column from the categories table")

    # Confirm before proceeding
    response = input("Continue? (y/N): ").lower().strip()
    if response != 'y':
        print("❌ Migration cancelled")
        return

    remove_colour_column(db_path)
    print("🎉 Migration complete! You can now start your application.")


if __name__ == "__main__":
    main()
