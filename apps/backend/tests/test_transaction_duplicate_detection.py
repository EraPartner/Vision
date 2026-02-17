"""Tests for transaction duplicate detection functionality.

This module tests the duplicate detection feature for transactions using
bank_reference and original_raw_data fields.
"""
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from database.models import Transaction, Recipient, Category
from repositories.transaction_repository import TransactionRepository
from services.transaction_service import TransactionService


class TestTransactionDuplicateDetection:
    """Test suite for transaction duplicate detection."""

    @pytest.fixture
    def setup_test_data(self, db: Session):
        """Set up test data for duplicate detection tests."""
        # Create test recipient
        recipient = Recipient(name="TEST RECIPIENT", is_active=True)
        db.add(recipient)
        db.commit()
        db.refresh(recipient)

        # Create test category
        category = Category(
            general="TEST",
            detail="CATEGORY",
            description="Test category",
            is_active=True
        )
        db.add(category)
        db.commit()
        db.refresh(category)

        yield {
            "recipient_id": recipient.id,
            "category_id": category.id
        }

        # Cleanup
        db.query(Transaction).filter(Transaction.recipient_id == recipient.id).delete()
        db.query(Recipient).filter(Recipient.id == recipient.id).delete()
        db.query(Category).filter(Category.id == category.id).delete()
        db.commit()

    def test_find_duplicate_by_bank_reference(self, db: Session, setup_test_data):
        """Test finding duplicate by bank reference."""
        repo = TransactionRepository(db)

        # Create initial transaction with bank reference
        transaction = Transaction(
            date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            bank_reference="TXN-2026-001234"
        )
        created = repo.create(transaction)

        # Search for duplicate
        duplicate = repo.find_duplicate_by_bank_reference("TXN-2026-001234")

        assert duplicate is not None
        assert duplicate.id == created.id
        assert duplicate.bank_reference == "TXN-2026-001234"

    def test_find_duplicate_by_bank_reference_with_account(self, db: Session, setup_test_data):
        """Test finding duplicate by bank reference with bank account filter."""
        repo = TransactionRepository(db)

        # Create transactions with same reference but different accounts
        txn1 = Transaction(
            date=date(2026, 2, 16),
            bank_account="Revolut",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            bank_reference="TXN-001"
        )
        txn2 = Transaction(
            date=date(2026, 2, 16),
            bank_account="KBC",
            recipient_id=setup_test_data["recipient_id"],
            amount=200.00,
            bank_reference="TXN-001"
        )
        created1 = repo.create(txn1)
        created2 = repo.create(txn2)

        # Search with bank account filter
        duplicate_revolut = repo.find_duplicate_by_bank_reference("TXN-001", "Revolut")
        duplicate_kbc = repo.find_duplicate_by_bank_reference("TXN-001", "KBC")

        assert duplicate_revolut.id == created1.id
        assert duplicate_kbc.id == created2.id

    def test_find_duplicate_by_raw_data(self, db: Session, setup_test_data):
        """Test finding duplicate by original raw data."""
        repo = TransactionRepository(db)

        raw_data = "2026-02-16,Test Recipient,100.00,EUR,Test Bank"

        # Create initial transaction with raw data
        transaction = Transaction(
            date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            original_raw_data=raw_data
        )
        created = repo.create(transaction)

        # Search for duplicate
        duplicate = repo.find_duplicate_by_raw_data(raw_data)

        assert duplicate is not None
        assert duplicate.id == created.id
        assert duplicate.original_raw_data == raw_data

    def test_find_duplicate_no_match(self, db: Session):
        """Test finding duplicate with no match."""
        repo = TransactionRepository(db)

        duplicate = repo.find_duplicate_by_bank_reference("NON-EXISTENT")
        assert duplicate is None

        duplicate = repo.find_duplicate_by_raw_data("non-existent-data")
        assert duplicate is None

    def test_find_duplicate_priority(self, db: Session, setup_test_data):
        """Test that bank_reference takes priority over raw_data."""
        repo = TransactionRepository(db)

        # Create two transactions
        txn1 = Transaction(
            date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            bank_reference="TXN-001"
        )
        txn2 = Transaction(
            date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=200.00,
            original_raw_data="raw-data-123"
        )
        created1 = repo.create(txn1)
        created2 = repo.create(txn2)

        # Search with both bank_reference and raw_data
        # Should find txn1 (bank_reference priority)
        duplicate = repo.find_duplicate(
            bank_reference="TXN-001",
            original_raw_data="non-matching-data"
        )

        assert duplicate.id == created1.id

    def test_service_create_duplicate_prevention(self, db: Session, setup_test_data):
        """Test that service layer prevents duplicate creation."""
        service = TransactionService(db)

        # Create initial transaction
        transaction1 = service.create(
            transaction_date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            bank_reference="TXN-2026-UNIQUE"
        )

        # Attempt to create duplicate
        with pytest.raises(ValueError) as exc_info:
            service.create(
                transaction_date=date(2026, 2, 16),
                bank_account="Test Bank",
                recipient_id=setup_test_data["recipient_id"],
                amount=100.00,
                bank_reference="TXN-2026-UNIQUE"
            )

        assert "Duplicate transaction found" in str(exc_info.value)
        assert f"ID: {transaction1.id}" in str(exc_info.value)

    def test_service_create_duplicate_skip(self, db: Session, setup_test_data):
        """Test that duplicate check can be skipped when needed."""
        service = TransactionService(db)

        # Create initial transaction
        transaction1 = service.create(
            transaction_date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            bank_reference="TXN-SKIP-TEST"
        )

        # Create with same reference but skip duplicate check
        transaction2 = service.create(
            transaction_date=date(2026, 2, 17),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=200.00,
            bank_reference="TXN-SKIP-TEST",
            skip_duplicate_check=True
        )

        assert transaction1.id != transaction2.id
        assert transaction1.bank_reference == transaction2.bank_reference

    def test_service_create_raw_data_duplicate(self, db: Session, setup_test_data):
        """Test duplicate detection using original_raw_data."""
        service = TransactionService(db)

        raw_data = "2026-02-16,TEST RECIPIENT,100.00,EUR,Test Bank,memo123"

        # Create initial transaction
        transaction1 = service.create(
            transaction_date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00,
            original_raw_data=raw_data
        )

        # Attempt to create duplicate using same raw data
        with pytest.raises(ValueError) as exc_info:
            service.create(
                transaction_date=date(2026, 2, 16),
                bank_account="Test Bank",
                recipient_id=setup_test_data["recipient_id"],
                amount=100.00,
                original_raw_data=raw_data
            )

        assert "Duplicate transaction found" in str(exc_info.value)

    def test_api_create_duplicate_prevention(self, client: TestClient, db: Session, setup_test_data):
        """Test API endpoint duplicate prevention."""
        # Create initial transaction
        response1 = client.post(
            "/api/transactions",
            json={
                "date": "2026-02-16",
                "bank_account": "Test Bank",
                "recipient_id": setup_test_data["recipient_id"],
                "amount": 100.00,
                "bank_reference": "API-TEST-001"
            }
        )
        assert response1.status_code == 201
        transaction1_id = response1.json()["id"]

        # Attempt duplicate
        response2 = client.post(
            "/api/transactions",
            json={
                "date": "2026-02-17",
                "bank_account": "Test Bank",
                "recipient_id": setup_test_data["recipient_id"],
                "amount": 200.00,
                "bank_reference": "API-TEST-001"
            }
        )
        assert response2.status_code == 400
        assert "Duplicate transaction found" in response2.json()["detail"]
        assert f"ID: {transaction1_id}" in response2.json()["detail"]

    def test_api_create_with_skip_duplicate_check(self, client: TestClient, db: Session, setup_test_data):
        """Test API endpoint with skip_duplicate_check flag."""
        # Create initial transaction
        response1 = client.post(
            "/api/transactions",
            json={
                "date": "2026-02-16",
                "bank_account": "Test Bank",
                "recipient_id": setup_test_data["recipient_id"],
                "amount": 100.00,
                "bank_reference": "SKIP-TEST-001"
            }
        )
        assert response1.status_code == 201

        # Create with same reference but skip check
        response2 = client.post(
            "/api/transactions",
            json={
                "date": "2026-02-17",
                "bank_account": "Test Bank",
                "recipient_id": setup_test_data["recipient_id"],
                "amount": 200.00,
                "bank_reference": "SKIP-TEST-001",
                "skip_duplicate_check": True
            }
        )
        assert response2.status_code == 201
        assert response2.json()["id"] != response1.json()["id"]

    def test_api_create_with_raw_data(self, client: TestClient, db: Session, setup_test_data):
        """Test API endpoint duplicate detection with original_raw_data."""
        raw_data = "2026-02-16,TEST RECIPIENT,100.00,EUR,Test Bank"

        # Create initial transaction
        response1 = client.post(
            "/api/transactions",
            json={
                "date": "2026-02-16",
                "bank_account": "Test Bank",
                "recipient_id": setup_test_data["recipient_id"],
                "amount": 100.00,
                "original_raw_data": raw_data
            }
        )
        assert response1.status_code == 201

        # Attempt duplicate
        response2 = client.post(
            "/api/transactions",
            json={
                "date": "2026-02-17",
                "bank_account": "Test Bank",
                "recipient_id": setup_test_data["recipient_id"],
                "amount": 200.00,
                "original_raw_data": raw_data
            }
        )
        assert response2.status_code == 400
        assert "Duplicate transaction found" in response2.json()["detail"]

    def test_no_duplicate_check_without_identifiers(self, db: Session, setup_test_data):
        """Test that duplicate check is skipped when no identifiers provided."""
        service = TransactionService(db)

        # Create two transactions without bank_reference or raw_data
        # Should not trigger duplicate detection
        transaction1 = service.create(
            transaction_date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00
        )

        transaction2 = service.create(
            transaction_date=date(2026, 2, 16),
            bank_account="Test Bank",
            recipient_id=setup_test_data["recipient_id"],
            amount=100.00
        )

        # Should create both successfully
        assert transaction1.id != transaction2.id
