"""
Unit tests for transactions API endpoints.

Tests Level 3 REST API compliance, HATEOAS links, CRUD operations,
and proper error handling for financial transactions.
"""
from datetime import date, timedelta

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from database.models import Transaction, Category, Recipient


class TestTransactionsListEndpoint:
    """Test cases for transactions collection endpoints."""

    def test_get_transactions_empty_list(self, client: TestClient):
        """Test GET /api/transactions with empty database."""
        response = client.get("/api/transactions")

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
        assert data["limit"] == 50  # default limit
        assert data["offset"] == 0

        # Verify HATEOAS links
        links = data["links"]
        assert len(links) > 0
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "create" in link_rels

    def test_get_transactions_with_data(self, client: TestClient, test_db: Session,
                                        sample_category_data, sample_recipient_data):
        """Test GET /api/transactions with existing transactions."""
        # Create category and recipient first
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
            account_number=sample_recipient_data["account_number"]
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create test transactions
        transactions_data = [
            {
                "date": date.today(),
                "bank_account": "Revolut",
                "recipient_id": recipient.id,
                "amount": 25.50,
                "category_id": category.id,
                "memo": "Grocery shopping"
            },
            {
                "date": date.today() - timedelta(days=1),
                "bank_account": "KBC",
                "recipient_id": recipient.id,
                "amount": 100.00,
                "category_id": category.id,
                "memo": "Fuel"
            }
        ]

        for txn_data in transactions_data:
            txn = Transaction(**txn_data)
            test_db.add(txn)
        test_db.commit()

        response = client.get("/api/transactions")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert "items" in data
        assert "total" in data
        assert len(data["items"]) == len(transactions_data)
        assert data["total"] == len(transactions_data)

        # Verify each transaction has proper structure
        for item in data["items"]:
            assert "id" in item
            assert "date" in item
            assert "bank_account" in item
            assert "amount" in item
            assert "category_id" in item
            assert "recipient_id" in item
            assert "created_at" in item
            assert "links" in item

            # Verify HATEOAS links for each item
            item_links = item["links"]
            assert len(item_links) > 0
            item_link_rels = [link["rel"] for link in item_links]
            assert "self" in item_link_rels
            assert "update" in item_link_rels
            assert "delete" in item_link_rels

    def test_get_transactions_with_pagination(self, client: TestClient, test_db: Session,
                                              sample_category_data, sample_recipient_data):
        """Test GET /api/transactions with pagination parameters."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
            account_number=sample_recipient_data["account_number"]
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create multiple test transactions
        for i in range(5):
            txn = Transaction(
                date=date.today() - timedelta(days=i),
                bank_account="Revolut",
                recipient_id=recipient.id,
                amount=float(10 + i),
                category_id=category.id
            )
            test_db.add(txn)
        test_db.commit()

        # Test with limit and offset
        response = client.get("/api/transactions?limit=2&offset=1")

        assert response.status_code == 200
        data = response.json()

        assert data["limit"] == 2
        assert data["offset"] == 1
        assert len(data["items"]) == 2
        assert data["total"] == 5

        # Verify pagination links
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "next" in link_rels or "prev" in link_rels  # Should have navigation links

    def test_get_transactions_with_date_filters(self, client: TestClient, test_db: Session,
                                                sample_category_data, sample_recipient_data):
        """Test GET /api/transactions with date range filters."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
            account_number=sample_recipient_data["account_number"]
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create transactions with different dates
        today = date.today()
        dates = [today, today - timedelta(days=5), today - timedelta(days=10)]

        for txn_date in dates:
            txn = Transaction(
                date=txn_date,
                bank_account="Revolut",
                recipient_id=recipient.id,
                amount=25.50,
                category_id=category.id
            )
            test_db.add(txn)
        test_db.commit()

        # Test date range filter
        start_date = (today - timedelta(days=7)).isoformat()
        end_date = today.isoformat()
        response = client.get(f"/api/transactions?start_date={start_date}&end_date={end_date}")

        assert response.status_code == 200
        data = response.json()

        # Should only return transactions within date range
        assert len(data["items"]) == 2  # today and 5 days ago

    def test_get_transactions_with_bank_account_filter(self, client: TestClient, test_db: Session,
                                                       sample_category_data, sample_recipient_data):
        """Test GET /api/transactions with bank account filter."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
            account_number=sample_recipient_data["account_number"]
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create transactions with different bank accounts
        banks = ["Revolut", "KBC", "ING"]
        for bank in banks:
            txn = Transaction(
                date=date.today(),
                bank_account=bank,
                recipient_id=recipient.id,
                amount=25.50,
                category_id=category.id
            )
            test_db.add(txn)
        test_db.commit()

        # Test bank account filter (case-insensitive)
        response = client.get("/api/transactions?bank_account=revolut")

        assert response.status_code == 200
        data = response.json()

        # Should only return Revolut transactions
        assert len(data["items"]) == 1
        assert "REVOLUT" in data["items"][0]["bank_account"].upper()

    def test_get_transactions_with_category_filter(self, client: TestClient, test_db: Session,
                                                   sample_category_data, sample_recipient_data):
        """Test GET /api/transactions with category filter."""
        # Create two categories
        category1 = Category(**sample_category_data)
        test_db.add(category1)

        category2 = Category(general="TRANSPORT", detail="FUEL")
        test_db.add(category2)
        test_db.commit()
        test_db.refresh(category1)
        test_db.refresh(category2)

        recipient = Recipient(
            name=sample_recipient_data["name"],
            account_number=sample_recipient_data["account_number"]
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create transactions with different categories
        txn1 = Transaction(
            date=date.today(),
            bank_account="Revolut",
            recipient_id=recipient.id,
            amount=25.50,
            category_id=category1.id
        )
        txn2 = Transaction(
            date=date.today(),
            bank_account="Revolut",
            recipient_id=recipient.id,
            amount=50.00,
            category_id=category2.id
        )
        test_db.add_all([txn1, txn2])
        test_db.commit()

        # Test category filter
        response = client.get(f"/api/transactions?category_id={category1.id}")

        assert response.status_code == 200
        data = response.json()

        # Should only return transactions with category1
        assert len(data["items"]) == 1
        assert data["items"][0]["category_id"] == category1.id

    def test_get_transactions_invalid_date_format(self, client: TestClient):
        """Test GET /api/transactions with invalid date format."""
        response = client.get("/api/transactions?start_date=invalid-date")
        assert response.status_code == 400
        assert "Invalid date format" in response.json()["detail"]

    def test_get_transactions_invalid_pagination_parameters(self, client: TestClient):
        """Test GET /api/transactions with invalid pagination parameters."""
        # Test negative limit
        response = client.get("/api/transactions?limit=-1")
        assert response.status_code == 422

        # Test negative offset
        response = client.get("/api/transactions?offset=-1")
        assert response.status_code == 422

        # Test limit exceeding maximum
        response = client.get("/api/transactions?limit=10000")
        assert response.status_code == 422


class TestTransactionItemEndpoint:
    """Test cases for individual transaction endpoints."""

    def test_get_transaction_by_id_success(self, client: TestClient, test_db: Session,
                                           sample_category_data, sample_recipient_data):
        """Test GET /api/transactions/{id} successfully."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
            account_number=sample_recipient_data["account_number"]
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create transaction
        transaction = Transaction(
            date=date.today(),
            bank_account="Revolut",
            recipient_id=recipient.id,
            amount=25.50,
            category_id=category.id,
            memo="Test transaction"
        )
        test_db.add(transaction)
        test_db.commit()
        test_db.refresh(transaction)

        response = client.get(f"/api/transactions/{transaction.id}")

        assert response.status_code == 200
        data = response.json()

        # Verify transaction data
        assert data["id"] == transaction.id
        assert data["amount"] == 25.50
        assert data["bank_account"] == "Revolut"
        assert data["memo"] == "Test transaction"
        assert "links" in data

        # Verify HATEOAS links
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "update" in link_rels
        assert "delete" in link_rels

    def test_get_transaction_by_id_not_found(self, client: TestClient):
        """Test GET /api/transactions/{id} with non-existent ID."""
        response = client.get("/api/transactions/99999")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_get_transaction_by_id_invalid_id(self, client: TestClient):
        """Test GET /api/transactions/{id} with invalid ID."""
        response = client.get("/api/transactions/invalid")
        assert response.status_code == 422

        response = client.get("/api/transactions/0")
        assert response.status_code == 422


