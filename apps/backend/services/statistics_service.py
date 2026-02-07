"""
Statistics and Reporting Service

Handles all statistics and reporting business logic.
Delegates data retrieval to StatisticsRepository (Information Expert).
"""
from datetime import date
from typing import List, Optional, Dict, Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from config.logging_config import setup_logging
from database.models import ImportBatch, Transaction, Category
from repositories.info_repository import InfoRepository

logger = setup_logging(__name__)


class InfoService:
    """Service for managing statistics and reporting"""

    def __init__(self, db_session: Session):
        self.db = db_session
        self.stats_repo = InfoRepository(db_session)

    def get_statistics(self) -> Dict[str, Any]:
        """
        Get overview statistics for the dashboard.

        Returns:
            Dictionary containing total transactions, total amount, and category breakdown
        """
        total_transactions = self.stats_repo.get_transaction_count()
        total_amount = self.stats_repo.get_total_amount()
        categories = self.stats_repo.get_category_statistics()

        logger.info(f"Retrieved statistics: {total_transactions} transactions, {len(categories)} categories")

        return {
            "total_transactions": total_transactions,
            "total_amount": total_amount if total_amount is not None else 0.0,
            "categories": categories
        }

    def get_banks(self) -> List[str]:
        """
        Get list of all bank accounts/sources in the database.

        Returns:
            List of unique bank account names
        """
        banks = self.stats_repo.get_bank_accounts()
        logger.info(f"Retrieved {len(banks)} unique bank accounts")
        return banks

    def get_import_history(self, limit: int = 10) -> List[Dict[str, Any]]:
        """
        Get recent import batch history.

        Args:
            limit: Maximum number of batches to retrieve (1-100)

        Returns:
            List of import batch information
        """
        batches = self.db.query(ImportBatch) \
            .order_by(ImportBatch.created_at.desc()) \
            .limit(limit) \
            .all()

        return [{
            "id": b.id,
            "filename": b.filename,
            "bank_name": b.bank_name,
            "total_processed": b.total_processed,
            "imported": b.imported_count,
            "duplicates": b.duplicate_count,
            "errors": b.error_count,
            "status": b.status,
            "created_at": b.created_at.isoformat(),
            "completed_at": b.completed_at.isoformat() if b.completed_at else None
        } for b in batches]

    def get_transaction_summary(
            self,
            bank_account: Optional[str] = None,
            start_date: Optional[date] = None,
            end_date: Optional[date] = None
    ) -> Dict[str, Any]:
        """
        Get transaction summary with optional filters.

        Args:
            bank_account: Filter by specific bank account
            start_date: Filter transactions on or after this date
            end_date: Filter transactions on or before this date

        Returns:
            Dictionary with transaction count, total amount, average, min, and max
        """
        query = self.db.query(Transaction)

        if bank_account:
            query = query.filter(Transaction.bank_account == bank_account)

        if start_date:
            query = query.filter(Transaction.date >= start_date)

        if end_date:
            query = query.filter(Transaction.date <= end_date)

        transactions = query.all()

        if not transactions:
            return {
                "total_count": 0,
                "total_amount": 0.0,
                "average": 0.0,
                "min": None,
                "max": None
            }

        amounts = [float(t.amount) for t in transactions]
        total = sum(amounts)

        return {
            "total_count": len(transactions),
            "total_amount": total,
            "average": total / len(transactions),
            "min": min(amounts),
            "max": max(amounts)
        }

    def get_category_breakdown(self) -> Dict[str, Any]:
        """
        Get detailed breakdown of transactions by category.

        Returns:
            Dictionary with category statistics
        """
        category_stats_query = self.db.query(
            Category.id,
            Category.general,
            Category.detail,
            func.count(Transaction.id).label('count'),
            func.sum(Transaction.amount).label('total')
        ).join(Transaction).group_by(Category.id, Category.general, Category.detail).all()

        return {
            "categories": [
                {
                    "id": stat[0],
                    "name": f"{stat[1]}:{stat[2]}",  # general:detail format
                    "count": stat[3],
                    "total": float(stat[4] or 0)
                } for stat in category_stats_query
            ]
        }
