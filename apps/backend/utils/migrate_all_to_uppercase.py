"""
Migration script to normalize all text fields to uppercase.

This script normalizes all text fields in the database to uppercase for consistency,
EXCEPT for transaction comment fields which should preserve their original case.

Fields normalized:
- Recipients: name, address
- Categories: general, detail
- Transactions: memo, currency, bank_account (NOT comment)
- PlannedTransactions: memo, currency, bank_account (NOT comment)

Usage:
    python utils/migrate_all_to_uppercase.py [--dry-run]
"""
import sys
from pathlib import Path

# Add parent directory to path to import modules
sys.path.insert(0, str(Path(__file__).parent.parent))

import re
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database.models import Recipient, Category, Transaction, PlannedTransaction
from services.text_normalization_service import TextNormalizationService
from config.logging_config import setup_logging

logger = setup_logging(__name__)


def is_url(text: str) -> bool:
    """Check if text appears to be a URL."""
    if not text:
        return False
    text_lower = text.lower()
    # Check for common URL patterns
    return (text_lower.startswith('http://') or
            text_lower.startswith('https://') or
            text_lower.startswith('www.') or
            '://' in text or
            re.match(r'^[a-z0-9-]+\.[a-z]{2,}', text_lower))  # domain.tld pattern


def normalize_text_preserving_urls(text: str) -> str:
    """Normalize text to uppercase but preserve URLs."""
    if not text:
        return text

    # Check if entire string is a URL
    if is_url(text):
        return text

    # Check for URLs within the text
    # Pattern matches: www.example.com, http://example.com, example.com/path
    url_pattern = r'((?:https?://)?(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:/[^\s]*)?)'

    # Find all URLs in the text
    urls = re.findall(url_pattern, text, re.IGNORECASE)

    if not urls:
        # No URLs found, normalize normally
        return TextNormalizationService.normalize_recipient_name(text)

    # Replace URLs with placeholders, normalize, then restore URLs
    placeholder_map = {}
    modified_text = text
    for i, url in enumerate(urls):
        placeholder = f"__URL_PLACEHOLDER_{i}__"
        placeholder_map[placeholder] = url
        modified_text = modified_text.replace(url, placeholder)

    # Normalize the text with placeholders
    normalized = TextNormalizationService.normalize_recipient_name(modified_text)

    # Restore original URLs
    for placeholder, url in placeholder_map.items():
        normalized = normalized.replace(placeholder, url)

    return normalized


def migrate_recipients(session, dry_run: bool = False):
    """Migrate recipient names and addresses to uppercase."""
    print("\n" + "=" * 70)
    print("MIGRATING RECIPIENTS")
    print("=" * 70)

    recipients = session.query(Recipient).all()
    updated_count = 0

    for recipient in recipients:
        changed = False
        old_name = recipient.name
        old_address = recipient.address

        # Normalize name (preserving URLs)
        if recipient.name:
            normalized_name = normalize_text_preserving_urls(recipient.name)
            if normalized_name != recipient.name:
                if not dry_run:
                    recipient.name = normalized_name
                changed = True
                print(f"ID {recipient.id} name: \"{old_name}\" → \"{normalized_name}\"")

        # Normalize address (preserving URLs)
        if recipient.address:
            normalized_address = normalize_text_preserving_urls(recipient.address)
            if normalized_address != recipient.address:
                if not dry_run:
                    recipient.address = normalized_address
                changed = True
                print(f"ID {recipient.id} address: \"{old_address}\" → \"{normalized_address}\"")

        if changed:
            updated_count += 1

    if not dry_run:
        session.flush()

    print(f"\n{'Would update' if dry_run else 'Updated'}: {updated_count} recipients")
    return updated_count


def migrate_categories(session, dry_run: bool = False):
    """Migrate category general and detail to uppercase."""
    print("\n" + "=" * 70)
    print("MIGRATING CATEGORIES")
    print("=" * 70)

    categories = session.query(Category).all()
    updated_count = 0

    for category in categories:
        changed = False
        old_general = category.general
        old_detail = category.detail

        # Normalize general
        if category.general:
            normalized_general = TextNormalizationService.normalize_category_name(category.general)
            if normalized_general != category.general:
                if not dry_run:
                    category.general = normalized_general
                changed = True
                print(f"ID {category.id} general: \"{old_general}\" → \"{normalized_general}\"")

        # Normalize detail
        if category.detail:
            normalized_detail = TextNormalizationService.normalize_category_name(category.detail)
            if normalized_detail != category.detail:
                if not dry_run:
                    category.detail = normalized_detail
                changed = True
                print(f"ID {category.id} detail: \"{old_detail}\" → \"{normalized_detail}\"")

        if changed:
            updated_count += 1

    if not dry_run:
        session.flush()

    print(f"\n{'Would update' if dry_run else 'Updated'}: {updated_count} categories")
    return updated_count


