"""
Statistics Repository

Repository for all statistics and reporting queries.
This is the Information Expert for statistical data retrieval.
"""
from datetime import date
from typing import List, Dict, Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from database.models import Transaction, Category


class InfoRepository:
    """Repository for statistics and reporting operations"""

    def __init__(self, db: Session):
        self.db = db

    def get_transaction_count(self) -> int:
        """Get total count of all transactions"""
        return self.db.query(func.count(Transaction.id)).scalar() or 0

    def get_total_amount(self) -> float:
        """Get total sum of all transaction amounts"""
        total = self.db.query(func.sum(Transaction.amount)).scalar() or 0
        return float(total)

    def get_category_statistics(self) -> List[Dict[str, Any]]:
        """
        Get statistics grouped by category.

        Returns:
            List of dictionaries with category name, count, and total
        """
        category_stats_query = self.db.query(
            Category.id,
            Category.general,
            Category.detail,
            func.count(Transaction.id).label('count'),
            func.sum(Transaction.amount).label('total')
        ).join(Transaction).group_by(Category.id, Category.general, Category.detail).all()

        return [
            {
                "name": f"{stat[1]}:{stat[2]}",  # general:detail format
                "count": stat[3],
                "total": float(stat[4] or 0)
            } for stat in category_stats_query
        ]

    def get_transaction_count_by_date_range(
            self,
            start_date: Optional[date] = None,
            end_date: Optional[date] = None
    ) -> int:
        """
        Get transaction count within date range.

        Args:
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

        Returns:
            Count of transactions in date range
        """
        query = self.db.query(func.count(Transaction.id))

        if start_date:
            query = query.filter(Transaction.date >= start_date)

        if end_date:
            query = query.filter(Transaction.date <= end_date)

        return query.scalar() or 0

    def get_total_amount_by_date_range(
            self,
            start_date: Optional[date] = None,
            end_date: Optional[date] = None
    ) -> float:
        """
        Get total amount within date range.

        Args:
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

        Returns:
            Total amount in date range
        """
        query = self.db.query(func.sum(Transaction.amount))

        if start_date:
            query = query.filter(Transaction.date >= start_date)

        if end_date:
            query = query.filter(Transaction.date <= end_date)

        total = query.scalar() or 0
        return float(total)

    def get_category_statistics_by_date_range(
            self,
            start_date: Optional[date] = None,
            end_date: Optional[date] = None
    ) -> List[Dict[str, Any]]:
        """
        Get category statistics within date range.

        Args:
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

        Returns:
            List of category statistics
        """
        query = self.db.query(
            Category.name,
            func.count(Transaction.id).label('count'),
            func.sum(Transaction.amount).label('total')
        ).join(Transaction)

        if start_date:
            query = query.filter(Transaction.date >= start_date)

        if end_date:
            query = query.filter(Transaction.date <= end_date)

        stats = query.group_by(Category.name).all()

        return [
            {
                "name": stat[0],
                "count": stat[1],
                "total": float(stat[2] or 0)
            } for stat in stats
        ]

    def get_transaction_summary(
            self,
            start_date: Optional[date] = None,
            end_date: Optional[date] = None
    ) -> Dict[str, Any]:
        """
        Get comprehensive transaction summary.

        Args:
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

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

    def get_bank_accounts(self) -> List[str]:
        """
        Get list of all unique bank accounts.

        Returns:
            List of bank account names
        """
        banks = self.db.query(Transaction.bank_account).distinct().all()
        return [bank[0] for bank in banks if bank[0]]

    def get_statistics_by_bank_account(self) -> Dict[str, Dict[str, Any]]:
        """
        Get statistics grouped by bank account.

        Returns:
            Dictionary with bank account names as keys and statistics as values
        """
        accounts = self.get_bank_accounts()
        stats = {}

        for account in accounts:
            query = self.db.query(Transaction).filter(
                Transaction.bank_account == account
            )
            transactions = query.all()

            if transactions:
                amounts = [float(t.amount) for t in transactions]
                stats[account] = {
                    "count": len(transactions),
                    "total": sum(amounts),
                    "average": sum(amounts) / len(amounts),
                    "min": min(amounts),
                    "max": max(amounts)
                }

        return stats

    def get_spending_and_income_by_date_range(
            self,
            start_date: date,
            end_date: date
    ) -> Dict[str, Any]:
        """
        Calculate total spending (negative amounts) and income (positive amounts) for a date range.

        All amounts are converted to EUR for accurate reporting across multiple currencies.

        Args:
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

        Returns:
            Dictionary with spending, income, net_amount (all in EUR), transaction count,
            and currency breakdown showing original currencies
        """
        from decimal import Decimal
        from services.currency_conversion_service import CurrencyConversionService

        query = self.db.query(Transaction).filter(
            Transaction.date >= start_date,
            Transaction.date <= end_date
        )

        transactions = query.all()

        if not transactions:
            return {
                "total_spending_eur": 0.0,
                "total_income_eur": 0.0,
                "net_amount_eur": 0.0,
                "transaction_count": 0,
                "currency_breakdown": {}
            }

        # Initialize currency conversion service with database session for caching
        converter = CurrencyConversionService(db=self.db)

        spending_eur = Decimal("0.0")
        income_eur = Decimal("0.0")
        currency_breakdown = {}

        for transaction in transactions:
            amount = float(transaction.amount)
            currency = transaction.currency

            # Convert amount to EUR
            amount_eur = converter.convert_to_eur(
                amount=amount,
                from_currency=currency,
                transaction_date=transaction.date
            )

            # Track currency breakdown for reporting
            currency_key = currency if currency else "EUR"
            if currency_key not in currency_breakdown:
                currency_breakdown[currency_key] = {
                    "count": 0,
                    "total_original": 0.0,
                    "total_eur": 0.0
                }

            currency_breakdown[currency_key]["count"] += 1
            currency_breakdown[currency_key]["total_original"] += amount
            currency_breakdown[currency_key]["total_eur"] += float(amount_eur)

            # Categorize as spending or income
            if amount < 0:
                spending_eur += amount_eur
            else:
                income_eur += amount_eur

        return {
            "total_spending_eur": float(spending_eur),
            "total_income_eur": float(income_eur),
            "net_amount_eur": float(income_eur + spending_eur),
            "transaction_count": len(transactions),
            "currency_breakdown": currency_breakdown
        }
