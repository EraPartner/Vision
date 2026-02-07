"""
Test suite for info and statistics API endpoints.

Tests info endpoints for dashboard statistics, bank lists, transaction summaries,
and monthly financial summaries.
"""
from datetime import date, timedelta
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from database.models import Transaction, Category, Recipient


class TestInfoOptionsEndpoint:
    """Test suite for OPTIONS /api/info endpoint."""

    def test_info_options_success(self, client: TestClient):
        """Test OPTIONS /api/info returns available methods and links."""
        response = client.options("/api/info")

        assert response.status_code == 200
        data = response.json()

        # Validate response structure
        assert "methods" in data
        assert "links" in data

        # Validate methods
        assert isinstance(data["methods"], list)
        assert len(data["methods"]) >= 2

        method_names = [method["method"] for method in data["methods"]]
        assert "GET" in method_names
        assert "OPTIONS" in method_names

        # Each method should have description
        for method in data["methods"]:
            assert "method" in method
            assert "description" in method
            assert isinstance(method["description"], str)
            assert len(method["description"]) > 0

    def test_info_options_links(self, client: TestClient):
        """Test OPTIONS /api/info returns correct HATEOAS links."""
        response = client.options("/api/info")

        assert response.status_code == 200
        data = response.json()

        # Validate links structure
        assert "links" in data
        assert isinstance(data["links"], list)
        assert len(data["links"]) >= 5

        # Extract link relations
        link_rels = [link["rel"] for link in data["links"]]

        # Validate expected link relations are present
        expected_rels = ["self", "banks", "transaction-count", "transaction-summary", "monthly-summary"]
        for rel in expected_rels:
            assert rel in link_rels, f"Missing expected link relation: {rel}"

    def test_info_options_link_structure(self, client: TestClient):
        """Test OPTIONS /api/info links have correct structure."""
        response = client.options("/api/info")

        assert response.status_code == 200
        data = response.json()

        # Validate each link has required properties
        for link in data["links"]:
            assert "rel" in link
            assert "href" in link
            assert "method" in link
            assert "title" in link

            # Validate types
            assert isinstance(link["rel"], str)
            assert isinstance(link["href"], str)
            assert isinstance(link["method"], str)
            assert isinstance(link["title"], str)

            # Validate href is a valid URL
            assert link["href"].startswith("http")
            assert "/api/info" in link["href"]

            # Validate method is uppercase HTTP method
            assert link["method"] in ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]

    def test_info_options_self_link(self, client: TestClient):
        """Test OPTIONS /api/info self link points to correct endpoint."""
        response = client.options("/api/info")

        assert response.status_code == 200
        data = response.json()

        # Find self link
        self_link = next((link for link in data["links"] if link["rel"] == "self"), None)
        assert self_link is not None

        # Validate self link properties
        assert self_link["method"] == "GET"
        assert self_link["href"].endswith("/api/info")
        assert "statistics" in self_link["title"].lower() or "overview" in self_link["title"].lower()

    def test_info_options_sub_endpoint_links(self, client: TestClient):
        """Test OPTIONS /api/info includes links to all sub-endpoints."""
        response = client.options("/api/info")

        assert response.status_code == 200
        data = response.json()

        # Find specific sub-endpoint links
        banks_link = next((link for link in data["links"] if link["rel"] == "banks"), None)
        count_link = next((link for link in data["links"] if link["rel"] == "transaction-count"), None)
        summary_link = next((link for link in data["links"] if link["rel"] == "transaction-summary"), None)
        monthly_link = next((link for link in data["links"] if link["rel"] == "monthly-summary"), None)

        # Validate all sub-endpoint links exist
        assert banks_link is not None
        assert count_link is not None
        assert summary_link is not None
        assert monthly_link is not None

        # Validate href paths
        assert banks_link["href"].endswith("/api/info/banks")
        assert count_link["href"].endswith("/api/info/transaction-count")
        assert summary_link["href"].endswith("/api/info/transaction-summary")
        assert monthly_link["href"].endswith("/api/info/monthly-summary")

        # Validate all use GET method
        assert banks_link["method"] == "GET"
        assert count_link["method"] == "GET"
        assert summary_link["method"] == "GET"
        assert monthly_link["method"] == "GET"

    def test_info_options_cors_support(self, client: TestClient):
        """Test OPTIONS /api/info supports CORS preflight requests."""
        response = client.options("/api/info")

        assert response.status_code == 200

        # Validate response is valid JSON
        data = response.json()
        assert data is not None

    def test_info_options_idempotent(self, client: TestClient):
        """Test OPTIONS /api/info is idempotent (returns same results on multiple calls)."""
        response1 = client.options("/api/info")
        response2 = client.options("/api/info")

        assert response1.status_code == 200
        assert response2.status_code == 200

        # Both responses should be identical
        assert response1.json() == response2.json()


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


