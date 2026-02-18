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
        with patch('services.info_service.InfoService.get_statistics') as mock_stats:
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
        with patch('services.info_service.InfoService.get_banks') as mock_banks:
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
        with patch('services.info_service.InfoService.get_transaction_summary') as mock_summary:
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
        with patch('services.info_service.InfoService.get_transaction_count') as mock_count:
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
        with patch('services.info_service.InfoService.get_monthly_financial_summary') as mock_summary:
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

        # Validate top-level required fields
        required_top_level_fields = ["months", "summary", "links"]
        for field in required_top_level_fields:
            assert field in data, f"Missing required top-level field: {field}"

        # Validate field types in summary
        assert isinstance(data["summary"]["total_spending"], (int, float))
        assert isinstance(data["summary"]["total_income"], (int, float))
        assert isinstance(data["summary"]["net_amount"], (int, float))
        assert isinstance(data["summary"]["transaction_count"], int)
        assert isinstance(data["links"], list)

        # Validate spending is non-positive and income is non-negative
        assert data["summary"]["total_spending"] <= 0.0
        assert data["summary"]["total_income"] >= 0.0

        # Validate each link has required properties
        for link in data["links"]:
            assert "rel" in link
            assert "href" in link
            assert "method" in link


class TestPlannedExpensesNextMonthEndpoint:
    """Test suite for GET /api/info/planned-expenses-next-month endpoint."""

    def test_get_planned_expenses_next_month_success(self, client: TestClient, test_db: Session):
        """Test GET /api/info/planned-expenses-next-month returns planned transactions."""
        from database.models import PlannedTransaction
        from datetime import date

        # Create test data
        recipient = Recipient(name="TEST RECIPIENT")
        category = Category(general="FOOD", detail="GROCERIES")
        test_db.add(recipient)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(recipient)
        test_db.refresh(category)

        # Calculate next month
        today = date.today()
        next_month = today.month + 1
        next_year = today.year
        if next_month > 12:
            next_month = 1
            next_year += 1

        # Create planned transactions for next month
        first_day = date(next_year, next_month, 1)
        mid_month = date(next_year, next_month, 15)

        planned_expense = PlannedTransaction(
            planned_date=first_day,
            amount=-100.0,
            recipient_id=recipient.id,
            category_id=category.id,
            memo="Test expense",
            is_recurring=False,
            is_active=True
        )
        planned_income = PlannedTransaction(
            planned_date=mid_month,
            amount=500.0,
            recipient_id=recipient.id,
            memo="Test income",
            is_recurring=True,
            is_active=True
        )
        test_db.add(planned_expense)
        test_db.add(planned_income)
        test_db.commit()

        response = client.get("/api/info/planned-expenses-next-month")

        assert response.status_code == 200
        data = response.json()

        # Validate structure
        assert "month" in data
        assert "year" in data
        assert "period_start" in data
        assert "period_end" in data
        assert "daily_data" in data
        assert "summary" in data
        assert "links" in data

        # Validate period
        assert data["month"] == next_month
        assert data["year"] == next_year

        # Validate summary
        assert data["summary"]["total_income"] == 500.0
        assert data["summary"]["total_expenses"] == -100.0
        assert data["summary"]["net_amount"] == 400.0
        assert data["summary"]["transaction_count"] == 2

    def test_get_planned_expenses_next_month_empty(self, client: TestClient, test_db: Session):
        """Test GET /api/info/planned-expenses-next-month with no planned transactions."""
        response = client.get("/api/info/planned-expenses-next-month")

        assert response.status_code == 200
        data = response.json()

        # Should still return valid structure
        assert "month" in data
        assert "year" in data
        assert "daily_data" in data
        assert "summary" in data

        # Summary should be zero
        assert data["summary"]["total_income"] == 0.0
        assert data["summary"]["total_expenses"] == 0.0
        assert data["summary"]["net_amount"] == 0.0
        assert data["summary"]["transaction_count"] == 0
        assert data["daily_data"] == []

    def test_get_planned_expenses_next_month_only_expenses(self, client: TestClient, test_db: Session):
        """Test GET /api/info/planned-expenses-next-month with only expenses."""
        from database.models import PlannedTransaction
        from datetime import date

        recipient = Recipient(name="TEST")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Calculate next month
        today = date.today()
        next_month = today.month + 1
        next_year = today.year
        if next_month > 12:
            next_month = 1
            next_year += 1

        first_day = date(next_year, next_month, 1)

        planned = PlannedTransaction(
            planned_date=first_day,
            amount=-200.0,
            recipient_id=recipient.id,
            is_active=True
        )
        test_db.add(planned)
        test_db.commit()

        response = client.get("/api/info/planned-expenses-next-month")

        assert response.status_code == 200
        data = response.json()

        assert data["summary"]["total_income"] == 0.0
        assert data["summary"]["total_expenses"] == -200.0
        assert data["summary"]["net_amount"] == -200.0

    def test_get_planned_expenses_next_month_only_income(self, client: TestClient, test_db: Session):
        """Test GET /api/info/planned-expenses-next-month with only income."""
        from database.models import PlannedTransaction
        from datetime import date

        recipient = Recipient(name="TEST")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Calculate next month
        today = date.today()
        next_month = today.month + 1
        next_year = today.year
        if next_month > 12:
            next_month = 1
            next_year += 1

        first_day = date(next_year, next_month, 1)

        planned = PlannedTransaction(
            planned_date=first_day,
            amount=1000.0,
            recipient_id=recipient.id,
            is_active=True
        )
        test_db.add(planned)
        test_db.commit()

        response = client.get("/api/info/planned-expenses-next-month")

        assert response.status_code == 200
        data = response.json()

        assert data["summary"]["total_income"] == 1000.0
        assert data["summary"]["total_expenses"] == 0.0
        assert data["summary"]["net_amount"] == 1000.0

    def test_get_planned_expenses_next_month_inactive_excluded(self, client: TestClient, test_db: Session):
        """Test GET /api/info/planned-expenses-next-month excludes inactive transactions."""
        from database.models import PlannedTransaction
        from datetime import date

        recipient = Recipient(name="TEST")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Calculate next month
        today = date.today()
        next_month = today.month + 1
        next_year = today.year
        if next_month > 12:
            next_month = 1
            next_year += 1

        first_day = date(next_year, next_month, 1)

        # Active transaction
        active = PlannedTransaction(
            planned_date=first_day,
            amount=-100.0,
            recipient_id=recipient.id,
            is_active=True
        )
        # Inactive transaction (should be excluded)
        inactive = PlannedTransaction(
            planned_date=first_day,
            amount=-200.0,
            recipient_id=recipient.id,
            is_active=False
        )
        test_db.add(active)
        test_db.add(inactive)
        test_db.commit()

        response = client.get("/api/info/planned-expenses-next-month")

        assert response.status_code == 200
        data = response.json()

        # Should only include active transaction
        assert data["summary"]["transaction_count"] == 1
        assert data["summary"]["total_expenses"] == -100.0

    def test_get_planned_expenses_next_month_response_schema(self, client: TestClient, test_db: Session):
        """Test GET /api/info/planned-expenses-next-month returns valid schema."""
        from database.models import PlannedTransaction
        from datetime import date

        recipient = Recipient(name="TEST")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Calculate next month
        today = date.today()
        next_month = today.month + 1
        next_year = today.year
        if next_month > 12:
            next_month = 1
            next_year += 1

        first_day = date(next_year, next_month, 1)

        planned = PlannedTransaction(
            planned_date=first_day,
            amount=-50.0,
            recipient_id=recipient.id,
            memo="Test",
            is_recurring=True,
            is_active=True
        )
        test_db.add(planned)
        test_db.commit()

        response = client.get("/api/info/planned-expenses-next-month")

        assert response.status_code == 200
        data = response.json()

        # Validate top-level structure
        required_fields = ["month", "year", "period_start", "period_end", "daily_data", "summary", "links"]
        for field in required_fields:
            assert field in data

        # Validate types
        assert isinstance(data["month"], int)
        assert isinstance(data["year"], int)
        assert isinstance(data["daily_data"], list)
        assert isinstance(data["summary"], dict)
        assert isinstance(data["links"], list)

        # Validate daily_data structure if present
        if len(data["daily_data"]) > 0:
            daily = data["daily_data"][0]
            assert "date" in daily
            assert "income" in daily
            assert "expenses" in daily
            assert "net" in daily
            assert "transactions" in daily
            assert isinstance(daily["transactions"], list)

            # Validate transaction structure
            if len(daily["transactions"]) > 0:
                txn = daily["transactions"][0]
                assert "id" in txn
                assert "amount" in txn
                assert "is_recurring" in txn

        # Validate summary structure
        assert "total_income" in data["summary"]
        assert "total_expenses" in data["summary"]
        assert "net_amount" in data["summary"]
        assert "transaction_count" in data["summary"]

        # Validate constraints
        assert data["summary"]["total_income"] >= 0.0
        assert data["summary"]["total_expenses"] <= 0.0

    def test_get_planned_expenses_next_month_database_error(self, client: TestClient):
        """Test GET /api/info/planned-expenses-next-month handles database errors."""
        with patch("services.info_service.InfoService.get_planned_expenses_next_month") as mock_service:
            mock_service.side_effect = Exception("Database error")

            response = client.get("/api/info/planned-expenses-next-month")

            assert response.status_code == 500
            assert "Error retrieving planned expenses next month" in response.json()["detail"]


