#!/usr/bin/env python3
"""
CLI utility for managing financial transactions
"""
import argparse
import os
import sys

# Add the current directory to Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from database.connection import SessionLocal, init_db
from services.transaction_service import TransactionImportService
from services.category_service import CategoryService


def import_csv_command(args):
    """Handle CSV import command"""
    print(f"Starting import of {args.file} for bank: {args.bank}")
    db = SessionLocal()
    try:
        service = TransactionImportService(db)

        custom_config = None
        if args.custom:
            custom_config = {
                "bank_name": args.bank,
                "encoding": "utf-8",
                "separator": ",",
                "skip_rows": 0,
                "date_format": args.date_format or "%m/%d/%Y",
                "column_mapping": {
                    "date": args.date_column,
                    "recipient": args.recipient_column,
                    "amount": args.amount_column,
                    "memo": args.memo_column or ""
                }
            }

        result = service.import_csv(args.file, args.bank, custom_config)

        print(f"\nImport Results:")
        print(f"  Batch ID: {result['batch_id']}")
        print(f"  Total Processed: {result['total_processed']}")
        print(f"  Imported: {result['imported']}")
        print(f"  Duplicates: {result['duplicates']}")
        print(f"  Errors: {result['errors']}")
        print(f"  Status: {result['status']}")

        if result.get('error_message'):
            print(f"  Error: {result['error_message']}")

    except Exception as e:
        print(f"Fatal error during import: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


def export_csv_command(args):
    """Handle CSV export command"""
    from datetime import datetime

    print(f"Starting export to {args.output}")
    db = SessionLocal()
    try:
        service = TransactionImportService(db)

        # Parse date filters if provided
        from_date = None
        to_date = None

        if args.from_date:
            try:
                from_date = datetime.strptime(args.from_date, "%Y-%m-%d").date()
            except ValueError:
                print(f"Invalid from_date format. Use YYYY-MM-DD")
                return

        if args.to_date:
            try:
                to_date = datetime.strptime(args.to_date, "%Y-%m-%d").date()
            except ValueError:
                print(f"Invalid to_date format. Use YYYY-MM-DD")
                return

        # Export transactions
        result = service.export_transactions_to_csv(
            file_path=args.output,
            from_date=from_date,
            to_date=to_date,
            bank_account=args.bank_account,
            category_id=args.category_id
        )

        if result['success']:
            print(f"\n✓ Export successful!")
            print(f"  Exported: {result['count']} transactions")
            print(f"  File: {result['file_path']}")
            if result.get('date_range'):
                print(f"  Date range: {result['date_range']['from']} to {result['date_range']['to']}")
        else:
            print(f"\n✗ Export failed: {result['message']}")

    except Exception as e:
        print(f"Fatal error during export: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


def list_transactions_command(args):
    """Handle list transactions command"""
    db = SessionLocal()
    try:
        from datetime import datetime

        service = TransactionImportService(db)

        # Parse date filters if provided
        start_date = None
        end_date = None

        if args.start_date:
            try:
                start_date = datetime.strptime(args.start_date, "%Y-%m-%d").date()
            except ValueError:
                print(f"Invalid start date format. Use YYYY-MM-DD")
                return

        if args.end_date:
            try:
                end_date = datetime.strptime(args.end_date, "%Y-%m-%d").date()
            except ValueError:
                print(f"Invalid end date format. Use YYYY-MM-DD")
                return

        # Get transactions with filters
        transactions = service.get_transactions(
            bank_account=args.bank_account,
            start_date=start_date,
            end_date=end_date,
            category_id=args.category_id,
            recipient_id=args.recipient_id,
            recipient_name=args.recipient_name,
            limit=args.limit,
            offset=args.offset
        )

        if not transactions:
            print("No transactions found matching the filters.")
            return

        # Display active filters
        filters_applied = []
        if args.bank_account:
            filters_applied.append(f"Bank: {args.bank_account}")
        if args.start_date:
            filters_applied.append(f"From: {args.start_date}")
        if args.end_date:
            filters_applied.append(f"To: {args.end_date}")
        if args.category_id:
            filters_applied.append(f"Category ID: {args.category_id}")
        if args.recipient_id:
            filters_applied.append(f"Recipient ID: {args.recipient_id}")
        if args.recipient_name:
            filters_applied.append(f"Recipient: {args.recipient_name}")

        if filters_applied:
            print(f"Filters: {' | '.join(filters_applied)}")
            print()

        print(f"Found {len(transactions)} transactions:")
        print(f"{'Date':<12} {'Amount':<10} {'Bank/Account':<25} {'Recipient':<30} {'Category':<15} {'Memo':<30}")
        print("-" * 122)

        for txn in transactions:
            bank_acct = (txn.bank_account[:22] + "...") if txn.bank_account and len(txn.bank_account) > 25 else (
                    txn.bank_account or "N/A")
            memo = (txn.memo[:27] + "...") if txn.memo and len(txn.memo) > 30 else (txn.memo or "")
            recipient = (txn.recipient.name[:27] + "...") if len(txn.recipient.name) > 30 else txn.recipient.name
            category = (txn.category.name[:12] + "...") if txn.category and len(txn.category.name) > 15 else (
                txn.category.name if txn.category else "N/A")

            print(
                f"{txn.date.strftime('%Y-%m-%d'):<12} ${float(txn.amount):<9.2f} {bank_acct:<25} {recipient:<30} {category:<15} {memo:<30}")

    finally:
        db.close()


def list_recipients_command(args):
    """Handle list recipients command"""
    db = SessionLocal()
    try:
        from database.models import Recipient

        service = TransactionImportService(db)

        if args.with_accounts:
            recipients = service.get_recipients_with_account_numbers()
            print("Recipients with account numbers:")
        else:
            recipients = db.query(Recipient).all()
            print("All recipients:")

        if not recipients:
            print("No recipients found.")
            return

        print(f"{'ID':<5} {'Name':<40} {'Account Number':<20} {'Category':<20} {'Transactions':<12}")
        print("-" * 97)

        for recipient in recipients:
            category = recipient.default_category.name if recipient.default_category else "None"
            txn_count = len(recipient.transactions)
            account = recipient.account_number or "N/A"
            name = (recipient.name[:37] + "...") if len(recipient.name) > 40 else recipient.name

            print(f"{recipient.id:<5} {name:<40} {account:<20} {category:<20} {txn_count:<12}")

    except Exception as e:
        print(f"Error listing recipients: {e}")
    finally:
        db.close()


def update_recipient_command(args):
    """Handle update recipient command"""
    db = SessionLocal()
    try:
        from database.models import Recipient

        recipient = db.query(Recipient).filter(Recipient.id == args.recipient_id).first()
        if not recipient:
            print(f"Recipient with ID {args.recipient_id} not found.")
            return

        updated = False

        if args.account_number is not None:
            recipient.account_number = args.account_number if args.account_number != "" else None
            updated = True
            print(f"Updated account number for '{recipient.name}'")

        if args.category_id is not None:
            recipient.default_category_id = args.category_id if args.category_id > 0 else None
            updated = True
            print(f"Updated default category for '{recipient.name}'")

        if args.notes is not None:
            recipient.notes = args.notes if args.notes != "" else None
            updated = True
            print(f"Updated notes for '{recipient.name}'")

        if updated:
            db.commit()
            print("Recipient updated successfully.")
        else:
            print("No changes specified.")

    except Exception as e:
        print(f"Error updating recipient: {e}")
        db.rollback()
    finally:
        db.close()


def create_category_command(args):
    """Handle create category command"""
    db = SessionLocal()
    try:
        from database.models import Category

        # Check if category already exists
        existing = db.query(Category).filter(Category.name == args.name).first()
        if existing:
            print(f"Category '{args.name}' already exists.")
            return

        category = Category(
            name=args.name,
            description=args.description,
            color=args.color,
            parent_id=args.parent_id if args.parent_id and args.parent_id > 0 else None
        )

        db.add(category)
        db.commit()
        db.refresh(category)

        print(f"Created category '{category.name}' with ID {category.id}")

    except Exception as e:
        print(f"Error creating category: {e}")
        db.rollback()
    finally:
        db.close()


def list_categories_command(args):
    """Handle list categories command"""
    db = SessionLocal()
    cat_service = CategoryService(db)

    if args.hierarchical:
        # Show hierarchical view
        categories = cat_service.get_all_categories_hierarchical()

        if not categories:
            print("No categories found.")
            return

        print("Categories (Hierarchical View):")
        print("=" * 80)

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
    else:
        # Show flat view
        from database.models import Category
        categories = db.query(Category).filter(Category.is_active == True).order_by(Category.full_path).all()
        categories = db.query(Category).filter(Category.is_active == True).all()
    if not categories:
        print("No categories found.")
        return
    return
    print(f"{'ID':<5} {'Full Path':<40} {'Type':<10} {'Txns':<8} {'Description':<30}")
    print("-" * 95)
        print("-" * 97)
for category in categories:
    txn_count = len(category.transactions)
    description = (category.description[:27] + "...") if category.description and len(
        category.description) > 30 else (category.description or "")
    path = (category.full_path[:37] + "...") if category.full_path and len(
        category.full_path) > 40 else (category.full_path or "")
    category.description) > 30 else (category.description or "")
    print(f"{category.id:<5} {path:<40} {category.category_type or 'N/A':<10} {txn_count:<8} {description:<30}")
            print(f"{category.id:<5} {category.name:<30} {parent_name:<20} {recipient_count:<12} {description:<30}")

    except Exception as e:
import traceback

traceback.print_exc()
finally:
db.close()


def assign_category_command(args):
    """Handle assign category command"""
    db = SessionLocal()
    try:
        from database.models import Recipient, Category

        # Find the category by path
        category = db.query(Category).filter(Category.path == args.category_path).first()
        if not category:
            print(f"Category with path '{args.category_path}' not found.")
            return

        recipient_ids = []
        if args.recipient_id:
            recipient_ids = [args.recipient_id]
        elif args.recipient_ids:
            recipient_ids = [int(id) for id in args.recipient_ids.split(",")]

        if not recipient_ids:
            print("No recipient IDs provided.")
            return

        # Assign category to recipients
        recipients = db.query(Recipient).filter(Recipient.id.in_(recipient_ids)).all()
        for recipient in recipients:
            recipient.default_category = category
            print(f"Assigned category '{category.name}' to recipient '{recipient.name}'")

        db.commit()
        print("Category assignment updated successfully.")

    except Exception as e:
        print(f"Error assigning category: {e}")
        db.rollback()
    finally:
        db.close()


def export_category_mappings_command(args):
    """Handle export category mappings command"""
    db = SessionLocal()
    try:
        from database.models import Recipient, Category

        # Get all recipients with their categories
        if args.include_uncategorized:
            recipients = db.query(Recipient).outerjoin(Category).all()
        else:
            recipients = db.query(Recipient).join(Category).all()

        if not recipients:
            print("No recipients found.")
            return

        # Prepare CSV export
        import csv
        from io import StringIO

        output = StringIO()
        writer = csv.writer(output)
        writer.writerow(['Recipient ID', 'Recipient Name', 'Account Number', 'Category ID', 'Category Name', 'Notes'])

        for recipient in recipients:
            category_id = recipient.default_category.id if recipient.default_category else ""
            category_name = recipient.default_category.name if recipient.default_category else ""
            account_number = recipient.account_number or ""
            notes = recipient.notes or ""

            writer.writerow([recipient.id, recipient.name, account_number, category_id, category_name, notes])

        output.seek(0)

        # Save to file
        with open(args.output, 'w', newline='', encoding='utf-8') as f:
            f.write(output.getvalue())

        print(f"✓ Exported category mappings to {args.output}")

    except Exception as e:
        print(f"Error exporting category mappings: {e}")
    finally:
        db.close()


def import_category_mappings_command(args):
    """Handle import category mappings from CSV"""
    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        print(f"Importing category mappings from {args.file}...")

        result = cat_service.import_category_mappings_from_csv(
            file_path=args.file,
            recipient_column=args.recipient_column,
            category_column=args.category_column,
            has_header=not args.no_header
        )

        print(f"\n✓ Import completed!")
        print(f"  Total processed: {result['total_processed']}")
        print(f"  Mappings created: {result['mappings_created']}")
        print(f"  Categories created: {result['categories_created']}")

        if result['recipients_not_found']:
            print(f"\n⚠️  Recipients not found ({len(result['recipients_not_found'])}):")
            for name in result['recipients_not_found'][:10]:  # Show first 10
                print(f"    - {name}")
            if len(result['recipients_not_found']) > 10:
                print(f"    ... and {len(result['recipients_not_found']) - 10} more")

        if result['errors']:
            print(f"\n✗ Errors ({len(result['errors'])}):")
            for error in result['errors'][:5]:  # Show first 5
                print(f"    - {error}")
            if len(result['errors']) > 5:
                print(f"    ... and {len(result['errors']) - 5} more")

        # Ask if user wants to apply categories to transactions
        if result['mappings_created'] > 0:
            print(f"\n💡 You can now apply these categories to transactions using:")
            print(f"   python cli.py apply-categories")

    except Exception as e:
        print(f"Fatal error during import: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


def apply_categories_command(args):
    """Apply recipient categories to transactions"""
    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        print("Applying recipient categories to transactions...")

        result = cat_service.apply_recipient_categories_to_transactions(
            recipient_id=args.recipient_id,
            overwrite_existing=args.overwrite
        )

        print(f"\n✓ Categories applied!")
        print(f"  Transactions updated: {result['updated']}")
    # Assign category command
    assign_cat_parser = subparsers.add_parser('assign-category', help='Assign category to recipient(s)')
    assign_cat_parser.add_argument('category_path', help='Category path (e.g., "Food:Groceries")')
    assign_cat_parser.add_argument('--recipient-id', type=int, help='Recipient ID to assign category')
    assign_cat_parser.add_argument('--recipient-ids', help='Comma-separated list of recipient IDs')

    # Export category mappings command
    export_mappings_parser = subparsers.add_parser('export-category-mappings', help='Export category mappings to CSV')
    export_mappings_parser.add_argument('output', help='Output file path for CSV')
    export_mappings_parser.add_argument('--include-uncategorized', action='store_true',
                                        help='Include recipients without categories')

    print(f"  Transactions checked: {result['total_checked']}")

except Exception as e:
print(f"Error applying categories: {e}")
import traceback

traceback.print_exc()
finally:
db.close()


def show_uncategorized_command(args):
    """Show uncategorized recipients and transactions"""
    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        if args.type == 'recipients' or args.type == 'all':
            print("\n📋 Uncategorized Recipients:")
            print("=" * 80)
            recipients = cat_service.get_uncategorized_recipients()

            if not recipients:
                print("  All recipients have categories assigned! 🎉")
            else:
    elif args.command == 'assign-category':
    assign_category_command(args)

elif args.command == 'export-category-mappings':
export_category_mappings_command(args)
print(f"{'ID':<5} {'Name':<50} {'Txns':<8}")
print("-" * 63)
for recipient in recipients[:args.limit]:
    name = (recipient.name[:47] + "...") if len(recipient.name) > 50 else recipient.name
    txn_count = len(recipient.transactions)
    print(f"{recipient.id:<5} {name:<50} {txn_count:<8}")

if len(recipients) > args.limit:
    print(f"\n... and {len(recipients) - args.limit} more")

print(f"\nTotal uncategorized recipients: {len(recipients)}")

if args.type == 'transactions' or args.type == 'all':
    print("\n📋 Uncategorized Transactions:")
    print("=" * 80)
    transactions = cat_service.get_uncategorized_transactions(limit=args.limit)

    if not transactions:
        print("  All transactions have categories assigned! 🎉")
    else:
        print(f"{'Date':<12} {'Amount':<10} {'Recipient':<40}")
        print("-" * 62)
        for txn in transactions:
            recipient_name = (txn.recipient.name[:37] + "...") if len(txn.recipient.name) > 40 else txn.recipient.name
            print(f"{txn.date.strftime('%Y-%m-%d'):<12} ${float(txn.amount):<9.2f} {recipient_name:<40}")

except Exception as e:
print(f"Error showing uncategorized: {e}")
import traceback

traceback.print_exc()
finally:
db.close()


def category_stats_command(args):
    """Show category statistics"""
    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        stats = cat_service.get_category_statistics()

        print("\n📊 Category Statistics")
        print("=" * 60)
        print(f"\nCategories:")
        print(f"  Total: {stats['total_categories']}")
        print(f"  General (parent): {stats['general_categories']}")
        print(f"  Detailed (child): {stats['detailed_categories']}")

        print(f"\nTransactions:")
        print(f"  Categorized: {stats['categorized_transactions']}")
        print(f"  Uncategorized: {stats['uncategorized_transactions']}")
        total_txns = stats['categorized_transactions'] + stats['uncategorized_transactions']
        if total_txns > 0:
            pct = (stats['categorized_transactions'] / total_txns) * 100
            print(f"  Coverage: {pct:.1f}%")

        print(f"\nRecipients:")
        print(f"  Categorized: {stats['categorized_recipients']}")
        print(f"  Uncategorized: {stats['uncategorized_recipients']}")
        total_recipients = stats['categorized_recipients'] + stats['uncategorized_recipients']
        if total_recipients > 0:
            pct = (stats['categorized_recipients'] / total_recipients) * 100
            print(f"  Coverage: {pct:.1f}%")

    except Exception as e:
        print(f"Error showing statistics: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


def assign_category_command(args):
    """Assign category to recipient(s)"""
    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        # Create or get the category
        category = cat_service.get_or_create_category(args.category_path)

        if args.recipient_id:
            # Single recipient
            from database.models import Recipient
            recipient = db.query(Recipient).filter(Recipient.id == args.recipient_id).first()
            if not recipient:
                print(f"Recipient with ID {args.recipient_id} not found.")
                return

            recipient.default_category_id = category.id
            db.commit()

            print(f"✓ Assigned category '{category.full_path}' to recipient '{recipient.name}'")
        elif args.recipient_ids:
            # Multiple recipients
            recipient_ids = [int(id.strip()) for id in args.recipient_ids.split(',')]
            result = cat_service.bulk_assign_category(recipient_ids, args.category_path)
            print(f"✓ Assigned category '{category.full_path}' to {result['updated']} recipients")
        else:
            print("Error: You must specify either --recipient-id or --recipient-ids")

    except Exception as e:
        print(f"Error assigning category: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


def export_category_mappings_command(args):
    """Export category mappings to CSV"""
    db = SessionLocal()
    try:
        cat_service = CategoryService(db)

        print(f"Exporting category mappings to {args.output}...")

        result = cat_service.export_category_mappings_to_csv(
            file_path=args.output,
            include_uncategorized=args.include_uncategorized
        )

        if result['success']:
            print(f"\n✓ Export successful!")
            print(f"  Recipients exported: {result['count']}")
            print(f"  File: {result['file_path']}")
        else:
            print(f"\n✗ Export failed: {result['error']}")

    except Exception as e:
        print(f"Error exporting: {e}")
        import traceback
        traceback.print_exc()
        print(f"Error listing categories: {e}")
    finally:
        db.close()


def init_db_command(args):
    """Handle init-db command"""
    init_db()
    print("Database initialized successfully.")


def reset_db_command(args):
    """Handle reset-db command - drops all tables and recreates them"""
    from database.models import Base
    from database.connection import engine, DEFAULT_DB_PATH

    if not args.force:
        print("⚠️  WARNING: This will DELETE ALL DATA in the database!")
        print(f"   Database location: {DEFAULT_DB_PATH}")
        response = input("   Are you sure you want to continue? (yes/no): ")
        if response.lower() != 'yes':
            print("Reset cancelled.")
            return

    print("Dropping all tables...")
    Base.metadata.drop_all(bind=engine)
    print("✓ All tables dropped")

    print("Creating fresh tables...")
    Base.metadata.create_all(bind=engine)
    print("✓ Database reset successfully")
    print(f"   Database location: {DEFAULT_DB_PATH}")


def main():
    parser = argparse.ArgumentParser(description="Financial Transaction Management CLI")
    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    # Import CSV command
    import_parser = subparsers.add_parser('import', help='Import transactions from CSV')
    import_parser.add_argument('file', help='Path to CSV file')
    import_parser.add_argument('bank', help='Bank name (chase, wells_fargo, bank_of_america, or custom)')
    import_parser.add_argument('--custom', action='store_true', help='Use custom configuration')
    import_parser.add_argument('--date-format', help='Date format (e.g., %%m/%%d/%%Y)')
    import_parser.add_argument('--date-column', help='Date column name (for custom config)')
    import_parser.add_argument('--recipient-column', help='Recipient column name (for custom config)')
    import_parser.add_argument('--amount-column', help='Amount column name (for custom config)')
    import_parser.add_argument('--memo-column', help='Memo column name (for custom config)')

    # Export CSV command
    export_parser = subparsers.add_parser('export', help='Export transactions to CSV')
    export_parser.add_argument('output', help='Output file path for CSV')
    export_parser.add_argument('bank_account', help='Bank account name or ID')
    export_parser.add_argument('--from-date', help='Start date for filtering (YYYY-MM-DD)')
    export_parser.add_argument('--to-date', help='End date for filtering (YYYY-MM-DD)')
    export_parser.add_argument('--category-id', type=int, help='Filter by category ID')

    # List transactions command
    list_parser = subparsers.add_parser('list', help='List transactions')
    list_parser.add_argument('--limit', type=int, default=50, help='Number of transactions to show')
    list_parser.add_argument('--offset', type=int, default=0, help='Offset for pagination')
    list_parser.add_argument('--start-date', help='Start date for filtering (YYYY-MM-DD)')
    list_parser.add_argument('--end-date', help='End date for filtering (YYYY-MM-DD)')
    list_parser.add_argument('--bank-account', help='Filter by bank account')
    list_parser.add_argument('--recipient-id', type=int, help='Filter by recipient ID')
    list_parser.add_argument('--recipient-name', help='Filter by recipient name (partial match)')
    list_parser.add_argument('--category-id', type=int, help='Filter by category ID')

    # List recipients command
    recipients_parser = subparsers.add_parser('recipients', help='List recipients')
    recipients_parser.add_argument('--with-accounts', action='store_true',
                                   help='Show only recipients with account numbers')

    # Update recipient command
    update_parser = subparsers.add_parser('update-recipient', help='Update recipient information')
    update_parser.add_argument('recipient_id', type=int, help='Recipient ID to update')
    update_parser.add_argument('--account-number', help='Set account number (empty string to clear)')
    update_parser.add_argument('--category-id', type=int, help='Set default category ID (0 to clear)')
    update_parser.add_argument('--notes', help='Set notes (empty string to clear)')

    # Create category command
    create_cat_parser = subparsers.add_parser('create-category', help='Create a new category')
    create_cat_parser.add_argument('name', help='Category name')
    create_cat_parser.add_argument('--description', help='Category description')
    create_cat_parser.add_argument('--color', help='Category color (hex code)')
    create_cat_parser.add_argument('--parent-id', type=int, help='Parent category ID for subcategories')

    # List categories command
    categories_parser.add_argument('--hierarchical', action='store_true', help='Show hierarchical view')
    categories_parser = subparsers.add_parser('categories', help='List categories')

    # Initialize database command
    init_parser = subparsers.add_parser('init-db', help='Initialize database tables')

    # Reset database command
    reset_parser = subparsers.add_parser('reset-db', help='Reset database (DROP ALL DATA and recreate tables)')
    reset_parser.add_argument('--force', action='store_true', help='Skip confirmation prompt')
    # Import category mappings command
    import_mappings_parser = subparsers.add_parser('import-category-mappings', help='Import category mappings from CSV')
    import_mappings_parser.add_argument('file', help='Path to CSV file')
    import_mappings_parser.add_argument('--recipient-column', help='Recipient column name (for custom config)')
    import_mappings_parser.add_argument('--category-column', help='Category column name (for custom config)')
    import_mappings_parser.add_argument('--no-header', action='store_true', help='Specify if CSV has no header row')

    # Apply categories command
    apply_categories_parser = subparsers.add_parser('apply-categories',
                                                    help='Apply recipient categories to transactions')
    apply_categories_parser.add_argument('--recipient-id', type=int, help='Recipient ID to apply categories')
    apply_categories_parser.add_argument('--overwrite', action='store_true', help='Overwrite existing categories')

    # Show uncategorized command
    show_uncategorized_parser = subparsers.add_parser('show-uncategorized',
                                                      help='Show uncategorized recipients and transactions')
    show_uncategorized_parser.add_argument('--type', choices=['recipients', 'transactions', 'all'], default='all',
                                           help='Type to show')
    show_uncategorized_parser.add_argument('--limit', type=int, default=50, help='Limit number of results')

    # Category statistics command
    stats_parser = subparsers.add_parser('category-stats', help='Show category statistics')

    # Assign category command
    assign_cat_parser = subparsers.add_parser('assign-category', help='Assign category to recipient(s)')
    assign_cat_parser.add_argument('category_path', help='Category path (e.g., "Food:Groceries")')
    assign_cat_parser.add_argument('--recipient-id', type=int, help='Recipient ID to assign category')
    assign_cat_parser.add_argument('--recipient-ids', help='Comma-separated list of recipient IDs')


    if len(sys.argv) == 1:
        parser.print_help()
        return

    args = parser.parse_args()

    if args.command == 'import':
        import_csv_command(args)
    elif args.command == 'export':
        export_csv_command(args)
    elif args.command == 'list':
        list_transactions_command(args)
    elif args.command == 'recipients':
        list_recipients_command(args)
    elif args.command == 'update-recipient':
        update_recipient_command(args)
    elif args.command == 'create-category':
        create_category_command(args)
    elif args.command == 'categories':
        list_categories_command(args)
    elif args.command == 'init-db':
        init_db_command(args)
    elif args.command == 'reset-db':
    elif args.command == 'import-category-mappings':
        import_category_mappings_command(args)
    elif args.command == 'apply-categories':
        apply_categories_command(args)
    elif args.command == 'show-uncategorized':
        show_uncategorized_command(args)
    elif args.command == 'category-stats':
        category_stats_command(args)
    elif args.command == 'assign-category':
        assign_category_command(args)
        reset_db_command(args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