class TestTransactionCountEndpoint:
    """Test suite for GET /api/info/transaction-count endpoint."""

    def test_get_transaction_count_success(self, client: TestClient, test_db: Session):
        """Test GET /api/info/transaction-count returns count successfully."""
        # Create test data
        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create multiple transactions
        for i in range(5):
            transaction = Transaction(
                date=date.today(),
                bank_account="TestBank",
                recipient_id=recipient.id,
                amount=100.0 + i * 10
            )
            test_db.add(transaction)
        test_db.commit()

        response = client.get("/api/info/transaction-count")

        assert response.status_code == 200
        data = response.json()

        assert "total_transactions" in data
        assert data["total_transactions"] == 5

    def test_get_transaction_count_empty_database(self, client: TestClient, test_db: Session):
        """Test GET /api/info/transaction-count with empty database."""
        response = client.get("/api/info/transaction-count")

        assert response.status_code == 200
        data = response.json()

        assert data["total_transactions"] == 0

    def test_get_transaction_count_large_dataset(self, client: TestClient, test_db: Session):
        """Test GET /api/info/transaction-count with large number of transactions."""
        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create 100 transactions
        for i in range(100):
            transaction = Transaction(
                date=date.today(),
                bank_account="TestBank",
                recipient_id=recipient.id,
                amount=100.0
            )
            test_db.add(transaction)
        test_db.commit()

        response = client.get("/api/info/transaction-count")

        assert response.status_code == 200
        data = response.json()

        assert data["total_transactions"] == 100

    def test_get_transaction_count_database_error(self, client: TestClient, test_db: Session):
        """Test GET /api/info/transaction-count handles database errors."""
        with patch('services.statistics_service.InfoService.get_transaction_count') as mock_count:
            mock_count.side_effect = Exception("Database connection error")

            response = client.get("/api/info/transaction-count")

            assert response.status_code == 500
            assert "Error retrieving transaction count" in response.json()["detail"]

    def test_get_transaction_count_response_schema(self, client: TestClient, test_db: Session):
        """Test GET /api/info/transaction-count returns valid response schema."""
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

        response = client.get("/api/info/transaction-count")

        assert response.status_code == 200
        data = response.json()

        # Validate response schema
        assert "total_transactions" in data
        assert isinstance(data["total_transactions"], int)
        assert data["total_transactions"] >= 0


