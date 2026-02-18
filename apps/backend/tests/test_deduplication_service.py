"""
Unit tests for DeduplicationService.

Tests transaction deduplication logic, hash generation,
and duplicate detection mechanisms.
"""
from datetime import date

import pytest
from sqlalchemy.orm import Session

from database.models import Transaction, Recipient, Category
from services.bank_adapters import TransactionData
from services.deduplication_service import DeduplicationService


class TestDeduplicationService:
    """Test cases for deduplication service."""

    @pytest.fixture
    def setup_test_data(self, test_db: Session):
        """Set up test data for deduplication tests."""
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
        test_db.query(Transaction).filter(Transaction.recipient_id == recipient.id).delete()
        test_db.query(Recipient).filter(Recipient.id == recipient.id).delete()
        test_db.query(Category).filter(Category.id == category.id).delete()
        test_db.commit()

    @pytest.fixture
    def service(self, test_db: Session):
        """Create deduplication service with test database."""
        return DeduplicationService(test_db)

    def test_create_transaction_hash_with_raw_data(self, service):
        """Test hash creation with raw CSV data."""
        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test memo",
            amount=100.00,
            raw_data="2026-02-17,Test Recipient,100.00,EUR"
        )

        hash1 = service.create_transaction_hash(txn_data)
        hash2 = service.create_transaction_hash(txn_data)

        # Same data should produce same hash
        assert hash1 == hash2
        assert len(hash1) == 64  # SHA256 produces 64 hex characters
        assert isinstance(hash1, str)

    def test_create_transaction_hash_without_raw_data(self, service):
        """Test hash creation without raw data (fallback to fields)."""
        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test memo",
            amount=100.00,
            raw_data=""
        )

        hash_result = service.create_transaction_hash(txn_data)

        # Should still produce valid hash
        assert len(hash_result) == 64
        assert isinstance(hash_result, str)

    def test_identical_transactions_produce_same_hash(self, service):
        """Test that identical transactions produce the same hash."""
        raw_data = "2026-02-17,Test Recipient,100.00,EUR"

        txn_data1 = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test memo",
            amount=100.00,
            raw_data=raw_data
        )

        txn_data2 = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test memo",
            amount=100.00,
            raw_data=raw_data
        )

        hash1 = service.create_transaction_hash(txn_data1)
        hash2 = service.create_transaction_hash(txn_data2)

        assert hash1 == hash2

    def test_different_transactions_produce_different_hash(self, service):
        """Test that different transactions produce different hashes."""
        txn_data1 = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test memo",
            amount=100.00,
            raw_data="2026-02-17,Test Recipient,100.00,EUR"
        )

        txn_data2 = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test memo",
            amount=200.00,  # Different amount
            raw_data="2026-02-17,Test Recipient,200.00,EUR"
        )

        hash1 = service.create_transaction_hash(txn_data1)
        hash2 = service.create_transaction_hash(txn_data2)

        assert hash1 != hash2

    def test_is_duplicate_returns_false_for_new_transaction(self, service):
        """Test that is_duplicate returns False for new transaction."""
        transaction_hash = "nonexistent_hash_12345"

        result = service.is_duplicate(transaction_hash)

        assert result is False

    def test_is_duplicate_returns_true_for_existing_transaction(
            self, service, test_db: Session, setup_test_data
    ):
        """Test that is_duplicate returns True for existing transaction."""
        # Create a transaction with a specific bank_reference (hash)
        transaction_hash = "test_hash_abc123"
        transaction = Transaction(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            bank_reference=transaction_hash
        )
        test_db.add(transaction)
        test_db.commit()

        result = service.is_duplicate(transaction_hash)

        assert result is True

    def test_is_duplicate_by_data_with_new_transaction(self, service):
        """Test is_duplicate_by_data returns False for new transaction."""
        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="New Recipient",
            memo="New memo",
            amount=100.00,
            raw_data="2026-02-17,New Recipient,100.00,EUR"
        )

        result = service.is_duplicate_by_data(txn_data)

        assert result is False

    def test_is_duplicate_by_data_with_existing_transaction(
            self, service, test_db: Session, setup_test_data
    ):
        """Test is_duplicate_by_data returns True for existing transaction."""
        # Create transaction data
        raw_data = "2026-02-17,Test Recipient,100.00,EUR"
        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test memo",
            amount=100.00,
            raw_data=raw_data
        )

        # Calculate hash and create transaction
        transaction_hash = service.create_transaction_hash(txn_data)
        transaction = Transaction(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            bank_reference=transaction_hash
        )
        test_db.add(transaction)
        test_db.commit()

        # Check for duplicate
        result = service.is_duplicate_by_data(txn_data)

        assert result is True

    def test_get_hash_for_data(self, service):
        """Test get_hash_for_data returns correct hash."""
        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test memo",
            amount=100.00,
            raw_data="2026-02-17,Test Recipient,100.00,EUR"
        )

        hash_result = service.get_hash_for_data(txn_data)

        # Should return valid SHA256 hash
        assert len(hash_result) == 64
        assert isinstance(hash_result, str)

        # Should be consistent
        hash_result2 = service.get_hash_for_data(txn_data)
        assert hash_result == hash_result2

    def test_hash_with_special_characters(self, service):
        """Test hash generation with special characters in data."""
        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient™ & Co.",
            memo="Test memo",
            amount=100.00,
            raw_data="2026-02-17,Test Recipient™ & Co.,100.00,EUR"
        )

        hash_result = service.create_transaction_hash(txn_data)

        # Should handle special characters
        assert len(hash_result) == 64
        assert isinstance(hash_result, str)

    def test_hash_with_unicode_characters(self, service):
        """Test hash generation with unicode characters."""
        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Café Français €",
            memo="Test memo",
            amount=100.00,
            raw_data="2026-02-17,Café Français €,100.00,EUR"
        )

        hash_result = service.create_transaction_hash(txn_data)

        # Should handle unicode
        assert len(hash_result) == 64
        assert isinstance(hash_result, str)

    def test_hash_with_empty_memo(self, service):
        """Test hash generation with empty memo."""
        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="",
            amount=100.00,
            raw_data=""
        )

        hash_result = service.create_transaction_hash(txn_data)

        # Should handle empty memo
        assert len(hash_result) == 64
        assert isinstance(hash_result, str)

    def test_hash_with_negative_amount(self, service):
        """Test hash generation with negative amount (income)."""
        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Employer",
            memo="Salary",
            amount=-100.00,  # Negative for income
            raw_data="2026-02-17,Employer,-100.00,EUR"
        )

        hash_result = service.create_transaction_hash(txn_data)

        # Should handle negative amounts
        assert len(hash_result) == 64
        assert isinstance(hash_result, str)

    def test_hash_consistency_across_instances(self, test_db: Session):
        """Test that hash is consistent across different service instances."""
        service1 = DeduplicationService(test_db)
        service2 = DeduplicationService(test_db)

        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test memo",
            amount=100.00,
            raw_data="2026-02-17,Test Recipient,100.00,EUR"
        )

        hash1 = service1.create_transaction_hash(txn_data)
        hash2 = service2.create_transaction_hash(txn_data)

        # Different service instances should produce same hash
        assert hash1 == hash2

    def test_fallback_hash_format(self, service):
        """Test the fallback hash format when raw_data is not available."""
        txn_data = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test Memo",
            amount=100.00,
            raw_data=""
        )

        hash_result = service.create_transaction_hash(txn_data)

        # Verify hash is created from fallback format
        # Should use: date|amount|recipient|memo
        assert len(hash_result) == 64

        # Create another with same data
        txn_data2 = TransactionData(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient="Test Recipient",
            memo="Test Memo",
            amount=100.00,
            raw_data=""
        )

        hash_result2 = service.create_transaction_hash(txn_data2)

        # Should produce same hash
        assert hash_result == hash_result2
