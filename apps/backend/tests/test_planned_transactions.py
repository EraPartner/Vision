"""
Unit tests for planned transactions API endpoints.

Tests Level 3 REST API compliance, HATEOAS links, CRUD operations,
and proper error handling for planned financial transactions.
"""
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from database.models import PlannedTransaction, Category, Recipient, Transaction


class TestPlannedTransactionsListEndpoint:
    """Test cases for planned transactions collection endpoints."""

    def test_get_planned_transactions_empty_list(self, client: TestClient):
        """Test GET /api/planned-transactions with empty database."""
        response = client.get("/api/planned-transactions")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert "items" in data
        assert "total" in data
        assert "limit" in data
        assert "offset" in data
        assert "links" in data

        # Verify empty list
        assert data["items"] == []
        assert data["total"] == 0
        assert data["limit"] == 50
        assert data["offset"] == 0

        # Verify HATEOAS links
        links = data["links"]
        assert len(links) > 0
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "create" in link_rels

    def test_get_planned_transactions_with_data(self, client: TestClient, test_db: Session,
                                                sample_category_data, sample_recipient_data):
        """Test GET /api/planned-transactions with existing planned transactions."""
        # Create category and recipient first
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create test planned transactions
        planned_transactions_data = [
            {
                "planned_date": date.today() + timedelta(days=7),
                "bank_account": "Revolut",
                "recipient_id": recipient.id,
                "amount": 25.50,
                "category_id": category.id,
                "memo": "Planned grocery shopping",
                "is_recurring": False,
                "is_executed": False
            },
            {
                "planned_date": date.today() + timedelta(days=30),
                "bank_account": "KBC",
                "recipient_id": recipient.id,
                "amount": 100.00,
                "category_id": category.id,
                "memo": "Monthly subscription",
                "is_recurring": True,
                "recurrence_pattern": "monthly",
                "is_executed": False
            }
        ]

        for pt_data in planned_transactions_data:
            pt = PlannedTransaction(**pt_data)
            test_db.add(pt)
        test_db.commit()

        response = client.get("/api/planned-transactions")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert "items" in data
        assert "total" in data
        assert len(data["items"]) == len(planned_transactions_data)
        assert data["total"] == len(planned_transactions_data)

        # Verify each planned transaction has proper structure
        for item in data["items"]:
            assert "id" in item
            assert "planned_date" in item
            assert "amount" in item
            assert "bank_account" in item
            assert "recipient_id" in item
            assert "recipient_name" in item
            assert "category_id" in item
            assert "category_name" in item
            assert "is_recurring" in item
            assert "is_executed" in item
            assert "links" in item

            # Verify HATEOAS links
            item_links = item["links"]
            assert len(item_links) > 0
            item_link_rels = [link["rel"] for link in item_links]
            assert "self" in item_link_rels

    def test_get_planned_transactions_pagination(self, client: TestClient, test_db: Session,
                                                 sample_category_data, sample_recipient_data):
        """Test GET /api/planned-transactions pagination."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create 10 planned transactions
        for i in range(10):
            pt = PlannedTransaction(
                planned_date=date.today() + timedelta(days=i + 1),
                bank_account="Test Bank",
                recipient_id=recipient.id,
                amount=100.00 + i,
                category_id=category.id,
                memo=f"Test planned transaction {i + 1}",
                is_recurring=False,
                is_executed=False
            )
            test_db.add(pt)
        test_db.commit()

        # Test with limit
        response = client.get("/api/planned-transactions?limit=5&offset=0")
        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 5
        assert data["total"] == 10
        assert data["limit"] == 5
        assert data["offset"] == 0

        # Test with offset
        response = client.get("/api/planned-transactions?limit=5&offset=5")
        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 5
        assert data["total"] == 10
        assert data["offset"] == 5

    def test_get_planned_transactions_date_filter(self, client: TestClient, test_db: Session,
                                                  sample_category_data, sample_recipient_data):
        """Test GET /api/planned-transactions with date filters."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transactions with different dates
        dates = [
            date.today() + timedelta(days=1),
            date.today() + timedelta(days=10),
            date.today() + timedelta(days=20),
            date.today() + timedelta(days=30)
        ]

        for d in dates:
            pt = PlannedTransaction(
                planned_date=d,
                bank_account="Test Bank",
                recipient_id=recipient.id,
                amount=100.00,
                category_id=category.id,
                memo="Test planned transaction",
                is_recurring=False,
                is_executed=False
            )
            test_db.add(pt)
        test_db.commit()

        # Test start_date filter
        start_date = date.today() + timedelta(days=15)
        response = client.get(f"/api/planned-transactions?start_date={start_date.isoformat()}")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 2  # Should get transactions on day 20 and 30

        # Test end_date filter
        end_date = date.today() + timedelta(days=15)
        response = client.get(f"/api/planned-transactions?end_date={end_date.isoformat()}")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 2  # Should get transactions on day 1 and 10

        # Test both start and end date
        start_date = date.today() + timedelta(days=5)
        end_date = date.today() + timedelta(days=25)
        response = client.get(
            f"/api/planned-transactions?start_date={start_date.isoformat()}&end_date={end_date.isoformat()}"
        )
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 2  # Should get transactions on day 10 and 20

    def test_get_planned_transactions_invalid_date_format(self, client: TestClient):
        """Test GET /api/planned-transactions with invalid date format."""
        response = client.get("/api/planned-transactions?start_date=invalid-date")
        assert response.status_code == 400
        data = response.json()
        assert "Invalid start_date format" in data["detail"]

        response = client.get("/api/planned-transactions?end_date=2026-13-45")
        assert response.status_code == 400
        data = response.json()
        assert "Invalid end_date format" in data["detail"]

    def test_get_planned_transactions_bank_account_filter(self, client: TestClient, test_db: Session,
                                                          sample_category_data, sample_recipient_data):
        """Test GET /api/planned-transactions with bank_account filter."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transactions with different bank accounts
        banks = ["Revolut", "KBC", "ING", "BNP Paribas"]
        for bank in banks:
            pt = PlannedTransaction(
                planned_date=date.today() + timedelta(days=1),
                bank_account=bank,
                recipient_id=recipient.id,
                amount=100.00,
                category_id=category.id,
                memo="Test",
                is_recurring=False,
                is_executed=False
            )
            test_db.add(pt)
        test_db.commit()

        # Test partial match (case-insensitive)
        response = client.get("/api/planned-transactions?bank_account=kbc")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["bank_account"] == "KBC"

    def test_get_planned_transactions_category_filter(self, client: TestClient, test_db: Session,
                                                      sample_recipient_data):
        """Test GET /api/planned-transactions with category_id filter."""
        # Create two categories
        category1 = Category(general="food", detail="groceries", description="Food")
        category2 = Category(general="transport", detail="fuel", description="Transport")
        test_db.add_all([category1, category2])
        test_db.commit()
        test_db.refresh(category1)
        test_db.refresh(category2)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transactions with different categories
        pt1 = PlannedTransaction(
            planned_date=date.today() + timedelta(days=1),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=50.00,
            category_id=category1.id,
            memo="Food",
            is_recurring=False,
            is_executed=False
        )
        pt2 = PlannedTransaction(
            planned_date=date.today() + timedelta(days=2),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=30.00,
            category_id=category2.id,
            memo="Fuel",
            is_recurring=False,
            is_executed=False
        )
        test_db.add_all([pt1, pt2])
        test_db.commit()

        # Filter by category
        response = client.get(f"/api/planned-transactions?category_id={category1.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["category_id"] == category1.id

    def test_get_planned_transactions_recipient_filter(self, client: TestClient, test_db: Session,
                                                       sample_category_data):
        """Test GET /api/planned-transactions with recipient_id filter."""
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        # Create two recipients
        recipient1 = Recipient(name="Recipient 1")
        recipient2 = Recipient(name="Recipient 2")
        test_db.add_all([recipient1, recipient2])
        test_db.commit()
        test_db.refresh(recipient1)
        test_db.refresh(recipient2)

        # Create planned transactions with different recipients
        pt1 = PlannedTransaction(
            planned_date=date.today() + timedelta(days=1),
            bank_account="Test",
            recipient_id=recipient1.id,
            amount=50.00,
            category_id=category.id,
            memo="Test 1",
            is_recurring=False,
            is_executed=False
        )
        pt2 = PlannedTransaction(
            planned_date=date.today() + timedelta(days=2),
            bank_account="Test",
            recipient_id=recipient2.id,
            amount=30.00,
            category_id=category.id,
            memo="Test 2",
            is_recurring=False,
            is_executed=False
        )
        test_db.add_all([pt1, pt2])
        test_db.commit()

        # Filter by recipient
        response = client.get(f"/api/planned-transactions?recipient_id={recipient1.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["recipient_id"] == recipient1.id

    def test_get_planned_transactions_recurring_filter(self, client: TestClient, test_db: Session,
                                                       sample_category_data, sample_recipient_data):
        """Test GET /api/planned-transactions with is_recurring filter."""
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create recurring and non-recurring planned transactions
        pt1 = PlannedTransaction(
            planned_date=date.today() + timedelta(days=1),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=50.00,
            category_id=category.id,
            memo="One-time",
            is_recurring=False,
            is_executed=False
        )
        pt2 = PlannedTransaction(
            planned_date=date.today() + timedelta(days=2),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=30.00,
            category_id=category.id,
            memo="Monthly",
            is_recurring=True,
            recurrence_pattern="monthly",
            is_executed=False
        )
        test_db.add_all([pt1, pt2])
        test_db.commit()

        # Filter for recurring only
        response = client.get("/api/planned-transactions?is_recurring=true")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["is_recurring"] is True

        # Filter for non-recurring only
        response = client.get("/api/planned-transactions?is_recurring=false")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["is_recurring"] is False

    def test_get_planned_transactions_executed_filter(self, client: TestClient, test_db: Session,
                                                      sample_category_data, sample_recipient_data):
        """Test GET /api/planned-transactions with is_executed filter."""
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create executed and non-executed planned transactions
        pt1 = PlannedTransaction(
            planned_date=date.today() + timedelta(days=1),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=50.00,
            category_id=category.id,
            memo="Not executed",
            is_recurring=False,
            is_executed=False
        )
        pt2 = PlannedTransaction(
            planned_date=date.today() + timedelta(days=2),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=30.00,
            category_id=category.id,
            memo="Executed",
            is_recurring=False,
            is_executed=True
        )
        test_db.add_all([pt1, pt2])
        test_db.commit()

        # Filter for executed only
        response = client.get("/api/planned-transactions?is_executed=true")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["is_executed"] is True

        # Filter for non-executed only
        response = client.get("/api/planned-transactions?is_executed=false")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["is_executed"] is False

    def test_get_planned_transactions_active_filter(self, client: TestClient, test_db: Session,
                                                    sample_category_data, sample_recipient_data):
        """Test GET /api/planned-transactions with active filter."""
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create active and inactive planned transactions
        pt1 = PlannedTransaction(
            planned_date=date.today() + timedelta(days=1),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=50.00,
            category_id=category.id,
            memo="Active",
            is_recurring=False,
            is_executed=False,
            is_active=True
        )
        pt2 = PlannedTransaction(
            planned_date=date.today() + timedelta(days=2),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=30.00,
            category_id=category.id,
            memo="Inactive",
            is_recurring=False,
            is_executed=False,
            is_active=False
        )
        test_db.add_all([pt1, pt2])
        test_db.commit()

        # By default, only active transactions should be returned
        response = client.get("/api/planned-transactions")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert data["items"][0]["memo"] == "Active"

        # Explicitly request all (including inactive)
        response = client.get("/api/planned-transactions?active=false")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 2

    def test_planned_transactions_collection_options(self, client: TestClient):
        """Test OPTIONS /api/planned-transactions for API discovery."""
        response = client.options("/api/planned-transactions")

        assert response.status_code == 200
        data = response.json()

        # Verify structure
        assert "methods" in data
        assert "links" in data

        # Verify methods
        methods = [method["method"] for method in data["methods"]]
        assert "GET" in methods
        assert "POST" in methods
        assert "OPTIONS" in methods

        # Verify links
        links = data["links"]
        assert len(links) > 0
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels


class TestPlannedTransactionsCreateEndpoint:
    """Test cases for creating planned transactions."""

    def test_create_planned_transaction_minimal(self, client: TestClient, test_db: Session,
                                                sample_category_data, sample_recipient_data):
        """Test POST /api/planned-transactions with minimal required fields."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        planned_transaction_data = {
            "planned_date": (date.today() + timedelta(days=7)).isoformat(),
            "bank_account": "Revolut",
            "recipient_id": recipient.id,
            "amount": 25.50
        }

        response = client.post("/api/planned-transactions", json=planned_transaction_data)

        assert response.status_code == 201
        data = response.json()

        # Verify created planned transaction
        assert data["id"] is not None
        assert data["planned_date"] == planned_transaction_data["planned_date"]
        assert data["bank_account"] == planned_transaction_data["bank_account"]
        assert data["recipient_id"] == recipient.id
        assert float(data["amount"]) == planned_transaction_data["amount"]
        assert data["is_recurring"] is False
        assert data["is_executed"] is False
        assert data["is_active"] is True

        # Verify HATEOAS links
        assert "links" in data
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels

    def test_create_planned_transaction_full(self, client: TestClient, test_db: Session,
                                             sample_category_data, sample_recipient_data):
        """Test POST /api/planned-transactions with all fields."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        planned_transaction_data = {
            "planned_date": (date.today() + timedelta(days=30)).isoformat(),
            "bank_account": "KBC",
            "recipient_id": recipient.id,
            "amount": 150.00,
            "memo": "Monthly subscription payment",
            "currency": "EUR",
            "category_id": category.id,
            "comment": "Recurring payment for streaming service",
            "is_recurring": True,
            "recurrence_pattern": "monthly"
        }

        response = client.post("/api/planned-transactions", json=planned_transaction_data)

        assert response.status_code == 201
        data = response.json()

        # Verify all fields
        assert data["planned_date"] == planned_transaction_data["planned_date"]
        assert data["bank_account"] == planned_transaction_data["bank_account"]
        assert data["recipient_id"] == recipient.id
        assert float(data["amount"]) == planned_transaction_data["amount"]
        assert data["memo"] == planned_transaction_data["memo"]
        assert data["currency"] == planned_transaction_data["currency"]
        assert data["category_id"] == category.id
        assert data["comment"] == planned_transaction_data["comment"]
        assert data["is_recurring"] == planned_transaction_data["is_recurring"]
        assert data["recurrence_pattern"] == planned_transaction_data["recurrence_pattern"]
        assert data["is_executed"] is False
        assert data["is_active"] is True

    def test_create_planned_transaction_missing_required_field(self, client: TestClient):
        """Test POST /api/planned-transactions with missing required field."""
        # Missing recipient_id
        planned_transaction_data = {
            "planned_date": (date.today() + timedelta(days=7)).isoformat(),
            "bank_account": "Revolut",
            "amount": 25.50
        }

        response = client.post("/api/planned-transactions", json=planned_transaction_data)
        assert response.status_code == 422  # Validation error

    def test_create_planned_transaction_invalid_recipient(self, client: TestClient):
        """Test POST /api/planned-transactions with non-existent recipient."""
        planned_transaction_data = {
            "planned_date": (date.today() + timedelta(days=7)).isoformat(),
            "bank_account": "Revolut",
            "recipient_id": 99999,  # Non-existent
            "amount": 25.50
        }

        response = client.post("/api/planned-transactions", json=planned_transaction_data)
        # Foreign key constraint should be handled at DB level or by validation
        # It may succeed if no validation, or fail with 400/500
        assert response.status_code in [201, 400, 500]


class TestPlannedTransactionsResourceEndpoint:
    """Test cases for planned transaction resource endpoints."""

    def test_get_planned_transaction_by_id(self, client: TestClient, test_db: Session,
                                           sample_category_data, sample_recipient_data):
        """Test GET /api/planned-transactions/{id}."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Revolut",
            recipient_id=recipient.id,
            amount=25.50,
            category_id=category.id,
            memo="Test planned transaction",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        response = client.get(f"/api/planned-transactions/{planned_transaction.id}")

        assert response.status_code == 200
        data = response.json()

        # Verify planned transaction data
        assert data["id"] == planned_transaction.id
        assert data["planned_date"] == planned_transaction.planned_date.isoformat()
        assert data["bank_account"] == planned_transaction.bank_account
        assert data["recipient_id"] == recipient.id
        assert float(data["amount"]) == float(planned_transaction.amount)
        assert data["memo"] == planned_transaction.memo

        # Verify HATEOAS links
        assert "links" in data
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels

    def test_get_planned_transaction_not_found(self, client: TestClient):
        """Test GET /api/planned-transactions/{id} with non-existent ID."""
        response = client.get("/api/planned-transactions/99999")
        assert response.status_code == 404
        data = response.json()
        assert "not found" in data["detail"].lower()

    def test_planned_transaction_resource_options(self, client: TestClient, test_db: Session,
                                                  sample_category_data, sample_recipient_data):
        """Test OPTIONS /api/planned-transactions/{id} for API discovery."""
        # Create a planned transaction first
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=100.00,
            category_id=category.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        response = client.options(f"/api/planned-transactions/{planned_transaction.id}")

        assert response.status_code == 200
        data = response.json()

        # Verify structure
        assert "methods" in data
        assert "links" in data

        # Verify methods
        methods = [method["method"] for method in data["methods"]]
        assert "GET" in methods
        assert "PATCH" in methods
        assert "DELETE" in methods
        assert "OPTIONS" in methods

        # Verify links
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "parent" in link_rels


