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
        self.info_repo = InfoRepository(db_session)

    def get_statistics(self) -> Dict[str, Any]:
        """
        Get overview statistics for the dashboard.

        Returns:
            Dictionary containing total transactions, total amount, and category breakdown
        """
        total_transactions = self.info_repo.get_transaction_count()
        total_amount = self.info_repo.get_total_amount()
        categories = self.info_repo.get_category_statistics()

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
        banks = self.info_repo.get_bank_accounts()
        logger.info(f"Retrieved {len(banks)} unique bank accounts")
        return banks

    def get_transaction_count(self) -> int:
        """
        Get total count of transactions in the database.

        Returns:
            Total number of transactions
        """
        count = self.info_repo.get_transaction_count()
        logger.info(f"Retrieved transaction count: {count}")
        return count

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

    def get_monthly_financial_summary(
            self,
            excluded_category_ids: Optional[List[int]] = None
    ) -> Dict[str, Any]:
        """
        Get financial summary for the past 6 months, broken down month by month.

        Returns spending, income, net amount, and transaction count for each of the
        last 6 calendar months, allowing for trend analysis.

        Args:
            excluded_category_ids: List of category IDs to exclude from calculations.
                                   Defaults to [9, 22] (Intrabank transfers and internal transfers)

        Returns:
            Dictionary with months array containing monthly breakdowns and overall summary
        """
        from calendar import monthrange

        today = date.today()
        months_data = []

        # Calculate data for each of the last 6 months
        for months_ago in range(5, -1, -1):  # 5, 4, 3, 2, 1, 0 (most recent last)
            # Calculate the target month and year
            target_month = today.month - months_ago
            target_year = today.year

            # Handle year rollover
            while target_month <= 0:
                target_month += 12
                target_year -= 1

            # Get the first and last day of the target month
            first_day = date(target_year, target_month, 1)
            last_day_num = monthrange(target_year, target_month)[1]
            last_day = date(target_year, target_month, last_day_num)

            # For the current month, use today as the end date
            if target_year == today.year and target_month == today.month:
                last_day = today

            # Get financial data for this month
            financial_data = self.info_repo.get_spending_and_income_by_date_range(
                start_date=first_day,
                end_date=last_day,
                excluded_category_ids=excluded_category_ids
            )

            months_data.append({
                "month": target_month,
                "year": target_year,
                "period_start": first_day,
                "period_end": last_day,
                "total_spending": financial_data["total_spending_eur"],
                "total_income": financial_data["total_income_eur"],
                "net_amount": financial_data["net_amount_eur"],
                "transaction_count": financial_data["transaction_count"]
            })

        # Calculate overall totals
        total_spending = sum(m["total_spending"] for m in months_data)
        total_income = sum(m["total_income"] for m in months_data)
        total_transactions = sum(m["transaction_count"] for m in months_data)

        logger.info(
            f"Retrieved 6-month financial summary: "
            f"{len(months_data)} months, "
            f"{total_transactions} total transactions, "
            f"total spending: {total_spending:.2f}, "
            f"total income: {total_income:.2f}"
        )

        return {
            "months": months_data,
            "summary": {
                "total_spending": total_spending,
                "total_income": total_income,
                "net_amount": total_income + total_spending,
                "transaction_count": total_transactions,
                "period_start": months_data[0]["period_start"],
                "period_end": months_data[-1]["period_end"]
            }
        }

    def get_planned_expenses_next_month(self) -> Dict[str, Any]:
        """
        Get planned expenses and income for the following month.

        Returns all planned transactions scheduled for the next calendar month,
        grouped by date to show expected cash flow patterns.

        Returns:
            Dictionary containing planned transactions grouped by date, totals, and period info
        """
        from calendar import monthrange
        from collections import defaultdict
        from database.models import PlannedTransaction

        today = date.today()

        # Calculate next month
        next_month = today.month + 1
        next_year = today.year
        if next_month > 12:
            next_month = 1
            next_year += 1

        # Get first and last day of next month
        first_day = date(next_year, next_month, 1)
        last_day_num = monthrange(next_year, next_month)[1]
        last_day = date(next_year, next_month, last_day_num)

        # Query planned transactions for next month
        planned_txns = self.db.query(PlannedTransaction).filter(
            PlannedTransaction.is_active == True,
            PlannedTransaction.planned_date >= first_day,
            PlannedTransaction.planned_date <= last_day
        ).order_by(PlannedTransaction.planned_date).all()

        # Group by date
        by_date = defaultdict(lambda: {"income": 0.0, "expenses": 0.0, "transactions": []})
        total_income = 0.0
        total_expenses = 0.0

        for txn in planned_txns:
            amount = float(txn.amount)
            date_key = txn.planned_date.isoformat()

            txn_data = {
                "id": txn.id,
                "amount": amount,
                "recipient_name": txn.recipient_name,
                "category_name": txn.category_name,
                "memo": txn.memo,
                "is_recurring": txn.is_recurring
            }

            by_date[date_key]["transactions"].append(txn_data)

            if amount >= 0:
                by_date[date_key]["income"] += amount
                total_income += amount
            else:
                by_date[date_key]["expenses"] += amount
                total_expenses += amount

        # Convert to list format
        daily_data = [
            {
                "date": date_str,
                "income": data["income"],
                "expenses": data["expenses"],
                "net": data["income"] + data["expenses"],
                "transactions": data["transactions"]
            }
            for date_str, data in sorted(by_date.items())
        ]

        logger.info(
            f"Retrieved planned expenses for next month: "
            f"{len(planned_txns)} transactions, "
            f"income: {total_income:.2f}, "
            f"expenses: {total_expenses:.2f}"
        )

        return {
            "month": next_month,
            "year": next_year,
            "period_start": first_day,
            "period_end": last_day,
            "daily_data": daily_data,
            "summary": {
                "total_income": total_income,
                "total_expenses": total_expenses,
                "net_amount": total_income + total_expenses,
                "transaction_count": len(planned_txns)
            }
        }

    def get_average_vs_current_spending(self) -> Dict[str, Any]:
        """
        Get average daily spending over the past 6 months compared to current month.

        Calculates the average spending per day from the past 6 complete months,
        then provides current month's spending by day for comparison.

        Returns:
            Dictionary with average daily spending, current month data, and comparison metrics
        """
        from calendar import monthrange
        from collections import defaultdict

        today = date.today()

        # Calculate the period for the past 6 complete months (excluding current month)
        # Start from 7 months ago to 1 month ago (6 complete months)
        target_month = today.month - 7
        target_year = today.year
        while target_month <= 0:
            target_month += 12
            target_year -= 1

        past_period_start = date(target_year, target_month, 1)

        # End of the previous month
        prev_month = today.month - 1
        prev_year = today.year
        if prev_month <= 0:
            prev_month = 12
            prev_year -= 1

        last_day_prev = monthrange(prev_year, prev_month)[1]
        past_period_end = date(prev_year, prev_month, last_day_prev)

        # Get all transactions from the past 6 complete months
        past_txns = self.db.query(Transaction).filter(
            Transaction.is_active == True,
            Transaction.date >= past_period_start,
            Transaction.date <= past_period_end
        ).all()

        # Calculate total spending (negative amounts) and number of days
        total_spending = sum(float(t.amount) for t in past_txns if float(t.amount) < 0)
        days_in_period = (past_period_end - past_period_start).days + 1
        avg_daily_spending = total_spending / days_in_period if days_in_period > 0 else 0.0

        # Get current month's data
        current_month_start = date(today.year, today.month, 1)
        current_month_txns = self.db.query(Transaction).filter(
            Transaction.is_active == True,
            Transaction.date >= current_month_start,
            Transaction.date <= today
        ).order_by(Transaction.date).all()

        # Group current month by day
        by_day = defaultdict(lambda: {"spending": 0.0, "income": 0.0, "transaction_count": 0})

        for txn in current_month_txns:
            amount = float(txn.amount)
            date_key = txn.date.isoformat()

            if amount < 0:
                by_day[date_key]["spending"] += amount
            else:
                by_day[date_key]["income"] += amount

            by_day[date_key]["transaction_count"] += 1

        # Convert to list and calculate cumulative
        current_month_data = []
        cumulative_spending = 0.0
        cumulative_expected = 0.0

        for day_num in range(1, today.day + 1):
            current_date = date(today.year, today.month, day_num)
            date_key = current_date.isoformat()

            day_spending = by_day[date_key]["spending"] if date_key in by_day else 0.0
            day_income = by_day[date_key]["income"] if date_key in by_day else 0.0
            day_count = by_day[date_key]["transaction_count"] if date_key in by_day else 0

            cumulative_spending += day_spending
            cumulative_expected += avg_daily_spending

            current_month_data.append({
                "date": date_key,
                "spending": day_spending,
                "income": day_income,
                "transaction_count": day_count,
                "cumulative_spending": cumulative_spending,
                "cumulative_expected": cumulative_expected,
                "variance": cumulative_spending - cumulative_expected
            })

        # Calculate totals for current month
        total_current_spending = sum(d["spending"] for d in current_month_data)
        total_current_income = sum(d["income"] for d in current_month_data)

        # Calculate expected total for the full month
        days_in_current_month = monthrange(today.year, today.month)[1]
        expected_month_total = avg_daily_spending * days_in_current_month

        logger.info(
            f"Retrieved average vs current spending: "
            f"avg daily: {avg_daily_spending:.2f}, "
            f"current month total: {total_current_spending:.2f}, "
            f"days in period: {days_in_period}"
        )

        return {
            "past_6_months": {
                "period_start": past_period_start,
                "period_end": past_period_end,
                "total_spending": total_spending,
                "days": days_in_period,
                "average_daily_spending": avg_daily_spending,
                "transaction_count": len(past_txns)
            },
            "current_month": {
                "month": today.month,
                "year": today.year,
                "period_start": current_month_start,
                "period_end": today,
                "days_elapsed": today.day,
                "total_spending": total_current_spending,
                "total_income": total_current_income,
                "daily_data": current_month_data,
                "transaction_count": len(current_month_txns)
            },
            "comparison": {
                "expected_to_date": avg_daily_spending * today.day,
                "actual_to_date": total_current_spending,
                "variance_to_date": total_current_spending - (avg_daily_spending * today.day),
                "expected_month_total": expected_month_total,
                "projected_month_total": (
                        total_current_spending / today.day * days_in_current_month) if today.day > 0 else 0.0
            }
        }
