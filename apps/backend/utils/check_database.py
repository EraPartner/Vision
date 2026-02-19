#!/usr/bin/env python3
"""Check which database is being loaded."""

import os

from sqlalchemy import inspect

from database.connection import DATABASE_URL, BACKEND_DIR, engine
from database.models import Recipient

print("=" * 80)
print("DATABASE CONNECTION DIAGNOSTIC")
print("=" * 80)

print(f"\nBackend directory: {BACKEND_DIR}")
print(f"Database URL from config: {DATABASE_URL}")

# Extract actual file path for SQLite
if DATABASE_URL.startswith("sqlite:///"):
    db_path = DATABASE_URL.replace("sqlite:///", "")
    print(f"Database file path: {db_path}")
    print(f"Database file exists: {os.path.exists(db_path)}")
    if os.path.exists(db_path):
        file_size = os.path.getsize(db_path)
        print(f"Database file size: {file_size:,} bytes ({file_size / 1024 / 1024:.2f} MB)")

        # Check modification time
        import datetime

        mtime = os.path.getmtime(db_path)
        mod_time = datetime.datetime.fromtimestamp(mtime)
        print(f"Last modified: {mod_time}")
    else:
        print("⚠️  WARNING: Database file does not exist!")
else:
    print(f"Using non-SQLite database: {DATABASE_URL[:50]}...")

# Check if we can connect
print("\nTesting connection...")
try:
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    print(f"✓ Connection successful!")
    print(f"  Tables found: {', '.join(tables)}")

    # Count recipients
    from database.connection import SessionLocal

    db = SessionLocal()
    try:
        recipient_count = db.query(Recipient).count()
        active_count = db.query(Recipient).filter(Recipient.is_active == True).count()
        print(f"\n  Recipients in database:")
        print(f"    Total: {recipient_count}")
        print(f"    Active: {active_count}")
        print(f"    Inactive: {recipient_count - active_count}")

        # Show first few recipients
        first_5 = db.query(Recipient).limit(5).all()
        print(f"\n  First 5 recipients:")
        for r in first_5:
            print(f"    ID {r.id}: {r.name[:40]} (active={r.is_active})")
    finally:
        db.close()

except Exception as e:
    print(f"✗ Connection failed: {e}")

# Check for other potential database files
print("\n" + "=" * 80)
print("CHECKING FOR OTHER DATABASE FILES")
print("=" * 80)

db_files = []
for root, dirs, files in os.walk(BACKEND_DIR):
    for file in files:
        if file.endswith('.db'):
            full_path = os.path.join(root, file)
            size = os.path.getsize(full_path)
            db_files.append((full_path, size))

if db_files:
    print(f"\nFound {len(db_files)} .db files in backend directory:")
    for path, size in sorted(db_files, key=lambda x: x[1], reverse=True):
        rel_path = os.path.relpath(path, BACKEND_DIR)
        size_mb = size / 1024 / 1024
        in_use = "← CURRENTLY IN USE" if path == db_path else ""
        print(f"  {rel_path}: {size:,} bytes ({size_mb:.2f} MB) {in_use}")
else:
    print("\nNo .db files found in backend directory.")

print("\n" + "=" * 80)
print("RECOMMENDATION")
print("=" * 80)

if DATABASE_URL.startswith("sqlite:///"):
    db_path = DATABASE_URL.replace("sqlite:///", "")
    if not os.path.exists(db_path):
        print("\n⚠️  The configured database file does not exist!")
        print(f"   Expected: {db_path}")
        if db_files:
            print(f"\n   Available database files:")
            for path, size in db_files:
                rel_path = os.path.relpath(path, BACKEND_DIR)
                print(f"     - {rel_path}")
            print(f"\n   Set DATABASE_URL environment variable to use a different file:")
            for path, size in db_files:
                print(f"     export DATABASE_URL='sqlite:///{path}'")
    else:
        print("\n✓ Database connection is correctly configured.")
        print(f"  Using: {db_path}")
