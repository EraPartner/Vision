"""
Transaction Query Service

Service for transaction queries and retrieval.
Separates query concerns from import and export operations.
"""
from datetime import datetime, date
from typing import Optional, List, Dict, Any

from sqlalchemy.orm import Session, aliased

from config.logging_config import setup_logging
from database.models import Transaction, Recipient, Category
from repositories.transaction_repository import TransactionRepository

logger = setup_logging(__name__)


class TransactionQueryService:
    """Service for querying and retrieving transactions"""

    def __init__(self, db_session: Session):
        self.db = db_session
        self.txn_repo = TransactionRepository(db_session)

    def get_transactions(
            self,
            bank_account: Optional[str] = None,
            start_date: Optional[datetime] = None,
            end_date: Optional[datetime] = None,
            category_id: Optional[int] = None,
            recipient_id: Optional[int] = None,
            recipient_name: Optional[str] = None,
            limit: int = 100,
            offset: int = 0
    ) -> List[Transaction]:
        """
        Get transactions with optional filters.

        Args:
            bank_account: Filter by bank account
            start_date: Filter by start date
            end_date: Filter by end date
            category_id: Filter by category
            recipient_id: Filter by recipient ID
            recipient_name: Filter by recipient name
            limit: Maximum results
            offset: Pagination offset

        Returns:
            List of transactions
        """
        return self.txn_repo.get_transactions(
            bank_account=bank_account,
            start_date=start_date,
            end_date=end_date,
            category_id=category_id,
            recipient_id=recipient_id,
            recipient_name=recipient_name,
            limit=limit,
            offset=offset,
        )

    def get_transaction_by_id(self, transaction_id: int) -> Optional[Transaction]:
        """Get a single transaction by ID"""
        return self.txn_repo.get_by_id(transaction_id)

    def get_transaction_summary(
            self,
            start_date: Optional[datetime] = None,
            end_date: Optional[datetime] = None
    ) -> Dict[str, Any]:
        """
        Get summary statistics for transactions.

        Args:
            start_date: Start date for summary
            end_date: End date for summary

        Returns:
            Dictionary with summary statistics
        """
        query = self.db.query(Transaction)

        if start_date:
            query = query.filter(Transaction.date >= start_date)

        if end_date:
            query = query.filter(Transaction.date <= end_date)

        transactions = query.all()

        if not transactions:
            return {
                "total_transactions": 0,
                "total_amount": 0,
                "average_amount": 0,
                "min_amount": None,
                "max_amount": None,
                "date_range": None
            }

        amounts = [float(t.amount) for t in transactions]
        dates = [t.date for t in transactions]

        return {
            "total_transactions": len(transactions),
            "total_amount": sum(amounts),
            "average_amount": sum(amounts) / len(amounts),
            "min_amount": min(amounts),
            "max_amount": max(amounts),
            "date_range": {
                "start": min(dates),
                "end": max(dates)
            }
        }

    def get_uncategorized_transactions(self, limit: int = 100) -> List[Transaction]:
        """Get uncategorized transactions"""
        return self.txn_repo.get_uncategorized(limit=limit)

    def get_by_recipient(self, recipient_id: int) -> List[Transaction]:
        """Get all transactions for a specific recipient"""
        return self.db.query(Transaction).filter(
            Transaction.recipient_id == recipient_id
        ).order_by(Transaction.date.desc()).all()

    def list_transactions_frontend(
            self,
            limit: int = 1000,
            offset: int = 0,
            start_date: Optional[date] = None,
            end_date: Optional[date] = None,
            bank_account: Optional[str] = None,
            category_id: Optional[int] = None,
            recipient_id: Optional[int] = None,
            recipient_name: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Return transactions formatted for the frontend.

        Args:
            limit: Maximum results
            offset: Pagination offset
            start_date: Start date filter
            end_date: End date filter
            bank_account: Bank account filter
            category_id: Category ID filter
            recipient_id: Recipient ID filter
            recipient_name: Recipient name filter

        Returns:
            List of formatted transaction dictionaries
        """
        txns = self.get_transactions(
            bank_account=bank_account,
            start_date=start_date,
            end_date=end_date,
            category_id=category_id,
            recipient_id=recipient_id,
            recipient_name=recipient_name,
            limit=limit,
            offset=offset,
        )

        cat_ids = {t.category_id for t in txns if t.category_id}
        cat_map: Dict[int, str] = {}
        if cat_ids:
            cats = self.txn_repo.get_categories_by_ids(list(cat_ids))
            cat_map = {c.id: c.name for c in cats}

        return [
            {
                'id': int(t.id),
                'transaction_date': t.date.isoformat(),
                'description': t.recipient.name if t.recipient else 'Unknown',
                'amount': float(t.amount),
                'category': (cat_map.get(t.category_id, 'Uncategorized') if t.category_id else 'Uncategorized'),
                'bank_source': t.bank_account or None
            }
            for t in txns
        ]

    def view_transactions_joined(self, limit: int = 20, batch_id: Optional[int] = None) -> List[Dict[str, Any]]:
        """
        Return transactions with joined recipient and category info for CLI view.

        Args:
            limit: Maximum results
            batch_id: Filter by batch ID

        Returns:
            List of transaction dictionaries with joined data
        """
        TransactionCategory = aliased(Category)
        RecipientCategory = aliased(Category)
        query = (
            self.db.query(Transaction, Recipient, TransactionCategory, RecipientCategory)
            .join(Recipient, Transaction.recipient_id == Recipient.id)
            .outerjoin(TransactionCategory, Transaction.category_id == TransactionCategory.id)
            .outerjoin(RecipientCategory, Recipient.default_category_id == RecipientCategory.id)
        )
        if batch_id:
            query = query.filter(Transaction.batch_id == batch_id)
        results = query.order_by(Transaction.date.desc(), Transaction.id.desc()).limit(limit).all()
        return [
            {
                'id': int(txn.id),
                'date': txn.date.isoformat(),
                'amount': float(txn.amount),
                'recipient': recipient.name if recipient else None,
                'transaction_category': (txn_category.name if txn_category else None),
                'recipient_category': (recip_category.name if recip_category else None),
                'bank_account': txn.bank_account
            }
            for txn, recipient, txn_category, recip_category in results
        ]
