"""
Unit tests for recipients API endpoints.

Tests Level 3 REST API compliance, HATEOAS links, CRUD operations,
recipient-category linking functionality, and proper error handling.
"""
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from database.models import Recipient, Category


class TestRecipientsListEndpoint:
    """Test cases for recipients collection endpoints."""

    def test_get_recipients_empty_list(self, client: TestClient):
        """Test GET /api/recipients with empty database."""
        response = client.get("/api/recipients")

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

    def test_get_recipients_with_data(self, client: TestClient, test_db: Session, multiple_recipients_data):
        """Test GET /api/recipients with existing recipients."""
        # Create test recipients
        for recipient_data in multiple_recipients_data:
            recipient = Recipient(**recipient_data)
            test_db.add(recipient)
        test_db.commit()

        response = client.get("/api/recipients")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert "items" in data
        assert "total" in data
        assert len(data["items"]) == len(multiple_recipients_data)
        assert data["total"] == len(multiple_recipients_data)

        # Verify each recipient has proper structure
        for item in data["items"]:
            assert "id" in item
            assert "name" in item
            assert "account_number" in item
            assert "is_active" in item
            assert "created_at" in item
            assert "updated_at" in item
            assert "links" in item

            # Verify recipients are normalized to uppercase
            assert item["name"].isupper()

            # Verify HATEOAS links for each item
            item_links = item["links"]
            assert len(item_links) > 0
            item_link_rels = [link["rel"] for link in item_links]
            assert "self" in item_link_rels
            assert "update" in item_link_rels
            assert "delete" in item_link_rels

    def test_get_recipients_with_pagination(self, client: TestClient, test_db: Session, multiple_recipients_data):
        """Test GET /api/recipients with pagination parameters."""
        # Create test recipients
        for recipient_data in multiple_recipients_data:
            recipient = Recipient(**recipient_data)
            test_db.add(recipient)
        test_db.commit()

        # Test with limit and offset
        response = client.get("/api/recipients?limit=2&offset=1")

        assert response.status_code == 200
        data = response.json()

        assert data["limit"] == 2
        assert data["offset"] == 1
        assert len(data["items"]) <= 2

        # Verify pagination links
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels

        # Should have next link if more items exist
        if data["offset"] + data["limit"] < data["total"]:
            assert "next" in link_rels

    def test_get_recipients_filter_by_name(self, client: TestClient, test_db: Session, multiple_recipients_data):
        """Test GET /api/recipients with name filter."""
        # Create test recipients
        for recipient_data in multiple_recipients_data:
            recipient = Recipient(**recipient_data)
            test_db.add(recipient)
        test_db.commit()

        # Filter by name (case-insensitive)
        response = client.get("/api/recipients?name=john")

        assert response.status_code == 200
        data = response.json()

        # Verify all returned recipients contain "JOHN" in name
        for item in data["items"]:
            assert "JOHN" in item["name"].upper()

    def test_get_recipients_filter_by_account_number(self, client: TestClient, test_db: Session,
                                                     multiple_recipients_data):
        """Test GET /api/recipients with account number filter."""
        # Create test recipients
        for recipient_data in multiple_recipients_data:
            recipient = Recipient(**recipient_data)
            test_db.add(recipient)
        test_db.commit()

        # Filter by account number
        response = client.get("/api/recipients?account_number=123")

        assert response.status_code == 200
        data = response.json()

        # Verify all returned recipients contain "123" in account number
        for item in data["items"]:
            if item["account_number"]:
                assert "123" in item["account_number"]

    def test_get_recipients_filter_inactive(self, client: TestClient, test_db: Session):
        """Test GET /api/recipients with active=false to include inactive recipients."""
        # Create active and inactive recipients
        active_recipient = Recipient(name="ACTIVE RECIPIENT", is_active=True)
        inactive_recipient = Recipient(name="INACTIVE RECIPIENT", is_active=False)
        test_db.add_all([active_recipient, inactive_recipient])
        test_db.commit()

        # Get all recipients including inactive
        response = client.get("/api/recipients?active=false")

        assert response.status_code == 200
        data = response.json()

        assert data["total"] == 2
        assert len(data["items"]) == 2

        # Get only active recipients
        response = client.get("/api/recipients?active=true")

        assert response.status_code == 200
        data = response.json()

        assert data["total"] == 1
        assert data["items"][0]["name"] == "ACTIVE RECIPIENT"