# NOTE: Transaction POST endpoint is not implemented yet
# class TestTransactionCreateEndpoint:
#     """Test cases for transaction creation endpoint - SKIPPED: endpoint not implemented."""


class TestTransactionUpdateEndpoint:
    """Test cases for transaction update endpoint."""

    def test_update_transaction_success(self, client: TestClient, test_db: Session,
                                        sample_category_data, sample_recipient_data):
        """Test PATCH /api/transactions/{id} successfully updates a transaction."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
            account_number=sample_recipient_data["account_number"]
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create transaction
        transaction = Transaction(
            date=date.today(),
            bank_account="Revolut",
            recipient_id=recipient.id,
            amount=25.50,
            category_id=category.id,
            memo="Original memo"
        )
        test_db.add(transaction)
        test_db.commit()
        test_db.refresh(transaction)

        # Update transaction
        update_data = {
            "amount": 30.00,
            "memo": "Updated memo"
        }

        response = client.patch(f"/api/transactions/{transaction.id}", json=update_data)

        assert response.status_code == 200
        data = response.json()

        # Verify updated fields
        assert data["id"] == transaction.id
        assert data["amount"] == 30.00
        assert data["memo"] == "Updated memo"
        assert data["bank_account"] == "Revolut"  # Unchanged field

    def test_update_transaction_not_found(self, client: TestClient):
        """Test PATCH /api/transactions/{id} with non-existent ID."""
        update_data = {"amount": 30.00}
        response = client.patch("/api/transactions/99999", json=update_data)

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_update_transaction_partial_update(self, client: TestClient, test_db: Session,
                                               sample_category_data, sample_recipient_data):
        """Test PATCH /api/transactions/{id} with partial data."""
        # Create category and recipient
        category = Category(**sample_category_data)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        recipient = Recipient(
            name=sample_recipient_data["name"],
            account_number=sample_recipient_data["account_number"]
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create transaction
        transaction = Transaction(
            date=date.today(),
            bank_account="Revolut",
            recipient_id=recipient.id,
            amount=25.50,
            category_id=category.id,
            memo="Original memo"
        )
        test_db.add(transaction)
        test_db.commit()
        test_db.refresh(transaction)

        # Update only one field
        update_data = {"memo": "New memo only"}

        response = client.patch(f"/api/transactions/{transaction.id}", json=update_data)

        assert response.status_code == 200
        data = response.json()

        # Verify only specified field changed
        assert data["memo"] == "New memo only"
        assert data["amount"] == 25.50  # Unchanged


# NOTE: Transaction DELETE endpoint is not implemented yet
# class TestTransactionDeleteEndpoint:
#     """Test cases for transaction deletion endpoint - SKIPPED: endpoint not implemented."""


class TestTransactionOptionsEndpoint:
    """Test cases for transaction OPTIONS endpoints."""

    def test_transactions_collection_options(self, client: TestClient):
        """Test OPTIONS /api/transactions."""
        response = client.options("/api/transactions")

        assert response.status_code == 200
        data = response.json()

        # Verify OPTIONS response structure
        assert "methods" in data
        assert "links" in data

        # Verify available methods (POST not implemented yet)
        methods = [method["method"] for method in data["methods"]]
        assert "GET" in methods
        assert "OPTIONS" in methods
        # POST is not implemented yet
        assert "POST" not in methods

    # NOTE: Individual transaction OPTIONS endpoint is not implemented yet
    # def test_transaction_item_options(self, client: TestClient, test_db: Session,
    #                                   sample_category_data, sample_recipient_data):
    #     """Test OPTIONS /api/transactions/{id} - SKIPPED: endpoint not implemented."""


class TestTransactionsExceptionHandling:
    """Test exception handling in transaction endpoints."""

    def test_get_transactions_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test get_transactions handles exceptions."""
        from services.transaction_query_service import TransactionQueryService

        def mock_get_transactions(*args, **kwargs):
            raise Exception("Database error")

        monkeypatch.setattr(TransactionQueryService, "get_transactions", mock_get_transactions)

        response = client.get("/api/transactions")
        assert response.status_code == 500
        assert "Error retrieving transactions" in response.json()["detail"]

    def test_get_transaction_by_id_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test get_transaction_by_id handles exceptions."""
        from services.transaction_query_service import TransactionQueryService

        def mock_get_by_id(*args, **kwargs):
            raise Exception("Database error")

        monkeypatch.setattr(TransactionQueryService, "get_transaction_by_id", mock_get_by_id)

        response = client.get("/api/transactions/1")
        assert response.status_code == 500
        assert "Error retrieving transaction" in response.json()["detail"]

    def test_update_transaction_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test update_transaction handles exceptions."""
        from repositories.transaction_repository import TransactionRepository

        def mock_get_by_id(*args, **kwargs):
            raise Exception("Update failed")

        monkeypatch.setattr(TransactionRepository, "get_by_id", mock_get_by_id)

        response = client.patch("/api/transactions/1", json={"description": "Updated"})
        assert response.status_code == 500
        assert "Error updating transaction" in response.json()["detail"]

    def test_update_transaction_date_field(self, client: TestClient, test_db: Session,
                                           sample_category_data, sample_recipient_data):
        """Test updating transaction date field."""
        # Create category and recipient
        category = Category(**sample_category_data)
        recipient = Recipient(**sample_recipient_data)
        test_db.add_all([category, recipient])
        test_db.commit()
        test_db.refresh(category)
        test_db.refresh(recipient)

        # Create transaction
        transaction = Transaction(
            date=date.today(),
            memo="Test Transaction",
            amount=100.0,
            bank_account="TEST123",
            category_id=category.id,
            recipient_id=recipient.id
        )
        test_db.add(transaction)
        test_db.commit()
        test_db.refresh(transaction)

        # Update using transaction_date field (API accepts both date and transaction_date via alias)
        new_date = "2024-01-15"
        response = client.patch(f"/api/transactions/{transaction.id}", json={"transaction_date": new_date})
        assert response.status_code == 200
        data = response.json()
        # Response uses 'date' as the field name
        assert data["date"] == new_date


