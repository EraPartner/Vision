#!/usr/bin/env python3
"""
Category Management Script

This script provides functions to efficiently manage hierarchical categories
for your financial transactions.

Usage:
    python category_script.py --help
"""

import argparse
import os
import sys
from datetime import datetime

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.connection import SessionLocal
from services.category_service import CategoryService
from database.models import Recipient


def import_categories_from_csv(csv_file: str, recipient_col: str = "Recipient", category_col: str = "Category"):
    """
    Import category mappings from CSV file

    Args:
        csv_file: Path to CSV file with recipient-category mappings
        recipient_col: Column name for recipients
        category_col: Column name for categories
    """
    print(f"\n{'=' * 70}")
    print(f"IMPORTING CATEGORY MAPPINGS FROM: {csv_file}")
    print(f"{'=' * 70}\n")

    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        # Import mappings
        result = cat_service.import_category_mappings_from_csv(
            file_path=csv_file,
            recipient_column=recipient_col,
            category_column=category_col,
            has_header=True
        )

        print(f"✓ Total processed: {result['total_processed']}")
        print(f"✓ Mappings created: {result['mappings_created']}")
        print(f"✓ Categories created: {result['categories_created']}")

        if result['recipients_not_found']:
            print(f"\n⚠️  Recipients not found ({len(result['recipients_not_found'])}):")
            for name in result['recipients_not_found'][:20]:
                print(f"    - {name}")
            if len(result['recipients_not_found']) > 20:
                print(f"    ... and {len(result['recipients_not_found']) - 20} more")

        if result['errors']:
            print(f"\n✗ Errors ({len(result['errors'])}):")
            for error in result['errors'][:10]:
                print(f"    - {error}")

        return result

    except Exception as e:
        print(f"\n✗ Error importing categories: {e}")
        import traceback
        traceback.print_exc()
        return None
    finally:
        db.close()


def apply_categories_to_transactions(recipient_id: int = None, overwrite: bool = False):
    """
    Apply recipient categories to their transactions

    Args:
        recipient_id: If specified, only apply for this recipient
        overwrite: If True, overwrite existing categories
    """
    print(f"\n{'=' * 70}")
    print(f"APPLYING CATEGORIES TO TRANSACTIONS")
    print(f"{'=' * 70}\n")

    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        result = cat_service.apply_recipient_categories_to_transactions(
            recipient_id=recipient_id,
            overwrite_existing=overwrite
        )

        print(f"✓ Transactions updated: {result['updated']}")
        print(f"✓ Transactions checked: {result['total_checked']}")

        return result

    except Exception as e:
        print(f"\n✗ Error applying categories: {e}")
        import traceback
        traceback.print_exc()
        return None
    finally:
        db.close()


def show_category_statistics():
    """Show comprehensive category statistics"""
    print(f"\n{'=' * 70}")
    print(f"CATEGORY STATISTICS")
    print(f"{'=' * 70}\n")

    db = SessionLocal()
    try:
        cat_service = CategoryService(db)
        stats = cat_service.get_category_statistics()

        print("📊 Categories:")
        print(f"   Total: {stats['total_categories']}")
        print(f"   General (parent): {stats['general_categories']}")
        print(f"   Detailed (child): {stats['detailed_categories']}")

        print("\n📈 Transactions:")
        print(f"   Categorized: {stats['categorized_transactions']}")
        print(f"   Uncategorized: {stats['uncategorized_transactions']}")
        total_txn = stats['categorized_transactions'] + stats['uncategorized_transactions']
        if total_txn > 0:
            coverage = (stats['categorized_transactions'] / total_txn) * 100
            print(f"   Coverage: {coverage:.1f}%")

        print("\n👥 Recipients:")
        print(f"   Categorized: {stats['categorized_recipients']}")
        print(f"   Uncategorized: {stats['uncategorized_recipients']}")
        total_recipients = stats['categorized_recipients'] + stats['uncategorized_recipients']
        if total_recipients > 0:
            coverage = (stats['categorized_recipients'] / total_recipients) * 100
            print(f"   Coverage: {coverage:.1f}%")

        return stats

    except Exception as e:
        print(f"\n✗ Error getting statistics: {e}")
        return None
    finally:
        db.close()