class TestRecipientsCreateEndpoint:
    """Test cases for recipient creation endpoint."""

    def test_create_recipient_success(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test POST /api/recipients with valid data."""
        response = client.post("/api/recipients", json=sample_recipient_data)

        assert response.status_code == 201
        data = response.json()

        # Verify response structure
        assert "id" in data
        assert "name" in data
        assert "account_number" in data
        assert "is_active" in data
        assert "created_at" in data
        assert "updated_at" in data
        assert "links" in data

        # Verify data matches input (name should be uppercase)
        assert data["name"] == sample_recipient_data["name"].upper()
        assert data["account_number"] == sample_recipient_data.get("account_number")
        assert data["is_active"] is True

        # Verify HATEOAS links
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "update" in link_rels
        assert "delete" in link_rels
        assert "list" in link_rels

    def test_create_recipient_minimal_data(self, client: TestClient, test_db: Session):
        """Test POST /api/recipients with only required fields."""
        minimal_data = {"name": "minimal recipient"}

        response = client.post("/api/recipients", json=minimal_data)

        assert response.status_code == 201
        data = response.json()

        assert data["name"] == "MINIMAL RECIPIENT"
        assert data["account_number"] is None
        assert data["is_active"] is True

    def test_create_recipient_with_category(self, client: TestClient, test_db: Session):
        """Test POST /api/recipients with default category."""
        # Create a category first
        category = Category(general="GROCERIES", detail="FOOD")
        test_db.add(category)
        test_db.commit()

        recipient_data = {
            "name": "test recipient",
            "default_category_id": category.id
        }

        response = client.post("/api/recipients", json=recipient_data)

        assert response.status_code == 201
        data = response.json()

        assert data["default_category_id"] == category.id

    def test_create_recipient_duplicate_name(self, client: TestClient, test_db: Session):
        """Test POST /api/recipients with duplicate name returns 200."""
        # Create first recipient
        recipient_data = {"name": "duplicate name"}
        response1 = client.post("/api/recipients", json=recipient_data)
        assert response1.status_code == 201

        # Try to create duplicate (should return existing with 200)
        response2 = client.post("/api/recipients", json=recipient_data)
        assert response2.status_code == 200

        # Both should have same ID (idempotent)
        assert response1.json()["id"] == response2.json()["id"]

    def test_create_recipient_invalid_data(self, client: TestClient, test_db: Session):
        """Test POST /api/recipients with invalid data."""
        invalid_data = {}  # Missing required name field

        response = client.post("/api/recipients", json=invalid_data)

        assert response.status_code == 422  # Validation error

    def test_create_recipient_empty_name(self, client: TestClient, test_db: Session):
        """Test POST /api/recipients with empty name."""
        invalid_data = {"name": ""}

        response = client.post("/api/recipients", json=invalid_data)

        # Should fail validation
        assert response.status_code in [400, 422]


class TestRecipientsItemEndpoint:
    """Test cases for individual recipient endpoints."""

    def test_get_recipient_by_id_success(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test GET /api/recipients/{id} with valid ID."""
        # Create a recipient
        recipient = Recipient(**sample_recipient_data)
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        response = client.get(f"/api/recipients/{recipient.id}")

        assert response.status_code == 200
        data = response.json()

        assert data["id"] == recipient.id
        assert data["name"] == recipient.name
        assert "links" in data

    def test_get_recipient_by_id_not_found(self, client: TestClient, test_db: Session):
        """Test GET /api/recipients/{id} with non-existent ID."""
        response = client.get("/api/recipients/99999")

        assert response.status_code == 404
        data = response.json()
        assert "detail" in data

    def test_update_recipient_success(self, client: TestClient, test_db: Session, sample_recipient_data,
                                      sample_recipient_update_data):
        """Test PATCH /api/recipients/{id} with valid data."""
        # Create a recipient
        recipient = Recipient(**sample_recipient_data)
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        response = client.patch(f"/api/recipients/{recipient.id}", json=sample_recipient_update_data)

        assert response.status_code == 200
        data = response.json()

        # Verify updated data (name should be uppercase)
        assert data["name"] == sample_recipient_update_data["name"].upper()
        if "notes" in sample_recipient_update_data:
            assert data["notes"] == sample_recipient_update_data["notes"]

    def test_update_recipient_partial(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test PATCH /api/recipients/{id} with partial update."""
        # Create a recipient
        recipient = Recipient(**sample_recipient_data)
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Update only notes
        partial_update = {"notes": "Updated notes only"}

        response = client.patch(f"/api/recipients/{recipient.id}", json=partial_update)

        assert response.status_code == 200
        data = response.json()

        # Name should remain unchanged
        assert data["name"] == recipient.name
        assert data["notes"] == "Updated notes only"

    def test_update_recipient_not_found(self, client: TestClient, test_db: Session, sample_recipient_update_data):
        """Test PATCH /api/recipients/{id} with non-existent ID."""
        response = client.patch("/api/recipients/99999", json=sample_recipient_update_data)

        assert response.status_code == 404
        data = response.json()
        assert "detail" in data

    def test_update_recipient_deactivate(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test PATCH /api/recipients/{id} to deactivate recipient."""
        # Create a recipient
        recipient = Recipient(**sample_recipient_data)
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        # Deactivate
        update_data = {"is_active": False}

        response = client.patch(f"/api/recipients/{recipient.id}", json=update_data)

        assert response.status_code == 200
        data = response.json()

        assert data["is_active"] is False

    def test_delete_recipient_success(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test DELETE /api/recipients/{id} (soft delete)."""
        # Create a recipient
        recipient = Recipient(**sample_recipient_data)
        test_db.add(recipient)
        test_db.commit()
        recipient_id = recipient.id

        response = client.delete(f"/api/recipients/{recipient_id}")

        assert response.status_code == 200
        data = response.json()

        assert "message" in data
        assert "links" in data

        # Verify hard delete - recipient should be completely removed
        deleted_recipient = test_db.query(Recipient).filter(Recipient.id == recipient_id).first()
        assert deleted_recipient is None

    def test_delete_recipient_not_found(self, client: TestClient, test_db: Session):
        """Test DELETE /api/recipients/{id} with non-existent ID."""
        response = client.delete("/api/recipients/99999")

        assert response.status_code == 404
        data = response.json()
        assert "detail" in data


class TestRecipientsOptionsEndpoint:
    """Test cases for OPTIONS endpoints."""

    def test_options_collection(self, client: TestClient):
        """Test OPTIONS /api/recipients."""
        response = client.options("/api/recipients")

        assert response.status_code == 200
        data = response.json()

        assert "methods" in data
        assert "links" in data

        # Verify available methods
        methods = [method["method"] for method in data["methods"]]
        assert "GET" in methods
        assert "POST" in methods
        assert "OPTIONS" in methods

    def test_options_item(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test OPTIONS /api/recipients/{id}."""
        # Create a recipient
        recipient = Recipient(**sample_recipient_data)
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        response = client.options(f"/api/recipients/{recipient.id}")

        assert response.status_code == 200
        data = response.json()

        assert "methods" in data
        assert "links" in data

        # Verify available methods
        methods = [method["method"] for method in data["methods"]]
        assert "GET" in methods
        assert "PATCH" in methods
        assert "DELETE" in methods
        assert "OPTIONS" in methods


class TestRecipientsUpdateCategoryEndpoint:
    """Test cases for recipient category assignment endpoint."""


class TestRecipientsHATEOAS:
    """Test cases for HATEOAS compliance."""

    def test_hateoas_links_in_collection(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test HATEOAS links in collection response."""
        # Create a recipient
        recipient = Recipient(**sample_recipient_data)
        test_db.add(recipient)
        test_db.commit()

        response = client.get("/api/recipients")

        assert response.status_code == 200
        data = response.json()

        # Verify collection-level links
        assert "links" in data
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "create" in link_rels

        # Verify each item has links
        for item in data["items"]:
            assert "links" in item
            item_links = item["links"]
            item_link_rels = [link["rel"] for link in item_links]
            assert "self" in item_link_rels
            assert "update" in item_link_rels
            assert "delete" in item_link_rels

    def test_hateoas_links_in_item(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test HATEOAS links in single item response."""
        # Create a recipient
        recipient = Recipient(**sample_recipient_data)
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        response = client.get(f"/api/recipients/{recipient.id}")

        assert response.status_code == 200
        data = response.json()

        # Verify HATEOAS links
        assert "links" in data
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "update" in link_rels
        assert "delete" in link_rels
        assert "list" in link_rels

    def test_hateoas_links_after_creation(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test HATEOAS links in creation response."""
        response = client.post("/api/recipients", json=sample_recipient_data)

        assert response.status_code == 201
        data = response.json()

        # Verify HATEOAS links
        assert "links" in data
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "update" in link_rels
        assert "delete" in link_rels
        assert "list" in link_rels

    def test_hateoas_links_after_deletion(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test HATEOAS links in deletion response."""
        # Create a recipient
        recipient = Recipient(**sample_recipient_data)
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        response = client.delete(f"/api/recipients/{recipient.id}")

        assert response.status_code == 200
        data = response.json()

        # Verify HATEOAS links for navigation after deletion
        assert "links" in data
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "list" in link_rels
        assert "create" in link_rels


class TestRecipientsValidation:
    """Test cases for input validation."""

    def test_create_recipient_name_normalization(self, client: TestClient, test_db: Session):
        """Test that recipient names are normalized to uppercase."""
        recipient_data = {"name": "lowercase name"}

        response = client.post("/api/recipients", json=recipient_data)

        assert response.status_code == 201
        data = response.json()

        # Name should be uppercase
        assert data["name"] == "LOWERCASE NAME"

    def test_update_recipient_name_normalization(self, client: TestClient, test_db: Session, sample_recipient_data):
        """Test that recipient names are normalized to uppercase on update."""
        # Create a recipient
        recipient = Recipient(**sample_recipient_data)
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        update_data = {"name": "updated lowercase name"}

        response = client.patch(f"/api/recipients/{recipient.id}", json=update_data)

        assert response.status_code == 200
        data = response.json()

        # Name should be uppercase
        assert data["name"] == "UPDATED LOWERCASE NAME"

    def test_pagination_limits(self, client: TestClient, test_db: Session):
        """Test pagination limit validation."""
        # Test with limit exceeding maximum
        response = client.get("/api/recipients?limit=10000")

        # Should be rejected or clamped to max
        assert response.status_code in [200, 422]

        if response.status_code == 200:
            data = response.json()
            # Limit should be clamped to max (1000)
            assert data["limit"] <= 1000

    def test_invalid_pagination_parameters(self, client: TestClient, test_db: Session):
        """Test invalid pagination parameters."""
        # Negative offset
        response = client.get("/api/recipients?offset=-1")
        assert response.status_code == 422

        # Zero limit
        response = client.get("/api/recipients?limit=0")
        assert response.status_code == 422


class TestRecipientsErrorHandling:
    """Test cases for error handling."""

    def test_database_error_handling(self, client: TestClient, test_db: Session):
        """Test handling of database errors."""
        with patch('services.recipient_service.RecipientService.get_all') as mock_get_all:
            mock_get_all.side_effect = Exception("Database error")

            response = client.get("/api/recipients")

            assert response.status_code == 500
            data = response.json()
            assert "detail" in data

    def test_invalid_json_payload(self, client: TestClient, test_db: Session):
        """Test handling of invalid JSON payload."""
        response = client.post(
            "/api/recipients",
            data="invalid json",
            headers={"Content-Type": "application/json"}
        )

        assert response.status_code == 422

    def test_missing_required_fields(self, client: TestClient, test_db: Session):
        """Test handling of missing required fields."""
        incomplete_data = {"account_number": "12345"}  # Missing name

        response = client.post("/api/recipients", json=incomplete_data)

        assert response.status_code == 422
        data = response.json()
        assert "detail" in data


class TestRecipientsExceptionHandling:
    """Test exception handling in recipient endpoints."""

    def test_create_recipient_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test create_recipient handles exceptions."""
        from services.recipient_service import RecipientService

        def mock_create_or_get(*args, **kwargs):
            raise Exception("Database error")

        monkeypatch.setattr(RecipientService, "create_or_get_recipient", mock_create_or_get)

        response = client.post("/api/recipients", json={"name": "Test Recipient"})
        assert response.status_code == 500
        assert "Error creating recipient" in response.json()["detail"]

    def test_get_recipient_by_id_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test get_recipient handles exceptions."""
        from services.recipient_service import RecipientService

        def mock_get_by_id(*args, **kwargs):
            raise Exception("Database error")

        monkeypatch.setattr(RecipientService, "get_by_id", mock_get_by_id)

        response = client.get("/api/recipients/1")
        assert response.status_code == 500
        assert "Error retrieving recipient" in response.json()["detail"]

    def test_update_recipient_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test update_recipient handles exceptions."""
        from services.recipient_service import RecipientService

        def mock_update(*args, **kwargs):
            raise Exception("Update failed")

        monkeypatch.setattr(RecipientService, "update", mock_update)

        response = client.patch("/api/recipients/1", json={"name": "Updated"})
        assert response.status_code == 500
        assert "Error updating recipient" in response.json()["detail"]

    def test_delete_recipient_hard_delete_not_found(self, client: TestClient, test_db: Session):
        """Test hard delete returns 404 when recipient not found."""
        response = client.delete("/api/recipients/999?soft=false")
        assert response.status_code == 404
        assert "Recipient not found" in response.json()["detail"]

    def test_create_recipient_value_error(self, client: TestClient, test_db: Session):
        """Test create_recipient handles ValueError from service."""
        with patch('services.recipient_service.RecipientService.create_or_get_recipient') as mock_create:
            mock_create.side_effect = ValueError("Invalid recipient name")

            response = client.post("/api/recipients", json={"name": "Test"})

            assert response.status_code == 400
            assert "Invalid recipient name" in response.json()["detail"]

    def test_delete_recipient_exception(self, client: TestClient, test_db: Session):
        """Test delete_recipient handles general exceptions."""
        # Create a test recipient first
        recipient = Recipient(name="TEST RECIPIENT")
        test_db.add(recipient)
        test_db.commit()
        test_db.refresh(recipient)

        with patch('services.recipient_service.RecipientService.hard_delete') as mock_delete:
            mock_delete.side_effect = Exception("Database error")

            response = client.delete(f"/api/recipients/{recipient.id}")

            assert response.status_code == 500
            assert "Error deleting recipient" in response.json()["detail"]