class TestTransactionsQueryParameters:
    """Test query parameters in transaction list endpoint."""

    def test_get_transactions_with_recipient_id_filter(self, client: TestClient, test_db: Session,
                                                       sample_category_data, sample_recipient_data):
        """Test filtering transactions by recipient_id."""
        # Create category and recipient
        category = Category(**sample_category_data)
        recipient = Recipient(**sample_recipient_data)
        test_db.add_all([category, recipient])
        test_db.commit()
        test_db.refresh(category)
        test_db.refresh(recipient)

        # Create transaction
        transaction = Transaction(
            date=date.today(),
            memo="Test Transaction",
            amount=100.0,
            bank_account="TEST123",
            category_id=category.id,
            recipient_id=recipient.id
        )
        test_db.add(transaction)
        test_db.commit()

        response = client.get(f"/api/transactions?recipient_id={recipient.id}")
        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 1

    def test_get_transactions_with_recipient_name_filter(self, client: TestClient, test_db: Session,
                                                         sample_category_data, sample_recipient_data):
        """Test filtering transactions by recipient_name."""
        # Create category and recipient
        category = Category(**sample_category_data)
        recipient = Recipient(**sample_recipient_data)
        test_db.add_all([category, recipient])
        test_db.commit()
        test_db.refresh(category)
        test_db.refresh(recipient)

        # Create transaction
        transaction = Transaction(
            date=date.today(),
            memo="Test Transaction",
            amount=100.0,
            bank_account="TEST123",
            category_id=category.id,
            recipient_id=recipient.id
        )
        test_db.add(transaction)
        test_db.commit()

        response = client.get(f"/api/transactions?recipient_name={recipient.name}")
        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 1

    def test_get_transactions_with_uncategorised_filter(self, client: TestClient, test_db: Session,
                                                        sample_recipient_data):
        """Test filtering uncategorised transactions.

        Uncategorised transactions are those where:
        - The recipient has no default_category_id
        - AND the transaction itself has no category_id assigned
        """
        # Create recipient WITHOUT default category
        recipient = Recipient(
            name=sample_recipient_data["name"],
            account_number=sample_recipient_data["account_number"],
            default_category_id=None  # No default category
        )
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Create transaction without a category (truly uncategorised)
        transaction = Transaction(
            date=date.today(),
            memo="Test Transaction",
            amount=100.0,
            bank_account="TEST123",
            category_id=None,  # Transaction has NO category
            recipient_id=recipient.id
        )
        test_db.add(transaction)
        test_db.commit()

        response = client.get("/api/transactions?uncategorised=true")
        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 1

    def test_get_transactions_with_active_filter(self, client: TestClient, test_db: Session,
                                                 sample_category_data, sample_recipient_data):
        """Test filtering transactions by active status."""
        category = Category(**sample_category_data)
        recipient = Recipient(**sample_recipient_data)
        test_db.add_all([category, recipient])
        test_db.commit()
        test_db.refresh(category)
        test_db.refresh(recipient)

        # Create transactions
        txn1 = Transaction(
            date=date.today(),
            memo="Transaction 1",
            amount=100.0,
            bank_account="TEST123",
            category_id=category.id,
            recipient_id=recipient.id
        )
        txn2 = Transaction(
            date=date.today(),
            memo="Transaction 2",
            amount=50.0,
            bank_account="TEST123",
            category_id=category.id,
            recipient_id=recipient.id
        )
        test_db.add_all([txn1, txn2])
        test_db.commit()

        # Test with active=true (default behavior)
        response = client.get("/api/transactions?active=true")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] >= 2  # Should include transactions

        # Test with active=false to ensure query parameter handling works
        response = client.get("/api/transactions?active=false")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] >= 2
        assert "links" in data  # Verify links are present