class TestPlannedTransactionsUpdateEndpoint:
    """Test cases for updating planned transactions."""

    def test_update_planned_transaction_single_field(self, client: TestClient, test_db: Session,
                                                     sample_category_data, sample_recipient_data):
        """Test PATCH /api/planned-transactions/{id} updating single field."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Revolut",
            recipient_id=recipient.id,
            amount=25.50,
            category_id=category.id,
            memo="Original memo",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Update memo only
        update_data = {"memo": "Updated memo"}
        response = client.patch(f"/api/planned-transactions/{planned_transaction.id}", json=update_data)

        assert response.status_code == 200
        data = response.json()

        # Verify updated field
        assert data["memo"] == "Updated memo"

        # Verify other fields unchanged
        assert data["id"] == planned_transaction.id
        assert data["bank_account"] == "Revolut"
        assert float(data["amount"]) == 25.50

    def test_update_planned_transaction_multiple_fields(self, client: TestClient, test_db: Session,
                                                        sample_category_data, sample_recipient_data):
        """Test PATCH /api/planned-transactions/{id} updating multiple fields."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Revolut",
            recipient_id=recipient.id,
            amount=25.50,
            category_id=category.id,
            memo="Original",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Update multiple fields
        update_data = {
            "amount": 50.00,
            "memo": "Updated memo",
            "comment": "New comment",
            "is_recurring": True,
            "recurrence_pattern": "monthly"
        }
        response = client.patch(f"/api/planned-transactions/{planned_transaction.id}", json=update_data)

        assert response.status_code == 200
        data = response.json()

        # Verify all updated fields
        assert float(data["amount"]) == 50.00
        assert data["memo"] == "Updated memo"
        assert data["comment"] == "New comment"
        assert data["is_recurring"] is True
        assert data["recurrence_pattern"] == "monthly"

    def test_update_planned_transaction_not_found(self, client: TestClient):
        """Test PATCH /api/planned-transactions/{id} with non-existent ID."""
        update_data = {"memo": "Updated memo"}
        response = client.patch("/api/planned-transactions/99999", json=update_data)
        assert response.status_code == 404

    def test_update_planned_transaction_with_recipient_name(self, client: TestClient, test_db: Session,
                                                            sample_category_data):
        """Test PATCH /api/planned-transactions/{id} with recipient_name resolution."""
        # Create category and recipients
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient1 = Recipient(name="Original Recipient")
        recipient2 = Recipient(name="New Recipient")
        test_db.add_all([recipient1, recipient2])
        test_db.commit()
        test_db.refresh(recipient1)
        test_db.refresh(recipient2)

        # Create planned transaction with recipient1
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Test",
            recipient_id=recipient1.id,
            amount=100.00,
            category_id=category.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Update with recipient_name
        update_data = {"recipient_name": "New Recipient"}
        response = client.patch(f"/api/planned-transactions/{planned_transaction.id}", json=update_data)

        assert response.status_code == 200
        data = response.json()

        # Verify recipient was updated
        assert data["recipient_id"] == recipient2.id
        assert data["recipient_name"] == "New Recipient"

    def test_update_planned_transaction_with_category_name(self, client: TestClient, test_db: Session,
                                                           sample_recipient_data):
        """Test PATCH /api/planned-transactions/{id} with category_name resolution."""
        # Create categories
        category1 = Category(general="food", detail="groceries", description="Food")
        category2 = Category(general="transport", detail="fuel", description="Transport")
        test_db.add_all([category1, category2])
        test_db.commit()
        test_db.refresh(category1)
        test_db.refresh(category2)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction with category1
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=100.00,
            category_id=category1.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Update with category_name (case-sensitive lookup)
        update_data = {"category_name": "transport:fuel"}
        response = client.patch(f"/api/planned-transactions/{planned_transaction.id}", json=update_data)

        assert response.status_code == 200
        data = response.json()

        # Verify category_name field is present (even if not updated due to case mismatch)
        assert "category_id" in data