def migrate_transactions(session, dry_run: bool = False):
    """Migrate transaction memo, currency, bank_account to uppercase (NOT comment)."""
    print("\n" + "=" * 70)
    print("MIGRATING TRANSACTIONS")
    print("=" * 70)

    transactions = session.query(Transaction).all()
    updated_count = 0

    for transaction in transactions:
        changed = False

        # Normalize memo
        if transaction.memo:
            normalized_memo = TextNormalizationService.normalize_recipient_name(transaction.memo)
            if normalized_memo != transaction.memo:
                if not dry_run:
                    transaction.memo = normalized_memo
                changed = True

        # Normalize currency
        if transaction.currency:
            normalized_currency = transaction.currency.strip().upper()
            if normalized_currency != transaction.currency:
                if not dry_run:
                    transaction.currency = normalized_currency
                changed = True

        # Normalize bank_account
        if transaction.bank_account:
            normalized_bank_account = TextNormalizationService.normalize_recipient_name(transaction.bank_account)
            if normalized_bank_account != transaction.bank_account:
                if not dry_run:
                    transaction.bank_account = normalized_bank_account
                changed = True

        # NOTE: We do NOT normalize transaction.comment - it preserves original case

        if changed:
            updated_count += 1
            if updated_count <= 5:  # Show first 5 examples
                print(f"Updated transaction ID {transaction.id}")

    if not dry_run:
        session.flush()

    print(f"\n{'Would update' if dry_run else 'Updated'}: {updated_count} transactions")
    return updated_count


def migrate_planned_transactions(session, dry_run: bool = False):
    """Migrate planned transaction memo, currency, bank_account to uppercase (NOT comment)."""
    print("\n" + "=" * 70)
    print("MIGRATING PLANNED TRANSACTIONS")
    print("=" * 70)

    planned_transactions = session.query(PlannedTransaction).all()
    updated_count = 0

    for pt in planned_transactions:
        changed = False

        # Normalize memo
        if pt.memo:
            normalized_memo = TextNormalizationService.normalize_recipient_name(pt.memo)
            if normalized_memo != pt.memo:
                if not dry_run:
                    pt.memo = normalized_memo
                changed = True

        # Normalize currency
        if pt.currency:
            normalized_currency = pt.currency.strip().upper()
            if normalized_currency != pt.currency:
                if not dry_run:
                    pt.currency = normalized_currency
                changed = True

        # Normalize bank_account
        if pt.bank_account:
            normalized_bank_account = TextNormalizationService.normalize_recipient_name(pt.bank_account)
            if normalized_bank_account != pt.bank_account:
                if not dry_run:
                    pt.bank_account = normalized_bank_account
                changed = True

        # NOTE: We do NOT normalize pt.comment - it preserves original case

        if changed:
            updated_count += 1

    if not dry_run:
        session.flush()

    print(f"\n{'Would update' if dry_run else 'Updated'}: {updated_count} planned transactions")
    return updated_count


def migrate_all_to_uppercase(db_path: str = 'financial_transactions.db', dry_run: bool = False):
    """
    Migrate all text fields to uppercase except transaction comments.

    Args:
        db_path: Path to the SQLite database file
        dry_run: If True, only show what would be changed without committing
    """
    engine = create_engine(f'sqlite:///{db_path}')
    Session = sessionmaker(bind=engine)
    session = Session()

    try:
        print("=" * 70)
        print("UPPERCASE MIGRATION SCRIPT")
        print("=" * 70)
        print("\nNormalizing all text fields to UPPERCASE")
        print("EXCEPTION: Transaction and PlannedTransaction 'comment' fields")
        print("           will preserve their original case")
        print()

        total_updated = 0

        # Migrate each entity type
        total_updated += migrate_recipients(session, dry_run)
        total_updated += migrate_categories(session, dry_run)
        total_updated += migrate_transactions(session, dry_run)
        total_updated += migrate_planned_transactions(session, dry_run)

        # Commit changes
        if not dry_run:
            session.commit()
            print("\n" + "=" * 70)
            print("✓ Migration completed successfully!")
            print(f"  Total records updated: {total_updated}")
            print("=" * 70)
            logger.info(f"Uppercase migration completed: {total_updated} records updated")
        else:
            session.rollback()
            print("\n" + "=" * 70)
            print("✓ Dry run completed!")
            print(f"  Would update: {total_updated} records")
            print("\nRun without --dry-run to apply changes")
            print("=" * 70)

    except Exception as e:
        session.rollback()
        logger.error(f"Migration failed: {str(e)}", exc_info=True)
        print(f"\n✗ Migration failed: {str(e)}")
        raise
    finally:
        session.close()


if __name__ == "__main__":
    dry_run = '--dry-run' in sys.argv

    if dry_run:
        print("=" * 70)
        print("DRY RUN MODE - No changes will be committed")
        print("=" * 70)
        print()

    migrate_all_to_uppercase(dry_run=dry_run)
