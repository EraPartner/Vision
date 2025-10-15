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
    try:
        from database.models import Category

        categories = db.query(Category).filter(Category.is_active == True).all()

        if not categories:
            print("No categories found.")
            return

        print(f"{'ID':<5} {'Name':<30} {'Parent':<20} {'Recipients':<12} {'Description':<30}")
        print("-" * 97)

        for category in categories:
            parent_name = category.parent.name if category.parent else "None"
            recipient_count = len(category.recipients)
            description = (category.description[:27] + "...") if category.description and len(
                category.description) > 30 else (category.description or "")

            print(f"{category.id:<5} {category.name:<30} {parent_name:<20} {recipient_count:<12} {description:<30}")

    except Exception as e:
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
    categories_parser = subparsers.add_parser('categories', help='List categories')

    # Initialize database command
    init_parser = subparsers.add_parser('init-db', help='Initialize database tables')

    # Reset database command
    reset_parser = subparsers.add_parser('reset-db', help='Reset database (DROP ALL DATA and recreate tables)')
    reset_parser.add_argument('--force', action='store_true', help='Skip confirmation prompt')

    if len(sys.argv) == 1:
        parser.print_help()
        return

    args = parser.parse_args()

    if args.command == 'import':
        import_csv_command(args)
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
        reset_db_command(args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