def show_category_hierarchy():
    """Display categories in hierarchical tree format"""
    print(f"\n{'=' * 70}")
    print(f"CATEGORY HIERARCHY")
    print(f"{'=' * 70}\n")

    db = SessionLocal()
    try:
        cat_service = CategoryService(db)
        categories = cat_service.get_all_categories_hierarchical()

        if not categories:
            print("No categories found.")
            return

        for general in categories:
            print(f"\n📁 {general['name']} (ID: {general['id']})")
            print(f"   Path: {general['full_path']}")
            print(f"   Transactions: {general['transaction_count']}")
            if general['description']:
                print(f"   Description: {general['description']}")

            if general['children']:
                for detailed in general['children']:
                    print(f"   └─ {detailed['name']} (ID: {detailed['id']})")
                    print(f"      Path: {detailed['full_path']}")
                    print(f"      Transactions: {detailed['transaction_count']}")

        return categories

    except Exception as e:
        print(f"\n✗ Error getting hierarchy: {e}")
        return None
    finally:
        db.close()


def show_uncategorized_items(item_type: str = "all", limit: int = 50):
    """
    Show uncategorized recipients and/or transactions

    Args:
        item_type: "recipients", "transactions", or "all"
        limit: Maximum number of items to show
    """
    print(f"\n{'=' * 70}")
    print(f"UNCATEGORIZED ITEMS")
    print(f"{'=' * 70}\n")

    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        if item_type in ["recipients", "all"]:
            print("📋 Uncategorized Recipients:")
            print("-" * 70)
            recipients = cat_service.get_uncategorized_recipients()

            if not recipients:
                print("   ✓ All recipients have categories assigned! 🎉\n")
            else:
                print(f"   {'ID':<5} {'Name':<45} {'Txns':<8}")
                print("   " + "-" * 58)
                for recipient in recipients[:limit]:
                    name = (recipient.name[:42] + "...") if len(recipient.name) > 45 else recipient.name
                    txn_count = len(recipient.transactions)
                    print(f"   {recipient.id:<5} {name:<45} {txn_count:<8}")

                if len(recipients) > limit:
                    print(f"\n   ... and {len(recipients) - limit} more")

                print(f"\n   Total uncategorized recipients: {len(recipients)}\n")

        if item_type in ["transactions", "all"]:
            print("📋 Uncategorized Transactions:")
            print("-" * 70)
            transactions = cat_service.get_uncategorized_transactions(limit=limit)

            if not transactions:
                print("   ✓ All transactions have categories assigned! 🎉\n")
            else:
                print(f"   {'Date':<12} {'Amount':<10} {'Recipient':<35}")
                print("   " + "-" * 57)
                for txn in transactions:
                    recipient_name = (txn.recipient.name[:32] + "...") if len(
                        txn.recipient.name) > 35 else txn.recipient.name
                    print(f"   {txn.date.strftime('%Y-%m-%d'):<12} ${float(txn.amount):<9.2f} {recipient_name:<35}")

        return {"recipients": recipients if item_type in ["recipients", "all"] else [],
                "transactions": transactions if item_type in ["transactions", "all"] else []}

    except Exception as e:
        print(f"\n✗ Error getting uncategorized items: {e}")
        return None
    finally:
        db.close()


def assign_category_to_recipient(recipient_id: int, category_path: str, apply_to_transactions: bool = True):
    """
    Assign a category to a specific recipient

    Args:
        recipient_id: ID of the recipient
        category_path: Category path like "Food:Groceries"
        apply_to_transactions: If True, apply to recipient's transactions
    """
    print(f"\n{'=' * 70}")
    print(f"ASSIGNING CATEGORY TO RECIPIENT")
    print(f"{'=' * 70}\n")

    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        # Get recipient
        recipient = db.query(Recipient).filter(Recipient.id == recipient_id).first()
        if not recipient:
            print(f"✗ Recipient with ID {recipient_id} not found.")
            return False

        # Create or get category
        category = cat_service.get_or_create_category(category_path)

        # Assign to recipient
        recipient.default_category_id = category.id
        db.commit()

        print(f"✓ Assigned category '{category.full_path}' to recipient '{recipient.name}'")

        # Apply to transactions if requested
        if apply_to_transactions:
            result = cat_service.apply_recipient_categories_to_transactions(
                recipient_id=recipient_id
            )
            print(f"✓ Updated {result['updated']} transactions")

        return True

    except Exception as e:
        print(f"\n✗ Error assigning category: {e}")
        db.rollback()
        return False
    finally:
        db.close()


def bulk_assign_categories(recipient_ids: list, category_path: str):
    """
    Assign a category to multiple recipients

    Args:
        recipient_ids: List of recipient IDs
        category_path: Category path like "Food:Groceries"
    """
    print(f"\n{'=' * 70}")
    print(f"BULK ASSIGNING CATEGORY TO RECIPIENTS")
    print(f"{'=' * 70}\n")

    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        result = cat_service.bulk_assign_category(recipient_ids, category_path)

        print(f"✓ Assigned category '{category_path}' to {result['updated']} recipients")

        return result

    except Exception as e:
        print(f"\n✗ Error bulk assigning categories: {e}")
        return None
    finally:
        db.close()


