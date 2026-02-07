"""
Test suite for info and statistics API endpoints.

Tests info endpoints for dashboard statistics, bank lists, and transaction summaries.
"""
from datetime import date
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from database.models import Transaction, Category, Recipient


class TestStatisticsEndpoint:
    """Test suite for GET /api/info statistics endpoint."""

    def test_get_statistics_success(self, client: TestClient, test_db: Session):
        """Test GET /api/info returns statistics successfully."""
        # Create test data
        category = Category(general="GROCERIES", detail="FOOD")
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create transactions
        for i in range(3):
            transaction = Transaction(
                date=date.today(),
                bank_account="TestBank",
                recipient_id=recipient.id,
                amount=100.0 + i * 10,
                category_id=category.id
            )
            test_db.add(transaction)
        test_db.commit()

        response = client.get("/api/info")

        assert response.status_code == 200
        data = response.json()

        assert "total_transactions" in data
        assert "categories" in data
        assert data["total_transactions"] == 3
        assert len(data["categories"]) > 0

    def test_get_statistics_empty_database(self, client: TestClient, test_db: Session):
        """Test GET /api/info with empty database."""
        response = client.get("/api/info")

        assert response.status_code == 200
        data = response.json()

        assert data["total_transactions"] == 0
        assert isinstance(data["categories"], list)

    def test_get_statistics_database_error(self, client: TestClient, test_db: Session):
        """Test GET /api/info handles database errors."""
        with patch('services.statistics_service.InfoService.get_statistics') as mock_stats:
            mock_stats.side_effect = Exception("Database connection error")

            response = client.get("/api/info")

            assert response.status_code == 500
            assert "Error retrieving statistics" in response.json()["detail"]


class TestBanksEndpoint:
    """Test suite for GET /api/info/banks endpoint."""

    def test_get_banks_success(self, client: TestClient, test_db: Session):
        """Test GET /api/info/banks returns bank list successfully."""
        # Create test data with different banks
        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        banks = ["Chase", "Revolut", "Barclays"]
        for bank in banks:
            transaction = Transaction(
                date=date.today(),
                bank_account=bank,
                recipient_id=recipient.id,
                amount=100.0
            )
            test_db.add(transaction)
        test_db.commit()

        response = client.get("/api/info/banks")

        assert response.status_code == 200
        data = response.json()

        assert "banks" in data
        assert len(data["banks"]) == 3
        assert set(data["banks"]) == set(banks)

    def test_get_banks_empty_database(self, client: TestClient, test_db: Session):
        """Test GET /api/info/banks with no transactions."""
        response = client.get("/api/info/banks")

        assert response.status_code == 200
        data = response.json()

        assert "banks" in data
        assert data["banks"] == []

    def test_get_banks_database_error(self, client: TestClient, test_db: Session):
        """Test GET /api/info/banks handles database errors."""
        with patch('services.statistics_service.InfoService.get_banks') as mock_banks:
            mock_banks.side_effect = Exception("Database connection error")

            response = client.get("/api/info/banks")

            assert response.status_code == 500
            assert "Error retrieving banks" in response.json()["detail"]


class TestTransactionSummaryEndpoint:
    """Test suite for GET /api/info/transaction-summary endpoint."""

    def test_get_transaction_summary_success(self, client: TestClient, test_db: Session):
        """Test GET /api/info/transaction-summary returns summary successfully."""
        # Create test data
        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        transaction = Transaction(
            date=date.today(),
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=100.0
        )
        test_db.add(transaction)
        test_db.commit()

        response = client.get("/api/info/transaction-summary")

        assert response.status_code == 200

    def test_get_transaction_summary_with_bank_filter(self, client: TestClient, test_db: Session):
        """Test GET /api/info/transaction-summary with bank account filter."""
        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create transactions for different banks
        for bank in ["Chase", "Revolut"]:
            transaction = Transaction(
                date=date.today(),
                bank_account=bank,
                recipient_id=recipient.id,
                amount=100.0
            )
            test_db.add(transaction)
        test_db.commit()

        response = client.get("/api/info/transaction-summary?bank_account=Chase")

        assert response.status_code == 200

    def test_get_transaction_summary_with_date_filters(self, client: TestClient, test_db: Session):
        """Test GET /api/info/transaction-summary with date range filters."""
        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        transaction = Transaction(
            date=date.today(),
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=100.0
        )
        test_db.add(transaction)
        test_db.commit()

        today = date.today().isoformat()
        response = client.get(f"/api/info/transaction-summary?start_date={today}&end_date={today}")

        assert response.status_code == 200

    def test_get_transaction_summary_invalid_start_date(self, client: TestClient):
        """Test GET /api/info/transaction-summary with invalid start date format."""
        response = client.get("/api/info/transaction-summary?start_date=invalid-date")

        assert response.status_code == 400
        assert "Invalid start_date format" in response.json()["detail"]

    def test_get_transaction_summary_invalid_end_date(self, client: TestClient):
        """Test GET /api/info/transaction-summary with invalid end date format."""
        response = client.get("/api/info/transaction-summary?end_date=not-a-date")

        assert response.status_code == 400
        assert "Invalid end_date format" in response.json()["detail"]

    def test_get_transaction_summary_database_error(self, client: TestClient, test_db: Session):
        """Test GET /api/info/transaction-summary handles database errors."""
        with patch('services.statistics_service.InfoService.get_transaction_summary') as mock_summary:
            mock_summary.side_effect = Exception("Database connection error")

            response = client.get("/api/info/transaction-summary")

            assert response.status_code == 500
            assert "Error retrieving transaction summary" in response.json()["detail"]

    def test_get_transaction_summary_all_filters(self, client: TestClient, test_db: Session):
        """Test GET /api/info/transaction-summary with all filters combined."""
        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        transaction = Transaction(
            date=date.today(),
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=100.0
        )
        test_db.add(transaction)
        test_db.commit()

        today = date.today().isoformat()
        response = client.get(
            f"/api/info/transaction-summary"
            f"?bank_account=TestBank"
            f"&start_date={today}"
            f"&end_date={today}"
        )

        assert response.status_code == 200
