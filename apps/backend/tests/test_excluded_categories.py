"""
Test suite for excluded category IDs functionality in info repository.

Tests that the excluded_category_ids parameter correctly filters transactions
when calculating spending and income statistics.
"""
from datetime import date

import pytest
from sqlalchemy.orm import Session

from database.models import Category, Recipient, Transaction
from repositories.info_repository import InfoRepository


class TestExcludedCategories:
    """Test cases for excluded category filtering."""

    @pytest.fixture
    def setup_test_data(self, test_db: Session):
        """Set up test data with multiple categories and transactions."""
        # Create test categories
        category_transfer = Category(
            general="TRANSFER",
            detail="INTERNAL",
            description="Internal transfers",
            is_active=True
        )
        category_income = Category(
            general="INCOME",
            detail="SALARY",
            description="Salary income",
            is_active=True
        )
        category_expense = Category(
            general="GROCERIES",
            detail="FOOD",
            description="Food expenses",
            is_active=True
        )
        test_db.add_all([category_transfer, category_income, category_expense])
        test_db.commit()
        test_db.refresh(category_transfer)
        test_db.refresh(category_income)
        test_db.refresh(category_expense)

        # Create test recipient
        recipient = Recipient(name="TEST RECIPIENT", is_active=True)
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create test transactions
        # In the system: negative amounts = spending, positive amounts = income
        transactions = [
            Transaction(
                date=date(2026, 1, 15),
                bank_account="Test Bank",
                recipient_id=recipient.id,
                category_id=category_transfer.id,
                amount=-1000.00,  # Negative = spending
                currency="EUR"
            ),
            Transaction(
                date=date(2026, 1, 20),
                bank_account="Test Bank",
                recipient_id=recipient.id,
                category_id=category_income.id,
                amount=3000.00,  # Positive = income
                currency="EUR"
            ),
            Transaction(
                date=date(2026, 1, 25),
                bank_account="Test Bank",
                recipient_id=recipient.id,
                category_id=category_expense.id,
                amount=-100.00,  # Negative = spending
                currency="EUR"
            ),
        ]
        for txn in transactions:
            test_db.add(txn)
        test_db.commit()

        yield {
            "transfer_id": category_transfer.id,
            "income_id": category_income.id,
            "expense_id": category_expense.id,
            "recipient_id": recipient.id,
        }

        # Cleanup
        test_db.query(Transaction).filter(Transaction.recipient_id == recipient.id).delete()
        test_db.query(Recipient).filter(Recipient.id == recipient.id).delete()
        test_db.query(Category).filter(
            Category.id.in_([category_transfer.id, category_income.id, category_expense.id])
        ).delete()
        test_db.commit()

    def test_excluded_categories_none(self, test_db: Session, setup_test_data):
        """Test that no exclusions includes all transactions."""
        repo = InfoRepository(test_db)

        result = repo.get_spending_and_income_by_date_range(
            start_date=date(2026, 1, 1),
            end_date=date(2026, 1, 31),
            excluded_category_ids=[]
        )

        assert result['transaction_count'] == 3
        # Spending: -1000 (transfer) + -100 (expense) = -1100 EUR
        assert result['total_spending_eur'] == -1100.00
        # Income: 3000 EUR (positive amount)
        assert result['total_income_eur'] == 3000.00

    def test_excluded_categories_single(self, test_db: Session, setup_test_data):
        """Test excluding a single category."""
        repo = InfoRepository(test_db)

        result = repo.get_spending_and_income_by_date_range(
            start_date=date(2026, 1, 1),
            end_date=date(2026, 1, 31),
            excluded_category_ids=[setup_test_data["transfer_id"]]
        )

        # Should exclude transfer transaction
        assert result['transaction_count'] == 2
        # Spending: -100 (expense only)
        assert result['total_spending_eur'] == -100.00
        # Income: 3000 EUR (unchanged)
        assert result['total_income_eur'] == 3000.00

    def test_excluded_categories_multiple(self, test_db: Session, setup_test_data):
        """Test excluding multiple categories."""
        repo = InfoRepository(test_db)

        result = repo.get_spending_and_income_by_date_range(
            start_date=date(2026, 1, 1),
            end_date=date(2026, 1, 31),
            excluded_category_ids=[
                setup_test_data["transfer_id"],
                setup_test_data["income_id"]
            ]
        )

        # Should only include expense transaction
        assert result['transaction_count'] == 1
        # Spending: -100 (expense only)
        assert result['total_spending_eur'] == -100.00
        # Income: 0 (income excluded)
        assert result['total_income_eur'] == 0.00

    def test_excluded_categories_all(self, test_db: Session, setup_test_data):
        """Test excluding all categories returns zero transactions."""
        repo = InfoRepository(test_db)

        result = repo.get_spending_and_income_by_date_range(
            start_date=date(2026, 1, 1),
            end_date=date(2026, 1, 31),
            excluded_category_ids=[
                setup_test_data["transfer_id"],
                setup_test_data["income_id"],
                setup_test_data["expense_id"]
            ]
        )

        # Should exclude all transactions
        assert result['transaction_count'] == 0
        assert result['total_spending_eur'] == 0.00
        assert result['total_income_eur'] == 0.00

    def test_excluded_categories_nonexistent_id(self, test_db: Session, setup_test_data):
        """Test that excluding nonexistent category ID doesn't affect results."""
        repo = InfoRepository(test_db)

        result = repo.get_spending_and_income_by_date_range(
            start_date=date(2026, 1, 1),
            end_date=date(2026, 1, 31),
            excluded_category_ids=[99999]  # Nonexistent ID
        )

        # Should include all transactions
        assert result['transaction_count'] == 3
        assert result['total_spending_eur'] == -1100.00
        assert result['total_income_eur'] == 3000.00

    def test_excluded_categories_empty_date_range(self, test_db: Session, setup_test_data):
        """Test excluded categories with date range that has no transactions."""
        repo = InfoRepository(test_db)

        result = repo.get_spending_and_income_by_date_range(
            start_date=date(2026, 2, 1),
            end_date=date(2026, 2, 28),
            excluded_category_ids=[]
        )

        # Should find no transactions in this date range
        assert result['transaction_count'] == 0
        assert result['total_spending_eur'] == 0.00
        assert result['total_income_eur'] == 0.00
