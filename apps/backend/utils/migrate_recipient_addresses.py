"""
Migration script to extract addresses from recipient names.

This script parses recipient names that contain commas, extracts the address
portion (everything after the first comma), and stores it in the address field.
The recipient name is updated to only contain the part before the comma.

Usage:
    python utils/migrate_recipient_addresses.py
"""
import sys
from pathlib import Path

# Add parent directory to path to import modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from config.logging_config import setup_logging
from database.models import Recipient

logger = setup_logging(__name__)


def migrate_recipient_addresses(db_path: str = 'financial_transactions.db', dry_run: bool = False):
    """
    Migrate recipient addresses from names to address field.

    Args:
        db_path: Path to the SQLite database file
        dry_run: If True, only show what would be changed without committing
    """
    engine = create_engine(f'sqlite:///{db_path}')
    Session = sessionmaker(bind=engine)
    session = Session()

    try:
        # Find all recipients with commas in their names
        recipients_with_commas = session.query(Recipient).filter(
            Recipient.name.like('%,%')
        ).all()

        logger.info(f"Found {len(recipients_with_commas)} recipients with commas in their names")
        print(f"\nFound {len(recipients_with_commas)} recipients with commas in their names\n")

        updated_count = 0
        skipped_count = 0

        for recipient in recipients_with_commas:
            # Split on first comma
            parts = recipient.name.split(',', 1)

            if len(parts) != 2:
                logger.warning(f"Recipient ID {recipient.id} has unexpected comma structure: {recipient.name}")
                skipped_count += 1
                continue

            name_part = parts[0].strip()
            address_part = parts[1].strip()

            # Skip if address part is empty
            if not address_part:
                logger.warning(f"Recipient ID {recipient.id} has empty address part: {recipient.name}")
                skipped_count += 1
                continue

            # Show what will be changed
            print(f"ID {recipient.id}:")
            print(f"  Current name: \"{recipient.name}\"")
            print(f"  Current address: {recipient.address}")
            print(f"  → New name: \"{name_part}\"")
            print(f"  → New address: \"{address_part}\"")

            # Only update if recipient doesn't already have an address
            if recipient.address:
                print(f"  ⚠ SKIPPING - Already has address: \"{recipient.address}\"")
                skipped_count += 1
            else:
                if not dry_run:
                    recipient.name = name_part
                    recipient.address = address_part
                    updated_count += 1
                    print(f"  ✓ UPDATED")
                else:
                    updated_count += 1
                    print(f"  ✓ WOULD UPDATE (dry run)")

            print()

        if not dry_run:
            session.commit()
            logger.info(f"Migration completed: {updated_count} recipients updated, {skipped_count} skipped")
            print(f"\n✓ Migration completed successfully!")
            print(f"  Updated: {updated_count} recipients")
            print(f"  Skipped: {skipped_count} recipients")
        else:
            session.rollback()
            print(f"\n✓ Dry run completed!")
            print(f"  Would update: {updated_count} recipients")
            print(f"  Would skip: {skipped_count} recipients")
            print(f"\nRun without --dry-run to apply changes")

    except Exception as e:
        session.rollback()
        logger.error(f"Migration failed: {str(e)}", exc_info=True)
        print(f"\n✗ Migration failed: {str(e)}")
        raise
    finally:
        session.close()


if __name__ == "__main__":
    import sys

    dry_run = '--dry-run' in sys.argv

    if dry_run:
        print("=" * 70)
        print("DRY RUN MODE - No changes will be committed")
        print("=" * 70)

    migrate_recipient_addresses(dry_run=dry_run)