class TestAverageVsCurrentSpendingEndpoint:
    """Test suite for GET /api/info/average-vs-current-spending endpoint."""

    def test_get_average_vs_current_spending_success(self, client: TestClient, test_db: Session):
        """Test GET /api/info/average-vs-current-spending returns comparison data."""
        from datetime import date

        recipient = Recipient(name="TEST")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Add transactions from past 6 months
        today = date.today()

        # Past month transactions
        for month_ago in range(1, 7):
            target_month = today.month - month_ago
            target_year = today.year
            while target_month <= 0:
                target_month += 12
                target_year -= 1

            txn_date = date(target_year, target_month, 15)
            txn = Transaction(
                date=txn_date,
                bank_account="TestBank",
                recipient_id=recipient.id,
                amount=-100.0,
                is_active=True
            )
            test_db.add(txn)

        # Current month transaction
        current_txn = Transaction(
            date=today,
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=-50.0,
            is_active=True
        )
        test_db.add(current_txn)
        test_db.commit()

        response = client.get("/api/info/average-vs-current-spending")

        assert response.status_code == 200
        data = response.json()

        # Validate structure
        assert "past_6_months" in data
        assert "current_month" in data
        assert "comparison" in data
        assert "links" in data

        # Validate past_6_months
        assert "period_start" in data["past_6_months"]
        assert "period_end" in data["past_6_months"]
        assert "total_spending" in data["past_6_months"]
        assert "days" in data["past_6_months"]
        assert "average_daily_spending" in data["past_6_months"]
        assert "transaction_count" in data["past_6_months"]

        # Validate current_month
        assert "month" in data["current_month"]
        assert "year" in data["current_month"]
        assert "total_spending" in data["current_month"]
        assert "total_income" in data["current_month"]
        assert "daily_data" in data["current_month"]

        # Validate comparison
        assert "expected_to_date" in data["comparison"]
        assert "actual_to_date" in data["comparison"]
        assert "variance_to_date" in data["comparison"]
        assert "expected_month_total" in data["comparison"]
        assert "projected_month_total" in data["comparison"]

    def test_get_average_vs_current_spending_empty(self, client: TestClient, test_db: Session):
        """Test GET /api/info/average-vs-current-spending with no transactions."""
        response = client.get("/api/info/average-vs-current-spending")

        assert response.status_code == 200
        data = response.json()

        # Should return structure with zeros
        assert data["past_6_months"]["total_spending"] == 0.0
        assert data["past_6_months"]["average_daily_spending"] == 0.0
        assert data["current_month"]["total_spending"] == 0.0
        assert data["current_month"]["total_income"] == 0.0

    def test_get_average_vs_current_spending_only_income(self, client: TestClient, test_db: Session):
        """Test GET /api/info/average-vs-current-spending with only income transactions."""
        from datetime import date

        recipient = Recipient(name="TEST")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        today = date.today()

        # Past income
        past_date = date(today.year, today.month - 1 if today.month > 1 else 12, 15)
        past_txn = Transaction(
            date=past_date,
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=1000.0,
            is_active=True
        )
        test_db.add(past_txn)

        # Current income
        current_txn = Transaction(
            date=today,
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=500.0,
            is_active=True
        )
        test_db.add(current_txn)
        test_db.commit()

        response = client.get("/api/info/average-vs-current-spending")

        assert response.status_code == 200
        data = response.json()

        # Income should not affect spending calculations
        assert data["past_6_months"]["total_spending"] == 0.0
        assert data["current_month"]["total_spending"] == 0.0
        assert data["current_month"]["total_income"] == 500.0

    def test_get_average_vs_current_spending_inactive_excluded(self, client: TestClient, test_db: Session):
        """Test GET /api/info/average-vs-current-spending excludes inactive transactions."""
        from datetime import date

        recipient = Recipient(name="TEST")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        today = date.today()

        # Active transaction
        active = Transaction(
            date=today,
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=-100.0,
            is_active=True
        )
        # Inactive transaction (should be excluded)
        inactive = Transaction(
            date=today,
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=-500.0,
            is_active=False
        )
        test_db.add(active)
        test_db.add(inactive)
        test_db.commit()

        response = client.get("/api/info/average-vs-current-spending")

        assert response.status_code == 200
        data = response.json()

        # Should only include active transaction
        assert data["current_month"]["total_spending"] == -100.0

    def test_get_average_vs_current_spending_daily_data(self, client: TestClient, test_db: Session):
        """Test GET /api/info/average-vs-current-spending daily_data structure."""
        from datetime import date

        recipient = Recipient(name="TEST")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        today = date.today()

        # Add transaction for today
        txn = Transaction(
            date=today,
            bank_account="TestBank",
            recipient_id=recipient.id,
            amount=-75.0,
            is_active=True
        )
        test_db.add(txn)
        test_db.commit()

        response = client.get("/api/info/average-vs-current-spending")

        assert response.status_code == 200
        data = response.json()

        # Validate daily_data
        assert isinstance(data["current_month"]["daily_data"], list)
        assert len(data["current_month"]["daily_data"]) == today.day

        # Check today's entry
        today_data = data["current_month"]["daily_data"][-1]
        assert "date" in today_data
        assert "spending" in today_data
        assert "income" in today_data
        assert "transaction_count" in today_data
        assert "cumulative_spending" in today_data
        assert "cumulative_expected" in today_data
        assert "variance" in today_data

        assert today_data["spending"] == -75.0
        assert today_data["transaction_count"] == 1

    def test_get_average_vs_current_spending_response_schema(self, client: TestClient, test_db: Session):
        """Test GET /api/info/average-vs-current-spending returns valid schema."""
        response = client.get("/api/info/average-vs-current-spending")

        assert response.status_code == 200
        data = response.json()

        # Validate top-level structure
        required_fields = ["past_6_months", "current_month", "comparison", "links"]
        for field in required_fields:
            assert field in data

        # Validate types
        assert isinstance(data["past_6_months"], dict)
        assert isinstance(data["current_month"], dict)
        assert isinstance(data["comparison"], dict)
        assert isinstance(data["links"], list)

        # Validate past_6_months fields
        past_fields = ["period_start", "period_end", "total_spending", "days", "average_daily_spending",
                       "transaction_count"]
        for field in past_fields:
            assert field in data["past_6_months"]

        # Validate current_month fields
        current_fields = ["month", "year", "period_start", "period_end", "days_elapsed", "total_spending",
                          "total_income", "daily_data", "transaction_count"]
        for field in current_fields:
            assert field in data["current_month"]

        # Validate comparison fields
        comparison_fields = ["expected_to_date", "actual_to_date", "variance_to_date", "expected_month_total",
                             "projected_month_total"]
        for field in comparison_fields:
            assert field in data["comparison"]

        # Validate constraints
        assert data["past_6_months"]["total_spending"] <= 0.0
        assert data["past_6_months"]["average_daily_spending"] <= 0.0
        assert data["current_month"]["total_spending"] <= 0.0
        assert data["current_month"]["total_income"] >= 0.0
        assert data["comparison"]["expected_to_date"] <= 0.0
        assert data["comparison"]["actual_to_date"] <= 0.0

    def test_get_average_vs_current_spending_database_error(self, client: TestClient):
        """Test GET /api/info/average-vs-current-spending handles database errors."""
        with patch("services.info_service.InfoService.get_average_vs_current_spending") as mock_service:
            mock_service.side_effect = Exception("Database error")

            response = client.get("/api/info/average-vs-current-spending")

            assert response.status_code == 500
            assert "Error retrieving average vs current spending" in response.json()["detail"]