def export_category_mappings(output_file: str, include_uncategorized: bool = False):
    """
    Export current category mappings to CSV

    Args:
        output_file: Path to output CSV file
        include_uncategorized: If True, include recipients without categories
    """
    print(f"\n{'=' * 70}")
    print(f"EXPORTING CATEGORY MAPPINGS TO: {output_file}")
    print(f"{'=' * 70}\n")

    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        result = cat_service.export_category_mappings_to_csv(
            file_path=output_file,
            include_uncategorized=include_uncategorized
        )

        if result['success']:
            print(f"✓ Exported {result['count']} recipients")
            print(f"✓ File saved to: {result['file_path']}")
        else:
            print(f"✗ Export failed: {result.get('error', 'Unknown error')}")

        return result

    except Exception as e:
        print(f"\n✗ Error exporting: {e}")
        return None
    finally:
        db.close()


def auto_categorize_by_name_patterns():
    """
    Automatically categorize recipients based on common name patterns
    """
    print(f"\n{'=' * 70}")
    print(f"AUTO-CATEGORIZING BY NAME PATTERNS")
    print(f"{'=' * 70}\n")

    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        # Get uncategorized recipients
        recipients = cat_service.get_uncategorized_recipients()

        if not recipients:
            print("✓ All recipients are already categorized!")
            return

        # Define patterns
        patterns = {
            # Food
            "Food:Groceries": ["walmart", "target", "whole foods", "trader joe", "kroger", "safeway", "albertsons",
                               "grocery"],
            "Food:Restaurants": ["mcdonald", "burger", "pizza", "restaurant", "cafe", "starbucks", "dunkin"],
            "Food:Coffee": ["starbucks", "coffee", "dunkin", "peet"],

            # Transportation
            "Transportation:Gas": ["shell", "chevron", "exxon", "mobil", "bp gas", "gas station", "fuel"],
            "Transportation:Rideshare": ["uber", "lyft"],
            "Transportation:Public": ["metro", "transit", "mta", "bart"],

            # Entertainment
            "Entertainment:Streaming": ["netflix", "spotify", "hulu", "disney", "prime video", "apple music"],
            "Entertainment:Movies": ["amc", "cinemark", "theater", "cinema"],

            # Shopping
            "Shopping:Online": ["amazon", "ebay"],
            "Shopping:Electronics": ["best buy", "apple store"],

            # Healthcare
            "Healthcare:Pharmacy": ["cvs", "walgreens", "pharmacy", "rite aid"],
            "Healthcare:Doctor": ["dr ", "medical", "clinic", "hospital"],

            # Bills
            "Bills:Utilities": ["electric", "power", "water", "gas company"],
            "Bills:Internet": ["internet", "comcast", "att", "verizon internet"],
            "Bills:Phone": ["t-mobile", "verizon", "at&t", "sprint", "mobile"],
        }

        categorized_count = 0

        for recipient in recipients:
            name_lower = recipient.name.lower()

            # Try to match patterns
            for category_path, keywords in patterns.items():
                if any(keyword in name_lower for keyword in keywords):
                    category = cat_service.get_or_create_category(category_path)
                    recipient.default_category_id = category.id
                    categorized_count += 1
                    print(f"✓ {recipient.name} → {category_path}")
                    break

        db.commit()

        print(f"\n✓ Auto-categorized {categorized_count} recipients")
        print(f"✓ {len(recipients) - categorized_count} recipients still need manual categorization")

        return categorized_count

    except Exception as e:
        print(f"\n✗ Error auto-categorizing: {e}")
        db.rollback()
        return 0
    finally:
        db.close()


def complete_setup(csv_file: str):
    """
    Complete setup process: import, apply, and show results

    Args:
        csv_file: Path to CSV file with category mappings
    """
    print(f"\n{'=' * 70}")
    print(f"COMPLETE CATEGORY SETUP")
    print(f"{'=' * 70}\n")

    # Step 1: Import mappings
    print("Step 1: Importing category mappings...")
    import_result = import_categories_from_csv(csv_file)

    if not import_result:
        print("\n✗ Setup failed at import step")
        return

    # Step 2: Auto-categorize by patterns
    print("\nStep 2: Auto-categorizing by name patterns...")
    auto_categorize_by_name_patterns()

    # Step 3: Apply to transactions
    print("\nStep 3: Applying categories to transactions...")
    apply_result = apply_categories_to_transactions()

    # Step 4: Show statistics
    print("\nStep 4: Statistics:")
    show_category_statistics()

    # Step 5: Show hierarchy
    print("\nStep 5: Category Hierarchy:")
    show_category_hierarchy()

    # Step 6: Show what's left
    print("\nStep 6: Remaining Uncategorized:")
    show_uncategorized_items(item_type="recipients", limit=20)

    # Step 7: Export for reference
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    export_file = f"category_mappings_backup_{timestamp}.csv"
    print(f"\nStep 7: Exporting backup...")
    export_category_mappings(export_file, include_uncategorized=True)

    print(f"\n{'=' * 70}")
    print(f"SETUP COMPLETE!")
    print(f"{'=' * 70}\n")