class TestMonthlyFinancialSummaryEndpoint:
    """Test suite for GET /api/info/monthly-summary endpoint."""

    def test_get_monthly_summary_success(self, client: TestClient, test_db: Session):
        """Test GET /api/info/monthly-summary returns 6-month breakdown successfully."""
        # Create test data spread across different months
        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        today = date.today()

        # Create transactions in different months
        # Current month
        for i in range(3):
            transaction = Transaction(
                date=today - timedelta(days=i),
                bank_account="TestBank",
                recipient_id=recipient.id,
                amount=-100.0 - (i * 10)
            )
            test_db.add(transaction)

        # 2 months ago
        for i in range(2):
            transaction = Transaction(
                date=today - timedelta(days=60 + i),
                bank_account="TestBank",
                recipient_id=recipient.id,
                amount=500.0 + (i * 50)
            )
            test_db.add(transaction)

        test_db.commit()

        response = client.get("/api/info/monthly-summary")

        assert response.status_code == 200
        data = response.json()

        # Validate schema structure
        assert "months" in data
        assert "summary" in data
        assert "links" in data

        # Validate months array
        assert isinstance(data["months"], list)
        assert len(data["months"]) == 6  # Should have 6 months

        # Validate each month has required fields
        for month in data["months"]:
            assert "month" in month
            assert "year" in month
            assert "period_start" in month
            assert "period_end" in month
            assert "total_spending" in month
            assert "total_income" in month
            assert "net_amount" in month
            assert "transaction_count" in month
            assert 1 <= month["month"] <= 12
            assert month["year"] >= 2000

        # Validate summary
        assert "total_spending" in data["summary"]
        assert "total_income" in data["summary"]
        assert "net_amount" in data["summary"]
        assert "transaction_count" in data["summary"]
        assert "period_start" in data["summary"]
        assert "period_end" in data["summary"]

        # Validate HATEOAS links
        assert len(data["links"]) >= 2
        link_rels = [link["rel"] for link in data["links"]]
        assert "self" in link_rels
        assert "parent" in link_rels

    def test_get_monthly_summary_only_spending(self, client: TestClient, test_db: Session):
        """Test GET /api/info/monthly-summary with only spending transactions."""
        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        today = date.today()

        # Only create spending transactions in current month
        for i in range(3):
            transaction = Transaction(
                date=today - timedelta(days=i * 5),
                bank_account="TestBank",
                recipient_id=recipient.id,
                amount=-50.0 - (i * 5)
            )
            test_db.add(transaction)

        test_db.commit()

        response = client.get("/api/info/monthly-summary")

        assert response.status_code == 200
        data = response.json()

        # Validate structure
        assert "months" in data
        assert "summary" in data
        assert len(data["months"]) == 6

        # Find current month in the array (should be last)
        current_month_data = data["months"][-1]
        assert current_month_data["total_spending"] == -165.0  # -50 + -55 + -60
        assert current_month_data["total_income"] == 0.0
        assert current_month_data["net_amount"] == -165.0
        assert current_month_data["transaction_count"] == 3

        # Summary should match
        assert data["summary"]["total_spending"] == -165.0
        assert data["summary"]["total_income"] == 0.0
        assert data["summary"]["transaction_count"] == 3

    def test_get_monthly_summary_only_income(self, client: TestClient, test_db: Session):
        """Test GET /api/info/monthly-summary with only income transactions."""
        recipient = Recipient(name="EMPLOYER")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        today = date.today()

        # Only create income transactions in current month
        for i in range(2):
            transaction = Transaction(
                date=today - timedelta(days=i * 10),
                bank_account="TestBank",
                recipient_id=recipient.id,
                amount=1000.0 + (i * 100)
            )
            test_db.add(transaction)

        test_db.commit()

        response = client.get("/api/info/monthly-summary")

        assert response.status_code == 200
        data = response.json()

        # Validate structure
        assert "months" in data
        assert "summary" in data

        # Summary should show income
        assert data["summary"]["total_spending"] == 0.0
        assert data["summary"]["total_income"] == 2100.0  # 1000 + 1100
        assert data["summary"]["net_amount"] == 2100.0
        assert data["summary"]["transaction_count"] == 2

    def test_get_monthly_summary_empty_database(self, client: TestClient, test_db: Session):
        """Test GET /api/info/monthly-summary with no transactions."""
        response = client.get("/api/info/monthly-summary")

        assert response.status_code == 200
        data = response.json()

        # Validate structure
        assert "months" in data
        assert "summary" in data
        assert "links" in data

        # Should have 6 months, all with zero values
        assert len(data["months"]) == 6
        for month in data["months"]:
            assert month["total_spending"] == 0.0
            assert month["total_income"] == 0.0
            assert month["net_amount"] == 0.0
            assert month["transaction_count"] == 0

        # Summary should be all zeros
        assert data["summary"]["total_spending"] == 0.0
        assert data["summary"]["total_income"] == 0.0
        assert data["summary"]["net_amount"] == 0.0
        assert data["summary"]["transaction_count"] == 0

    def test_get_monthly_summary_outside_date_range(self, client: TestClient, test_db: Session):
        """Test GET /api/info/monthly-summary with transactions outside the past 6 months."""
        recipient = Recipient(name="TEST STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        today = date.today()

        # Create transactions outside the past 6 months (200 days ago)
        transaction = Transaction(
            date=today - timedelta(days=200),
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=-100.0
        )
        test_db.add(transaction)
        test_db.commit()

        response = client.get("/api/info/monthly-summary")

        assert response.status_code == 200
        data = response.json()

        # Should have 6 months but all with zero values (old transaction excluded)
        assert len(data["months"]) == 6
        assert data["summary"]["total_spending"] == 0.0
        assert data["summary"]["total_income"] == 0.0
        assert data["summary"]["net_amount"] == 0.0
        assert data["summary"]["transaction_count"] == 0

    def test_get_monthly_summary_mixed_transactions(self, client: TestClient, test_db: Session):
        """Test GET /api/info/monthly-summary with mixed transaction amounts."""
        recipient = Recipient(name="MIXED STORE")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        today = date.today()

        # Create a mix of positive and negative transactions in current month
        amounts = [-200.0, 1500.0, -50.0, 300.0, -75.5, 100.0]
        for i, amount in enumerate(amounts):
            transaction = Transaction(
                date=today - timedelta(days=i * 3),
                bank_account="TestBank",
                recipient_id=recipient.id,
                amount=amount
            )
            test_db.add(transaction)

        test_db.commit()

        response = client.get("/api/info/monthly-summary")

        assert response.status_code == 200
        data = response.json()

        expected_spending = -200.0 - 50.0 - 75.5  # -325.5
        expected_income = 1500.0 + 300.0 + 100.0  # 1900.0
        expected_net = expected_income + expected_spending  # 1574.5

        # Validate structure
        assert "months" in data
        assert "summary" in data

        # Validate summary totals
        assert abs(data["summary"]["total_spending"] - expected_spending) < 0.01
        assert abs(data["summary"]["total_income"] - expected_income) < 0.01
        assert abs(data["summary"]["net_amount"] - expected_net) < 0.01
        assert data["summary"]["transaction_count"] == 6

    def test_get_monthly_summary_database_error(self, client: TestClient, test_db: Session):
        """Test GET /api/info/monthly-summary handles database errors."""
        with patch('services.statistics_service.InfoService.get_monthly_financial_summary') as mock_summary:
            mock_summary.side_effect = Exception("Database connection error")

            response = client.get("/api/info/monthly-summary")

            assert response.status_code == 500
            assert "Error retrieving monthly financial summary" in response.json()["detail"]

    def test_get_monthly_summary_response_schema(self, client: TestClient, test_db: Session):
        """Test GET /api/info/monthly-summary returns valid response schema."""
        recipient = Recipient(name="TEST")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        transaction = Transaction(
            date=date.today(),
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=-50.0
        )
        test_db.add(transaction)
        test_db.commit()

        response = client.get("/api/info/monthly-summary")

        assert response.status_code == 200
        data = response.json()

        # Validate top-level structure
        assert "months" in data
        assert "summary" in data
        assert "links" in data

        # Validate months is an array of 6 items
        assert isinstance(data["months"], list)
        assert len(data["months"]) == 6

        # Validate month structure
        for month in data["months"]:
            assert "month" in month
            assert "year" in month
            assert "period_start" in month
            assert "period_end" in month
            assert "total_spending" in month
            assert "total_income" in month
            assert "net_amount" in month
            assert "transaction_count" in month

        # Validate summary structure
        assert "total_spending" in data["summary"]
        assert "total_income" in data["summary"]
        assert "net_amount" in data["summary"]
        assert "transaction_count" in data["summary"]
        assert "period_start" in data["summary"]
        assert "period_end" in data["summary"]

        # Validate all required fields are present
        required_fields = [
            "period_start",
            "period_end",
            "total_spending",
            "total_income",
            "net_amount",
            "transaction_count",
            "links"
        ]
        for field in required_fields:
            assert field in data, f"Missing required field: {field}"

        # Validate field types
        assert isinstance(data["total_spending"], (int, float))
        assert isinstance(data["total_income"], (int, float))
        assert isinstance(data["net_amount"], (int, float))
        assert isinstance(data["transaction_count"], int)
        assert isinstance(data["links"], list)

        # Validate spending is non-positive and income is non-negative
        assert data["total_spending"] <= 0.0
        assert data["total_income"] >= 0.0

        # Validate each link has required properties
        for link in data["links"]:
            assert "rel" in link
            assert "href" in link
            assert "method" in link
