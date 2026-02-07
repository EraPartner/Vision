"""
Transaction Export Service

Service for exporting transactions to various formats.
Handles all export-related business logic and file operations.
"""
import csv
from datetime import date
from typing import Dict, Any, Optional

from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import Transaction, Category
from repositories.transaction_repository import TransactionRepository

logger = setup_logging(__name__)


class TransactionExportService:
    """Service for exporting transactions to various formats"""

    def __init__(self, db_session: Session):
        self.db = db_session
        self.txn_repo = TransactionRepository(db_session)

    def export_to_csv(
            self,
            file_path: str,
            from_date: Optional[date] = None,
            to_date: Optional[date] = None,
            bank_account: Optional[str] = None,
            category_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Export transactions to CSV file.

        Args:
            file_path: Path where the CSV file will be saved
            from_date: Start date for transactions (optional)
            to_date: End date for transactions (optional, defaults to today)
            bank_account: Filter by specific bank account (optional)
            category_id: Filter by category (optional)

        Returns:
            Dictionary with export results including count and file path
        """
        # Default to_date to today if not provided
        if to_date is None:
            to_date = date.today()

        # Build query
        query = self.db.query(Transaction).join(Transaction.recipient)

        # Apply filters
        if from_date:
            query = query.filter(Transaction.date >= from_date)

        if to_date:
            query = query.filter(Transaction.date <= to_date)

        if bank_account:
            query = query.filter(Transaction.bank_account == bank_account)

        if category_id:
            query = query.filter(Transaction.category_id == category_id)

        # Order by date (oldest first for export)
        transactions = query.order_by(Transaction.date.asc()).all()

        if not transactions:
            return {
                'success': False,
                'message': 'No transactions found for the specified criteria',
                'count': 0,
                'file_path': None
            }

        # Write to CSV
        try:
            with open(file_path, 'w', newline='', encoding='utf-8') as csvfile:
                fieldnames = [
                    'Date',
                    'Bank Account',
                    'Recipient',
                    'Recipient Account',
                    'Memo',
                    'Amount',
                    'Currency',
                    'Balance',
                    'Category',
                    'Comment'
                ]

                writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
                writer.writeheader()

                for transaction in transactions:
                    # Get category name if available
                    category_name = ''
                    if transaction.category_id:
                        category = self.db.query(Category).filter(
                            Category.id == transaction.category_id
                        ).first()
                        if category:
                            category_name = category.general + ':' + category.detail

                    # Get recipient info
                    recipient_name = transaction.recipient.name if transaction.recipient else ''
                    recipient_account = transaction.recipient.account_number if transaction.recipient else ''

                    writer.writerow({
                        'Date': transaction.date.isoformat(),
                        'Bank Account': transaction.bank_account or '',
                        'Recipient': recipient_name,
                        'Recipient Account': recipient_account or '',
                        'Memo': transaction.memo or '',
                        'Amount': float(transaction.amount),
                        'Currency': transaction.currency or '',
                        'Balance': float(transaction.balance) if transaction.balance else '',
                        'Category': category_name,
                        'Comment': transaction.comment or ''
                    })

            logger.info(f"Successfully exported {len(transactions)} transactions to {file_path}")

            return {
                'success': True,
                'message': f'Successfully exported {len(transactions)} transactions',
                'count': len(transactions),
                'file_path': file_path,
                'date_range': {
                    'from': transactions[0].date.isoformat(),
                    'to': transactions[-1].date.isoformat()
                }
            }

        except Exception as e:
            logger.error(f"Error exporting transactions: {str(e)}")
            return {
                'success': False,
                'message': f'Error exporting transactions: {str(e)}',
                'count': 0,
                'file_path': None
            }
