"""Tests for currency validation in transaction schemas.

This module tests that invalid currency codes are properly rejected
to prevent frontend rendering issues.
"""
from datetime import date

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.orm import Session

from api.api_schemas import TransactionCreate, TransactionUpdate, SUPPORTED_CURRENCIES
from database.models import Recipient, Category


class TestCurrencyValidation:
    """Test suite for currency code validation."""

    @pytest.fixture
    def setup_test_data(self, test_db: Session):
        """Set up test data for currency validation tests."""
        # Create test recipient
        recipient = Recipient(name="TEST RECIPIENT", is_active=True)
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create test category
        category = Category(
            general="TEST",
            detail="CATEGORY",
            description="Test category",
            is_active=True
        )
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        yield {
            "recipient_id": recipient.id,
            "category_id": category.id
        }

        # Cleanup
        test_db.query(Recipient).filter(Recipient.id == recipient.id).delete()
        test_db.query(Category).filter(Category.id == category.id).delete()
        test_db.commit()

    def test_valid_currency_codes(self):
        """Test that valid currency codes are accepted."""
        valid_currencies = ["EUR", "USD", "GBP", "JPY", "CHF"]

        for currency in valid_currencies:
            transaction = TransactionCreate(
                date=date(2026, 2, 16),
                bank_account="Test Bank",
                recipient_id=1,
                amount=100.00,
                currency=currency
            )
            assert transaction.currency == currency.upper()

    def test_lowercase_currency_normalized(self):
        """Test that lowercase currency codes are normalized to uppercase."""
        transaction = TransactionCreate(
            date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=1,
            amount=100.00,
            currency="eur"
        )
        assert transaction.currency == "EUR"

    def test_invalid_currency_rejected(self):
        """Test that invalid currency codes are rejected."""
        with pytest.raises(ValidationError) as exc_info:
            TransactionCreate(
                date=date(2026, 2, 16),
                bank_account="Test Bank",
                recipient_id=1,
                amount=100.00,
                currency="XYZ"  # Invalid currency
            )

        error_msg = str(exc_info.value)
        assert "Unsupported currency code" in error_msg
        assert "XYZ" in error_msg

    def test_invalid_currency_length_rejected(self):
        """Test that currency codes with wrong length are rejected."""
        # Too short
        with pytest.raises(ValidationError) as exc_info:
            TransactionCreate(
                date=date(2026, 2, 16),
                bank_account="Test Bank",
                recipient_id=1,
                amount=100.00,
                currency="EU"
            )
        assert "at least 3 characters" in str(exc_info.value) or "must be exactly 3 characters" in str(exc_info.value)

        # Too long
        with pytest.raises(ValidationError) as exc_info:
            TransactionCreate(
                date=date(2026, 2, 16),
                bank_account="Test Bank",
                recipient_id=1,
                amount=100.00,
                currency="EURO"
            )
        assert "at most 3 characters" in str(exc_info.value) or "must be exactly 3 characters" in str(exc_info.value)

    def test_null_currency_accepted(self):
        """Test that null/None currency is accepted."""
        transaction = TransactionCreate(
            date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=1,
            amount=100.00,
            currency=None
        )
        assert transaction.currency is None

    def test_update_schema_currency_validation(self):
        """Test that TransactionUpdate schema also validates currency."""
        # Valid
        update = TransactionUpdate(currency="USD")
        assert update.currency == "USD"

        # Invalid
        with pytest.raises(ValidationError) as exc_info:
            TransactionUpdate(currency="INVALID")
        # Pydantic catches the length first, but the validator would catch invalid codes
        assert "at most 3 characters" in str(exc_info.value) or "Unsupported currency code" in str(exc_info.value)

    def test_api_create_invalid_currency_rejected(self, client: TestClient, setup_test_data):
        """Test that API rejects invalid currency codes."""
        response = client.post(
            "/api/transactions",
            json={
                "date": "2026-02-16",
                "bank_account": "Test Bank",
                "recipient_id": setup_test_data["recipient_id"],
                "amount": 100.00,
                "currency": "INVALID"
            }
        )
        assert response.status_code == 422  # Validation error
        error_detail = response.json()["detail"]
        assert any("currency" in str(err).lower() for err in error_detail)

    def test_api_create_valid_currency_accepted(self, client: TestClient, setup_test_data):
        """Test that API accepts valid currency codes."""
        response = client.post(
            "/api/transactions",
            json={
                "date": "2026-02-16",
                "bank_account": "Test Bank",
                "recipient_id": setup_test_data["recipient_id"],
                "amount": 100.00,
                "currency": "EUR"
            }
        )
        assert response.status_code == 201
        assert response.json()["currency"] == "EUR"

    def test_api_update_invalid_currency_rejected(self, client: TestClient, test_db: Session, setup_test_data):
        """Test that API rejects invalid currency on update."""
        # First create a transaction
        from database.models import Transaction
        from repositories.transaction_repository import TransactionRepository

        repo = TransactionRepository(test_db)
        transaction = Transaction(
            date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            currency="EUR"
        )
        created = repo.create(transaction)

        # Try to update with invalid currency
        response = client.patch(
            f"/api/transactions/{created.id}",
            json={"currency": "BADCUR"}
        )
        assert response.status_code == 422  # Validation error
        error_detail = response.json()["detail"]
        assert any("currency" in str(err).lower() for err in error_detail)

    def test_api_update_valid_currency_accepted(self, client: TestClient, test_db: Session, setup_test_data):
        """Test that API accepts valid currency on update."""
        # First create a transaction
        from database.models import Transaction
        from repositories.transaction_repository import TransactionRepository

        repo = TransactionRepository(test_db)
        transaction = Transaction(
            date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            currency="EUR"
        )
        created = repo.create(transaction)

        # Update with valid currency
        response = client.patch(
            f"/api/transactions/{created.id}",
            json={"currency": "USD"}
        )
        assert response.status_code == 200
        assert response.json()["currency"] == "USD"

    def test_supported_currencies_list_exists(self):
        """Test that supported currencies list is defined and populated."""
        assert SUPPORTED_CURRENCIES is not None
        assert len(SUPPORTED_CURRENCIES) > 0
        assert "EUR" in SUPPORTED_CURRENCIES
        assert "USD" in SUPPORTED_CURRENCIES
        assert "GBP" in SUPPORTED_CURRENCIES

    def test_currency_with_whitespace_normalized(self):
        """Test that currency codes with whitespace are rejected by length validation."""
        # Whitespace makes the string longer than 3 characters, so it should be rejected
        with pytest.raises(ValidationError) as exc_info:
            TransactionCreate(
                date=date(2026, 2, 16),
                bank_account="Test Bank",
                recipient_id=1,
                amount=100.00,
                currency=" EUR "
            )
        assert "at most 3 characters" in str(exc_info.value)

    def test_error_message_lists_supported_currencies(self):
        """Test that error messages include list of supported currencies."""
        with pytest.raises(ValidationError) as exc_info:
            TransactionCreate(
                date=date(2026, 2, 16),
                bank_account="Test Bank",
                recipient_id=1,
                amount=100.00,
                currency="ZZZ"
            )

        error_msg = str(exc_info.value)
        assert "Supported currencies:" in error_msg
        # Check that at least some common currencies are mentioned
        assert "EUR" in error_msg or "USD" in error_msg