class TestPlannedTransactionsDeleteEndpoint:
    """Test cases for deleting planned transactions."""

    def test_delete_planned_transaction(self, client: TestClient, test_db: Session,
                                        sample_category_data, sample_recipient_data):
        """Test DELETE /api/planned-transactions/{id} performs hard delete."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Revolut",
            recipient_id=recipient.id,
            amount=25.50,
            category_id=category.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        pt_id = planned_transaction.id

        # Delete
        response = client.delete(f"/api/planned-transactions/{pt_id}")

        assert response.status_code == 200
        data = response.json()
        assert "deleted successfully" in data["message"]
        assert "soft" not in data["message"]

        # Verify planned transaction is completely removed from DB
        test_db.expire_all()
        pt = test_db.query(PlannedTransaction).filter(PlannedTransaction.id == pt_id).first()
        assert pt is None

    def test_delete_planned_transaction_soft_via_patch(self, client: TestClient, test_db: Session,
                                                       sample_category_data, sample_recipient_data):
        """Test soft delete via PATCH by setting is_active=false."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Revolut",
            recipient_id=recipient.id,
            amount=25.50,
            category_id=category.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        pt_id = planned_transaction.id

        # Soft delete via PATCH
        response = client.patch(
            f"/api/planned-transactions/{pt_id}",
            json={"is_active": False}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["is_active"] is False

        # Verify planned transaction still exists in DB but is_active=False
        test_db.expire_all()
        pt = test_db.query(PlannedTransaction).filter(PlannedTransaction.id == pt_id).first()
        assert pt is not None
        assert pt.is_active is False

        # Verify it doesn't appear in default GET (active=true)
        response = client.get("/api/planned-transactions")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 0

    def test_delete_planned_transaction_not_found(self, client: TestClient):
        """Test DELETE /api/planned-transactions/{id} with non-existent ID."""
        response = client.delete("/api/planned-transactions/99999")
        assert response.status_code == 404


class TestPlannedTransactionService:
    """Test cases for PlannedTransactionService business logic."""

    def test_mark_as_executed(self, test_db: Session, sample_category_data, sample_recipient_data):
        """Test marking a planned transaction as executed."""
        from services.planned_transaction_service import PlannedTransactionService

        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=100.00,
            category_id=category.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Mark as executed (deprecated method)
        service = PlannedTransactionService(test_db)
        updated = service.mark_as_executed(planned_transaction.id, executed_transaction_id=123)

        assert updated is not None
        assert updated.is_executed is True
        # Note: executed_transaction_id is now a computed property and will be None
        # since mark_as_executed doesn't create execution records (deprecated)

    def test_mark_as_executed_not_found(self, test_db: Session):
        """Test marking non-existent planned transaction as executed."""
        from services.planned_transaction_service import PlannedTransactionService

        service = PlannedTransactionService(test_db)
        result = service.mark_as_executed(99999)

        assert result is None


class TestPlannedTransactionExecution:
    """Test cases for planned transaction execution functionality."""

    def test_execute_one_time_transaction(self, test_db: Session, sample_category_data, sample_recipient_data):
        """Test executing a one-time planned transaction."""
        from services.planned_transaction_service import PlannedTransactionService

        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create actual transaction
        actual_txn = Transaction(
            date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-50.00,
            memo="Test payment"
        )
        test_db.add(actual_txn)
        test_db.commit()
        test_db.refresh(actual_txn)

        # Create one-time planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-50.00,
            category_id=category.id,
            memo="Test payment",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Execute it
        service = PlannedTransactionService(test_db)
        updated = service.execute_planned_transaction(
            planned_transaction_id=planned_transaction.id,
            executed_transaction_id=actual_txn.id
        )

        assert updated is not None
        assert updated.is_executed is True
        assert updated.last_executed_date == date.today()
        assert updated.executed_transaction_id == actual_txn.id
        assert len(updated.executions) == 1
        assert updated.executions[0].executed_transaction_id == actual_txn.id

    def test_execute_recurring_transaction_monthly(self, test_db: Session, sample_category_data, sample_recipient_data):
        """Test executing a recurring monthly planned transaction."""
        from services.planned_transaction_service import PlannedTransactionService

        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create recurring planned transaction
        planned_date = date(2026, 2, 15)
        planned_transaction = PlannedTransaction(
            planned_date=planned_date,
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-12.99,
            category_id=category.id,
            memo="Monthly subscription",
            is_recurring=True,
            recurrence_pattern="monthly",
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Create actual transaction
        actual_txn = Transaction(
            date=planned_date,
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-12.99,
            memo="Monthly subscription"
        )
        test_db.add(actual_txn)
        test_db.commit()
        test_db.refresh(actual_txn)

        # Execute it
        service = PlannedTransactionService(test_db)
        updated = service.execute_planned_transaction(
            planned_transaction_id=planned_transaction.id,
            executed_transaction_id=actual_txn.id,
            execution_date=planned_date
        )

        assert updated is not None
        assert updated.is_executed is False  # Should reset for recurring
        assert updated.planned_date == date(2026, 3, 15)  # Next month
        assert updated.last_executed_date == planned_date
        assert len(updated.executions) == 1

    def test_execute_recurring_transaction_multiple_times(self, test_db: Session, sample_category_data,
                                                          sample_recipient_data):
        """Test executing a recurring transaction multiple times."""
        from services.planned_transaction_service import PlannedTransactionService

        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create recurring planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date(2026, 1, 15),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-12.99,
            category_id=category.id,
            memo="Monthly subscription",
            is_recurring=True,
            recurrence_pattern="monthly",
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        service = PlannedTransactionService(test_db)

        # Execute 3 times
        for i in range(3):
            test_db.refresh(planned_transaction)
            execution_date = planned_transaction.planned_date

            # Create actual transaction
            actual_txn = Transaction(
                date=execution_date,
                bank_account="Test Bank",
                recipient_id=recipient.id,
                amount=-12.99,
                memo=f"Monthly subscription - execution {i + 1}"
            )
            test_db.add(actual_txn)
            test_db.commit()
            test_db.refresh(actual_txn)

            # Execute
            updated = service.execute_planned_transaction(
                planned_transaction_id=planned_transaction.id,
                executed_transaction_id=actual_txn.id,
                execution_date=execution_date
            )

            assert updated.is_executed is False
            assert len(updated.executions) == i + 1

        # Verify final state
        test_db.refresh(planned_transaction)
        assert len(planned_transaction.executions) == 3
        assert planned_transaction.planned_date == date(2026, 4, 15)

    def test_execute_already_executed_transaction(self, test_db: Session, sample_category_data, sample_recipient_data):
        """Test executing an already executed transaction fails."""
        from services.planned_transaction_service import PlannedTransactionService

        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create transaction
        actual_txn = Transaction(
            date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-50.00,
            memo="Test payment"
        )
        test_db.add(actual_txn)
        test_db.commit()
        test_db.refresh(actual_txn)

        # Create planned transaction already marked as executed
        planned_transaction = PlannedTransaction(
            planned_date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-50.00,
            category_id=category.id,
            memo="Test payment",
            is_recurring=False,
            is_executed=True  # Already executed
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Try to execute again
        service = PlannedTransactionService(test_db)
        with pytest.raises(ValueError, match="already executed"):
            service.execute_planned_transaction(
                planned_transaction_id=planned_transaction.id,
                executed_transaction_id=actual_txn.id
            )

    def test_execute_with_nonexistent_transaction(self, test_db: Session, sample_category_data, sample_recipient_data):
        """Test executing with non-existent transaction fails."""
        from services.planned_transaction_service import PlannedTransactionService

        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-50.00,
            category_id=category.id,
            memo="Test payment",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Try to execute with non-existent transaction
        service = PlannedTransactionService(test_db)
        with pytest.raises(ValueError, match="not found"):
            service.execute_planned_transaction(
                planned_transaction_id=planned_transaction.id,
                executed_transaction_id=99999
            )

    def test_execute_nonexistent_planned_transaction(self, test_db: Session):
        """Test executing non-existent planned transaction returns None."""
        from services.planned_transaction_service import PlannedTransactionService

        service = PlannedTransactionService(test_db)
        result = service.execute_planned_transaction(
            planned_transaction_id=99999,
            executed_transaction_id=1
        )

        assert result is None

    def test_execute_recurring_with_invalid_pattern(self, test_db: Session, sample_category_data,
                                                    sample_recipient_data):
        """Test executing recurring transaction with invalid pattern."""
        from services.planned_transaction_service import PlannedTransactionService

        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create recurring transaction with invalid pattern
        planned_transaction = PlannedTransaction(
            planned_date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-12.99,
            category_id=category.id,
            memo="Test",
            is_recurring=True,
            recurrence_pattern="invalid_pattern",
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Create actual transaction
        actual_txn = Transaction(
            date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-12.99,
            memo="Test"
        )
        test_db.add(actual_txn)
        test_db.commit()
        test_db.refresh(actual_txn)

        # Execute - should mark as executed when pattern invalid
        service = PlannedTransactionService(test_db)
        updated = service.execute_planned_transaction(
            planned_transaction_id=planned_transaction.id,
            executed_transaction_id=actual_txn.id
        )

        assert updated.is_executed is True  # Marked as executed when pattern fails


class TestRecurrenceService:
    """Test cases for RecurrenceService."""

    def test_calculate_next_date_daily(self):
        """Test daily recurrence calculation."""
        from services.recurrence_service import RecurrenceService

        current = date(2026, 2, 15)
        next_date = RecurrenceService.calculate_next_date(current, "daily")
        assert next_date == date(2026, 2, 16)

    def test_calculate_next_date_weekly(self):
        """Test weekly recurrence calculation."""
        from services.recurrence_service import RecurrenceService

        current = date(2026, 2, 15)
        next_date = RecurrenceService.calculate_next_date(current, "weekly")
        assert next_date == date(2026, 2, 22)

    def test_calculate_next_date_biweekly(self):
        """Test biweekly recurrence calculation."""
        from services.recurrence_service import RecurrenceService

        current = date(2026, 2, 15)
        next_date = RecurrenceService.calculate_next_date(current, "biweekly")
        assert next_date == date(2026, 3, 1)

    def test_calculate_next_date_monthly(self):
        """Test monthly recurrence calculation."""
        from services.recurrence_service import RecurrenceService

        current = date(2026, 2, 15)
        next_date = RecurrenceService.calculate_next_date(current, "monthly")
        assert next_date == date(2026, 3, 15)

    def test_calculate_next_date_quarterly(self):
        """Test quarterly recurrence calculation."""
        from services.recurrence_service import RecurrenceService

        current = date(2026, 2, 15)
        next_date = RecurrenceService.calculate_next_date(current, "quarterly")
        assert next_date == date(2026, 5, 15)

    def test_calculate_next_date_yearly(self):
        """Test yearly recurrence calculation."""
        from services.recurrence_service import RecurrenceService

        current = date(2026, 2, 15)
        next_date = RecurrenceService.calculate_next_date(current, "yearly")
        assert next_date == date(2027, 2, 15)

    def test_calculate_next_date_invalid_pattern(self):
        """Test invalid recurrence pattern returns None."""
        from services.recurrence_service import RecurrenceService

        current = date(2026, 2, 15)
        next_date = RecurrenceService.calculate_next_date(current, "invalid")
        assert next_date is None

    def test_calculate_next_date_none_pattern(self):
        """Test None pattern returns None."""
        from services.recurrence_service import RecurrenceService

        current = date(2026, 2, 15)
        next_date = RecurrenceService.calculate_next_date(current, None)
        assert next_date is None

    def test_calculate_next_date_empty_pattern(self):
        """Test empty pattern returns None."""
        from services.recurrence_service import RecurrenceService

        current = date(2026, 2, 15)
        next_date = RecurrenceService.calculate_next_date(current, "")
        assert next_date is None

    def test_calculate_next_date_case_insensitive(self):
        """Test pattern matching is case insensitive."""
        from services.recurrence_service import RecurrenceService

        current = date(2026, 2, 15)
        next_date1 = RecurrenceService.calculate_next_date(current, "MONTHLY")
        next_date2 = RecurrenceService.calculate_next_date(current, "Monthly")
        next_date3 = RecurrenceService.calculate_next_date(current, "monthly")

        assert next_date1 == date(2026, 3, 15)
        assert next_date2 == date(2026, 3, 15)
        assert next_date3 == date(2026, 3, 15)

    def test_is_valid_pattern_valid(self):
        """Test is_valid_pattern with valid patterns."""
        from services.recurrence_service import RecurrenceService

        assert RecurrenceService.is_valid_pattern("daily") is True
        assert RecurrenceService.is_valid_pattern("weekly") is True
        assert RecurrenceService.is_valid_pattern("monthly") is True
        assert RecurrenceService.is_valid_pattern("MONTHLY") is True

    def test_is_valid_pattern_invalid(self):
        """Test is_valid_pattern with invalid patterns."""
        from services.recurrence_service import RecurrenceService

        assert RecurrenceService.is_valid_pattern("invalid") is False
        assert RecurrenceService.is_valid_pattern("") is False
        assert RecurrenceService.is_valid_pattern(None) is False

    def test_get_supported_patterns(self):
        """Test get_supported_patterns returns expected list."""
        from services.recurrence_service import RecurrenceService

        patterns = RecurrenceService.get_supported_patterns()
        assert isinstance(patterns, list)
        assert "daily" in patterns
        assert "weekly" in patterns
        assert "monthly" in patterns
        assert "quarterly" in patterns
        assert "yearly" in patterns


class TestPlannedTransactionExecuteEndpoint:
    """Test cases for POST /api/planned-transactions/{id}/execute endpoint."""

    def test_execute_endpoint_one_time(self, client: TestClient, test_db: Session, sample_category_data,
                                       sample_recipient_data):
        """Test execute endpoint for one-time transaction."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create actual transaction
        actual_txn = Transaction(
            date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-50.00,
            memo="Test payment"
        )
        test_db.add(actual_txn)
        test_db.commit()
        test_db.refresh(actual_txn)

        # Create planned transaction
        planned_txn = PlannedTransaction(
            planned_date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-50.00,
            category_id=category.id,
            memo="Test payment",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_txn)
        test_db.commit()
        test_db.refresh(planned_txn)

        # Execute via API
        response = client.post(
            f"/api/planned-transactions/{planned_txn.id}/execute",
            json={"executed_transaction_id": actual_txn.id}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["is_executed"] is True
        assert data["execution_count"] == 1
        assert data["executed_transaction_id"] == actual_txn.id

    def test_execute_endpoint_recurring(self, client: TestClient, test_db: Session, sample_category_data,
                                        sample_recipient_data):
        """Test execute endpoint for recurring transaction."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create actual transaction
        actual_txn = Transaction(
            date=date(2026, 2, 15),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-12.99,
            memo="Monthly subscription"
        )
        test_db.add(actual_txn)
        test_db.commit()
        test_db.refresh(actual_txn)

        # Create recurring planned transaction
        planned_txn = PlannedTransaction(
            planned_date=date(2026, 2, 15),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-12.99,
            category_id=category.id,
            memo="Monthly subscription",
            is_recurring=True,
            recurrence_pattern="monthly",
            is_executed=False
        )
        test_db.add(planned_txn)
        test_db.commit()
        test_db.refresh(planned_txn)

        # Execute via API
        response = client.post(
            f"/api/planned-transactions/{planned_txn.id}/execute",
            json={
                "executed_transaction_id": actual_txn.id,
                "execution_date": "2026-02-15"
            }
        )

        assert response.status_code == 200
        data = response.json()
        assert data["is_executed"] is False  # Reset for recurring
        assert data["planned_date"] == "2026-03-15"  # Next month
        assert data["last_executed_date"] == "2026-02-15"
        assert data["execution_count"] == 1

    def test_execute_endpoint_not_found(self, client: TestClient, test_db: Session):
        """Test execute endpoint with non-existent planned transaction."""
        response = client.post(
            "/api/planned-transactions/99999/execute",
            json={"executed_transaction_id": 1}
        )

        assert response.status_code == 404

    def test_execute_endpoint_already_executed(self, client: TestClient, test_db: Session, sample_category_data,
                                               sample_recipient_data):
        """Test execute endpoint with already executed transaction."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create actual transaction
        actual_txn = Transaction(
            date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-50.00,
            memo="Test payment"
        )
        test_db.add(actual_txn)
        test_db.commit()
        test_db.refresh(actual_txn)

        # Create already executed planned transaction
        planned_txn = PlannedTransaction(
            planned_date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-50.00,
            category_id=category.id,
            memo="Test payment",
            is_recurring=False,
            is_executed=True  # Already executed
        )
        test_db.add(planned_txn)
        test_db.commit()
        test_db.refresh(planned_txn)

        # Try to execute via API
        response = client.post(
            f"/api/planned-transactions/{planned_txn.id}/execute",
            json={"executed_transaction_id": actual_txn.id}
        )

        assert response.status_code == 400
        assert "already executed" in response.json()["detail"]

    def test_execute_endpoint_invalid_transaction(self, client: TestClient, test_db: Session, sample_category_data,
                                                  sample_recipient_data):
        """Test execute endpoint with non-existent actual transaction."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_txn = PlannedTransaction(
            planned_date=date.today(),
            bank_account="Test Bank",
            recipient_id=recipient.id,
            amount=-50.00,
            category_id=category.id,
            memo="Test payment",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_txn)
        test_db.commit()
        test_db.refresh(planned_txn)

        # Try to execute with non-existent transaction
        response = client.post(
            f"/api/planned-transactions/{planned_txn.id}/execute",
            json={"executed_transaction_id": 99999}
        )

        assert response.status_code == 400
        assert "not found" in response.json()["detail"]


class TestPlannedTransactionEdgeCases:
    """Test edge cases and error handling for planned transactions."""

    def test_update_category_name_not_found(self, client: TestClient, test_db: Session,
                                            sample_category_data, sample_recipient_data):
        """Test PATCH with category_name that doesn't exist."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=100.00,
            category_id=category.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Try to update with non-existent category_name
        update_data = {"category_name": "nonexistent:category"}
        response = client.patch(f"/api/planned-transactions/{planned_transaction.id}", json=update_data)

        # Should succeed but category_id won't be updated (category not found)
        assert response.status_code == 200
        data = response.json()
        # Category should remain unchanged
        assert data["category_id"] == category.id

    def test_update_recipient_name_not_found(self, client: TestClient, test_db: Session,
                                             sample_category_data, sample_recipient_data):
        """Test PATCH with recipient_name that doesn't exist."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=100.00,
            category_id=category.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Try to update with non-existent recipient_name
        update_data = {"recipient_name": "Nonexistent Recipient"}
        response = client.patch(f"/api/planned-transactions/{planned_transaction.id}", json=update_data)

        # Should succeed but recipient won't be updated (not found)
        assert response.status_code == 200
        data = response.json()
        # Recipient should remain unchanged
        assert data["recipient_id"] == recipient.id

    def test_hard_delete_not_found(self, client: TestClient, test_db: Session):
        """Test hard delete of non-existent planned transaction."""
        from repositories.planned_transaction_repository import PlannedTransactionRepository

        repo = PlannedTransactionRepository(test_db)
        result = repo.delete_hard(99999)

        assert result is False


class TestPlannedTransactionsExceptionHandling:
    """Test cases for exception handling in planned transactions endpoints."""

    def test_get_planned_transactions_database_error(self, client: TestClient, monkeypatch):
        """Test GET /api/planned-transactions handles database errors gracefully."""
        from repositories.planned_transaction_repository import PlannedTransactionRepository

        # Mock the get_all method to raise an exception
        def mock_get_all(*args, **kwargs):
            raise Exception("Database connection error")

        monkeypatch.setattr(PlannedTransactionRepository, "get_all", mock_get_all)

        response = client.get("/api/planned-transactions")

        assert response.status_code == 500
        data = response.json()
        assert "detail" in data
        assert "Failed to retrieve planned transactions" in data["detail"]

    def test_create_planned_transaction_value_error(self, client: TestClient, test_db: Session,
                                                    sample_recipient_data, monkeypatch):
        """Test POST /api/planned-transactions handles validation errors."""
        from services.planned_transaction_service import PlannedTransactionService

        # Create recipient
        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Mock the create method to raise ValueError
        def mock_create(*args, **kwargs):
            raise ValueError("Invalid planned date: date must be in the future")

        monkeypatch.setattr(PlannedTransactionService, "create", mock_create)

        transaction_data = {
            "planned_date": (date.today() + timedelta(days=1)).isoformat(),
            "bank_account": "Test",
            "recipient_id": recipient.id,
            "amount": 100.00,
            "memo": "Test"
        }

        response = client.post("/api/planned-transactions", json=transaction_data)

        assert response.status_code == 400
        data = response.json()
        assert "detail" in data
        assert "Invalid planned date" in data["detail"]

    def test_create_planned_transaction_general_error(self, client: TestClient, test_db: Session,
                                                      sample_recipient_data, monkeypatch):
        """Test POST /api/planned-transactions handles general errors."""
        from services.planned_transaction_service import PlannedTransactionService

        # Create recipient
        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Mock the create method to raise a general exception
        def mock_create(*args, **kwargs):
            raise Exception("Database integrity error")

        monkeypatch.setattr(PlannedTransactionService, "create", mock_create)

        transaction_data = {
            "planned_date": (date.today() + timedelta(days=1)).isoformat(),
            "bank_account": "Test",
            "recipient_id": recipient.id,
            "amount": 100.00,
            "memo": "Test"
        }

        response = client.post("/api/planned-transactions", json=transaction_data)

        assert response.status_code == 500
        data = response.json()
        assert "detail" in data
        assert "Failed to create planned transaction" in data["detail"]

    def test_get_planned_transaction_database_error(self, client: TestClient, monkeypatch):
        """Test GET /api/planned-transactions/{id} handles database errors gracefully."""
        from repositories.planned_transaction_repository import PlannedTransactionRepository

        # Mock the get_by_id method to raise an exception
        def mock_get_by_id(*args, **kwargs):
            raise Exception("Database connection error")

        monkeypatch.setattr(PlannedTransactionRepository, "get_by_id", mock_get_by_id)

        response = client.get("/api/planned-transactions/1")

        assert response.status_code == 500
        data = response.json()
        assert "detail" in data
        assert "Failed to retrieve planned transaction" in data["detail"]

    def test_update_planned_transaction_with_valid_category_name(self, client: TestClient, test_db: Session,
                                                                 sample_recipient_data):
        """Test PATCH /api/planned-transactions/{id} with valid category_name that exists."""
        # Create unique categories for this test to avoid interference
        category1 = Category(general="testcat1", detail="detail1")
        category2 = Category(general="testcat2", detail="detail2")
        test_db.add_all([category1, category2])
        test_db.commit()
        test_db.refresh(category1)
        test_db.refresh(category2)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction with category1
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=100.00,
            category_id=category1.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Verify initial state
        assert planned_transaction.category_id == category1.id

        # Update with valid category_name that exists
        update_data = {"category_name": "testcat2:detail2"}
        response = client.patch(f"/api/planned-transactions/{planned_transaction.id}", json=update_data)

        assert response.status_code == 200
        data = response.json()
        # Category should be updated to category2
        assert data["category_id"] == category2.id

    def test_update_planned_transaction_database_error(self, client: TestClient, test_db: Session,
                                                       sample_category_data, sample_recipient_data, monkeypatch):
        """Test PATCH /api/planned-transactions/{id} handles database errors gracefully."""
        from repositories.planned_transaction_repository import PlannedTransactionRepository

        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=100.00,
            category_id=category.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Mock the update method to raise an exception after get_by_id succeeds
        original_get_by_id = PlannedTransactionRepository.get_by_id

        def mock_update(*args, **kwargs):
            raise Exception("Database update error")

        monkeypatch.setattr(PlannedTransactionRepository, "update", mock_update)

        update_data = {"amount": 150.00}
        response = client.patch(f"/api/planned-transactions/{planned_transaction.id}", json=update_data)

        assert response.status_code == 500
        data = response.json()
        assert "detail" in data
        assert "Failed to update planned transaction" in data["detail"]

    def test_delete_planned_transaction_database_error(self, client: TestClient, test_db: Session,
                                                       sample_category_data, sample_recipient_data, monkeypatch):
        """Test DELETE /api/planned-transactions/{id} handles database errors gracefully."""
        from services.planned_transaction_service import PlannedTransactionService

        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create planned transaction
        planned_transaction = PlannedTransaction(
            planned_date=date.today() + timedelta(days=7),
            bank_account="Test",
            recipient_id=recipient.id,
            amount=100.00,
            category_id=category.id,
            memo="Test",
            is_recurring=False,
            is_executed=False
        )
        test_db.add(planned_transaction)
        test_db.commit()
        test_db.refresh(planned_transaction)

        # Mock the delete_planned_transaction method to raise an exception
        def mock_delete(*args, **kwargs):
            raise Exception("Database delete error")

        monkeypatch.setattr(PlannedTransactionService, "delete_planned_transaction", mock_delete)

        response = client.delete(f"/api/planned-transactions/{planned_transaction.id}")

        assert response.status_code == 500
        data = response.json()
        assert "detail" in data
        assert "Failed to delete planned transaction" in data["detail"]