def main():
    parser = argparse.ArgumentParser(
        description="Category Management Script - Efficiently manage transaction categories",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Complete setup from CSV
  python category_script.py complete-setup my_categories.csv
  
  # Import category mappings
  python category_script.py import my_categories.csv
  
  # Apply categories to transactions
  python category_script.py apply
  
  # Show statistics
  python category_script.py stats
  
  # Show category hierarchy
  python category_script.py hierarchy
  
  # Show uncategorized items
  python category_script.py uncategorized --type all
  
  # Assign category to recipient
  python category_script.py assign 123 "Food:Groceries"
  
  # Auto-categorize by name patterns
  python category_script.py auto-categorize
  
  # Export mappings
  python category_script.py export output.csv --include-uncategorized
        """
    )

    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    # Complete setup
    complete_parser = subparsers.add_parser('complete-setup', help='Complete setup: import, categorize, apply')
    complete_parser.add_argument('csv_file', help='Path to CSV file with category mappings')

    # Import
    import_parser = subparsers.add_parser('import', help='Import category mappings from CSV')
    import_parser.add_argument('csv_file', help='Path to CSV file')
    import_parser.add_argument('--recipient-col', default='Recipient', help='Recipient column name')
    import_parser.add_argument('--category-col', default='Category', help='Category column name')

    # Apply
    apply_parser = subparsers.add_parser('apply', help='Apply categories to transactions')
    apply_parser.add_argument('--recipient-id', type=int, help='Only apply for specific recipient')
    apply_parser.add_argument('--overwrite', action='store_true', help='Overwrite existing categories')

    # Stats
    stats_parser = subparsers.add_parser('stats', help='Show category statistics')

    # Hierarchy
    hierarchy_parser = subparsers.add_parser('hierarchy', help='Show category hierarchy')

    # Uncategorized
    uncat_parser = subparsers.add_parser('uncategorized', help='Show uncategorized items')
    uncat_parser.add_argument('--type', choices=['recipients', 'transactions', 'all'],
                              default='all', help='Type of items to show')
    uncat_parser.add_argument('--limit', type=int, default=50, help='Maximum items to show')

    # Assign
    assign_parser = subparsers.add_parser('assign', help='Assign category to recipient')
    assign_parser.add_argument('recipient_id', type=int, help='Recipient ID')
    assign_parser.add_argument('category_path', help='Category path (e.g., "Food:Groceries")')
    assign_parser.add_argument('--no-apply', action='store_true', help='Do not apply to transactions')

    # Bulk assign
    bulk_parser = subparsers.add_parser('bulk-assign', help='Assign category to multiple recipients')
    bulk_parser.add_argument('recipient_ids', help='Comma-separated recipient IDs')
    bulk_parser.add_argument('category_path', help='Category path (e.g., "Food:Groceries")')

    # Auto-categorize
    auto_parser = subparsers.add_parser('auto-categorize', help='Auto-categorize by name patterns')

    # Export
    export_parser = subparsers.add_parser('export', help='Export category mappings to CSV')
    export_parser.add_argument('output_file', help='Output CSV file path')
    export_parser.add_argument('--include-uncategorized', action='store_true',
                               help='Include recipients without categories')

    if len(sys.argv) == 1:
        parser.print_help()
        return

    args = parser.parse_args()

    # Execute command
    if args.command == 'complete-setup':
        complete_setup(args.csv_file)

    elif args.command == 'import':
        import_categories_from_csv(args.csv_file, args.recipient_col, args.category_col)

    elif args.command == 'apply':
        apply_categories_to_transactions(args.recipient_id, args.overwrite)

    elif args.command == 'stats':
        show_category_statistics()

    elif args.command == 'hierarchy':
        show_category_hierarchy()

    elif args.command == 'uncategorized':
        show_uncategorized_items(args.type, args.limit)

    elif args.command == 'assign':
        assign_category_to_recipient(args.recipient_id, args.category_path, not args.no_apply)

    elif args.command == 'bulk-assign':
        recipient_ids = [int(id.strip()) for id in args.recipient_ids.split(',')]
        bulk_assign_categories(recipient_ids, args.category_path)

    elif args.command == 'auto-categorize':
        auto_categorize_by_name_patterns()

    elif args.command == 'export':
        export_category_mappings(args.output_file, args.include_uncategorized)

    else:
        parser.print_help()


if __name__ == '__main__':
    main()
