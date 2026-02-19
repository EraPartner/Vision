"""
Unit tests for categories API endpoints.

Tests Level 3 REST API compliance, HATEOAS links, CRUD operations,
category assignment functionality, and proper error handling.
"""
from unittest.mock import patch, MagicMock

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from database.models import Category, Recipient


class TestCategoriesListEndpoint:
    """Test cases for categories collection endpoints."""

    def test_get_categories_empty_list(self, client: TestClient):
        """Test GET /api/categories with empty database."""
        response = client.get("/api/categories")

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

    def test_get_categories_with_data(self, client: TestClient, test_db: Session, multiple_categories_data):
        """Test GET /api/categories with existing categories."""
        # Create test categories
        for category_data in multiple_categories_data:
            category = Category(**category_data)
            test_db.add(category)
        test_db.commit()

        response = client.get("/api/categories")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert "items" in data
        assert "total" in data
        assert len(data["items"]) == len(multiple_categories_data)
        assert data["total"] == len(multiple_categories_data)

        # Verify each category has proper structure
        for item in data["items"]:
            assert "id" in item
            assert "general" in item
            assert "detail" in item
            assert "description" in item
            assert "created_at" in item
            assert "updated_at" in item
            assert "links" in item

            # Verify categories are normalized to uppercase
            assert item["general"].isupper()
            assert item["detail"].isupper()

            # Verify HATEOAS links for each item
            item_links = item["links"]
            assert len(item_links) > 0
            item_link_rels = [link["rel"] for link in item_links]
            assert "self" in item_link_rels
            assert "update" in item_link_rels
            assert "delete" in item_link_rels

    def test_get_categories_with_pagination(self, client: TestClient, test_db: Session, multiple_categories_data):
        """Test GET /api/categories with pagination parameters."""
        # Create test categories
        for category_data in multiple_categories_data:
            category = Category(**category_data)
            test_db.add(category)
        test_db.commit()

        # Test with limit and offset
        response = client.get("/api/categories?limit=2&offset=1")

        assert response.status_code == 200
        data = response.json()

        assert data["limit"] == 2
        assert data["offset"] == 1
        assert len(data["items"]) == 2
        assert data["total"] == len(multiple_categories_data)

        # Verify pagination links
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "next" in link_rels or "prev" in link_rels  # Should have navigation links

    def test_get_categories_with_filters(self, client: TestClient, test_db: Session, multiple_categories_data):
        """Test GET /api/categories with filter parameters."""
        # Create test categories
        for category_data in multiple_categories_data:
            category = Category(**category_data)
            test_db.add(category)
        test_db.commit()

        # Test filtering by general category
        response = client.get("/api/categories?general=groceries")

        assert response.status_code == 200
        data = response.json()

        # Should only return groceries categories
        for item in data["items"]:
            assert "GROCERIES" in item["general"]

        # Test filtering by detail category
        response = client.get("/api/categories?detail=food")

        assert response.status_code == 200
        data = response.json()

        # Should only return food-related categories
        for item in data["items"]:
            assert "FOOD" in item["detail"]

    def test_get_categories_invalid_pagination_parameters(self, client: TestClient):
        """Test GET /api/categories with invalid pagination parameters."""
        # Test negative limit
        response = client.get("/api/categories?limit=-1")
        assert response.status_code == 422

        # Test negative offset
        response = client.get("/api/categories?offset=-1")
        assert response.status_code == 422

        # Test limit exceeding maximum
        response = client.get("/api/categories?limit=1001")
        assert response.status_code == 422


class TestCategoriesCreateEndpoint:
    """Test cases for category creation."""

    def test_create_category_success(self, client: TestClient, sample_category_data):
        """Test successful category creation."""
        response = client.post("/api/categories", json=sample_category_data)

        assert response.status_code == 201
        data = response.json()

        # Verify response structure
        assert "id" in data
        assert "general" in data
        assert "detail" in data
        assert "description" in data
        assert "created_at" in data
        assert "links" in data

        # Verify data normalization
        assert data["general"] == sample_category_data["general"].upper()
        assert data["detail"] == sample_category_data["detail"].upper()
        assert data["description"] == sample_category_data["description"]

        # Verify HATEOAS links
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "update" in link_rels
        assert "delete" in link_rels
        assert "list" in link_rels

    def test_create_category_duplicate_handling(self, client: TestClient, sample_category_data):
        """Test creating duplicate category returns existing one with 200 status."""
        # Create first category
        response1 = client.post("/api/categories", json=sample_category_data)
        assert response1.status_code == 201
        first_id = response1.json()["id"]

        # Create same category again - should return 200 (existing resource)
        response2 = client.post("/api/categories", json=sample_category_data)
        assert response2.status_code == 200
        second_id = response2.json()["id"]

        # Should return the same category (idempotent operation)
        assert first_id == second_id

    def test_create_category_case_insensitive_duplicate(self, client: TestClient):
        """Test that case variations are treated as duplicates and return 200."""
        category1 = {"general": "groceries", "detail": "food", "description": "Test"}
        category2 = {"general": "GROCERIES", "detail": "FOOD", "description": "Test"}

        # Create first category
        response1 = client.post("/api/categories", json=category1)
        assert response1.status_code == 201
        first_id = response1.json()["id"]

        # Create same category with different case
        response2 = client.post("/api/categories", json=category2)
        assert response2.status_code == 200  # Changed from 201 to 200 for existing category
        second_id = response2.json()["id"]

        # Should return the same category
        assert first_id == second_id

    def test_create_category_missing_required_fields(self, client: TestClient):
        """Test category creation with missing required fields."""
        # Missing general field
        response = client.post("/api/categories", json={"detail": "food"})
        assert response.status_code == 422

        # Missing detail field
        response = client.post("/api/categories", json={"general": "groceries"})
        assert response.status_code == 422

        # Empty strings
        response = client.post("/api/categories", json={"general": "", "detail": ""})
        assert response.status_code == 422

    def test_create_category_invalid_data_types(self, client: TestClient):
        """Test category creation with invalid data types."""
        # Non-string values
        invalid_data = {"general": 123, "detail": True, "description": []}
        response = client.post("/api/categories", json=invalid_data)
        assert response.status_code == 422

    def test_create_category_optional_description(self, client: TestClient):
        """Test category creation without optional description."""
        category_data = {"general": "transport", "detail": "fuel"}
        response = client.post("/api/categories", json=category_data)

        assert response.status_code == 201
        data = response.json()

        assert data["general"] == "TRANSPORT"
        assert data["detail"] == "FUEL"
        assert data["description"] is None


class TestCategoryRetrievalEndpoint:
    """Test cases for individual category retrieval."""

    def test_get_category_success(self, client: TestClient, test_db: Session):
        """Test successful category retrieval."""
        # Create test category
        category = Category(general="GROCERIES", detail="FOOD", description="Test category")
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        response = client.get(f"/api/categories/{category.id}")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert data["id"] == category.id
        assert data["general"] == "GROCERIES"
        assert data["detail"] == "FOOD"
        assert data["description"] == "Test category"
        assert "created_at" in data
        assert "links" in data

        # Verify HATEOAS links
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "update" in link_rels
        assert "delete" in link_rels
        assert "list" in link_rels

    def test_get_category_not_found(self, client: TestClient):
        """Test category retrieval with non-existent ID."""
        response = client.get("/api/categories/99999")
        assert response.status_code == 404

    def test_get_category_invalid_id(self, client: TestClient):
        """Test category retrieval with invalid ID."""
        # Non-numeric ID
        response = client.get("/api/categories/invalid")
        assert response.status_code == 422

        # Zero or negative ID
        response = client.get("/api/categories/0")
        assert response.status_code == 422


class TestCategoryUpdateEndpoint:
    """Test cases for category updates."""

    def test_update_category_success(self, client: TestClient, test_db: Session, sample_category_update_data):
        """Test successful category update."""
        # Create test category
        category = Category(general="GROCERIES", detail="FOOD", description="Original description")
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        response = client.patch(f"/api/categories/{category.id}", json=sample_category_update_data)

        assert response.status_code == 200
        data = response.json()

        # Verify updated data
        assert data["general"] == sample_category_update_data["general"].upper()
        assert data["detail"] == sample_category_update_data["detail"].upper()
        assert data["description"] == sample_category_update_data["description"]
        assert "updated_at" in data

        # Verify HATEOAS links
        assert "links" in data

    def test_update_category_partial_update(self, client: TestClient, test_db: Session):
        """Test partial category update."""
        # Create test category
        category = Category(general="GROCERIES", detail="FOOD", description="Original description")
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        # Update only description
        update_data = {"description": "Updated description only"}
        response = client.patch(f"/api/categories/{category.id}", json=update_data)

        assert response.status_code == 200
        data = response.json()

        # Verify only description changed
        assert data["general"] == "GROCERIES"
        assert data["detail"] == "FOOD"
        assert data["description"] == "Updated description only"

    def test_update_category_not_found(self, client: TestClient, sample_category_update_data):
        """Test update of non-existent category."""
        response = client.patch("/api/categories/99999", json=sample_category_update_data)
        assert response.status_code == 404

    def test_update_category_invalid_data(self, client: TestClient, test_db: Session):
        """Test category update with invalid data."""
        # Create test category
        category = Category(general="GROCERIES", detail="FOOD")
        test_db.add(category)
        test_db.commit()

        # Invalid data types
        invalid_data = {"general": 123, "detail": True}
        response = client.patch(f"/api/categories/{category.id}", json=invalid_data)
        assert response.status_code == 422

    def test_update_category_empty_fields(self, client: TestClient, test_db: Session):
        """Test category update with empty fields."""
        # Create test category
        category = Category(general="GROCERIES", detail="FOOD")
        test_db.add(category)
        test_db.commit()

        # Empty strings should be rejected
        empty_data = {"general": "", "detail": ""}
        response = client.patch(f"/api/categories/{category.id}", json=empty_data)
        assert response.status_code == 422


class TestCategoryDeleteEndpoint:
    """Test cases for category deletion."""

    def test_delete_category_hard_delete(self, client: TestClient, test_db: Session):
        """Test hard deletion of category (permanent removal)."""
        # Create test category
        category = Category(general="GROCERIES", detail="FOOD")
        test_db.add(category)
        test_db.commit()
        category_id = category.id

        response = client.delete(f"/api/categories/{category_id}")

        assert response.status_code == 200
        data = response.json()

        # Verify response
        assert "message" in data
        assert "permanently" in data["message"].lower()

        # Verify category is completely removed
        deleted_category = test_db.query(Category).filter(Category.id == category_id).first()
        assert deleted_category is None

    def test_delete_category_not_found(self, client: TestClient):
        """Test deletion of non-existent category."""
        response = client.delete("/api/categories/99999")
        assert response.status_code == 404

    def test_deactivate_category_via_patch(self, client: TestClient, test_db: Session):
        """Test deactivating a category via PATCH (soft delete alternative)."""
        # Create test category
        category = Category(general="GROCERIES", detail="FOOD", is_active=True)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        # Deactivate via PATCH
        response = client.patch(f"/api/categories/{category.id}", json={"is_active": False})

        assert response.status_code == 200
        data = response.json()

        # Verify category is marked as inactive
        assert data["is_active"] is False

        # Verify in database
        test_db.refresh(category)
        assert category.is_active is False

    def test_reactivate_category_via_patch(self, client: TestClient, test_db: Session):
        """Test reactivating an inactive category via PATCH."""
        # Create inactive test category
        category = Category(general="GROCERIES", detail="FOOD", is_active=False)
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        # Reactivate via PATCH
        response = client.patch(f"/api/categories/{category.id}", json={"is_active": True})

        assert response.status_code == 200
        data = response.json()

        # Verify category is marked as active
        assert data["is_active"] is True

        # Verify in database
        test_db.refresh(category)
        assert category.is_active is True


class TestCategoryAssignmentEndpoint:
    """Test cases for category assignment to recipients."""

    def test_assign_category_success(self, client: TestClient, test_db: Session):
        """Test successful category assignment."""
        # Create test category
        category = Category(general="GROCERIES", detail="FOOD")
        test_db.add(category)

        # Create test recipients
        recipient1 = Recipient(name="TEST RECIPIENT 1")
        recipient2 = Recipient(name="TEST RECIPIENT 2")
        test_db.add_all([recipient1, recipient2])
        test_db.commit()

        assignment_data = {
            "category_general": "groceries",
            "category_detail": "food",
            "recipient_ids": [recipient1.id, recipient2.id]
        }

        response = client.post("/api/categories/assign", json=assignment_data)

        assert response.status_code == 200
        data = response.json()

        # Verify response
        assert "updated_recipients" in data
        assert data["updated_recipients"] == 2
        assert "links" in data

        # Verify recipients have been updated
        test_db.refresh(recipient1)
        test_db.refresh(recipient2)
        assert recipient1.default_category_id == category.id
        assert recipient2.default_category_id == category.id

    def test_assign_category_single_recipient(self, client: TestClient, test_db: Session):
        """Test category assignment to single recipient."""
        # Create test category and recipient
        category = Category(general="GROCERIES", detail="FOOD")
        recipient = Recipient(name="TEST RECIPIENT")
        test_db.add_all([category, recipient])
        test_db.commit()

        assignment_data = {
            "category_general": "groceries",
            "category_detail": "food",
            "recipient_ids": recipient.id  # Single ID, not list
        }

        response = client.post("/api/categories/assign", json=assignment_data)

        assert response.status_code == 200
        data = response.json()

        assert data["updated_recipients"] == 1

    def test_assign_category_not_found(self, client: TestClient, test_db: Session):
        """Test assignment with non-existent category - should create it."""
        # Create test recipient
        recipient = Recipient(name="TEST RECIPIENT")
        test_db.add(recipient)
        test_db.commit()

        assignment_data = {
            "category_general": "nonexistent",
            "category_detail": "category",
            "recipient_ids": [recipient.id]
        }

        response = client.post("/api/categories/assign", json=assignment_data)
        # Category is created if it doesn't exist, so this should succeed
        assert response.status_code == 200
        data = response.json()
        assert data["updated_recipients"] == 1

    def test_assign_category_recipient_not_found(self, client: TestClient, test_db: Session):
        """Test assignment to non-existent recipient."""
        # Create test category
        category = Category(general="GROCERIES", detail="FOOD")
        test_db.add(category)
        test_db.commit()

        assignment_data = {
            "category_general": "groceries",
            "category_detail": "food",
            "recipient_ids": [99999]  # Non-existent recipient
        }

        response = client.post("/api/categories/assign", json=assignment_data)
        assert response.status_code == 404

    def test_assign_category_invalid_data(self, client: TestClient):
        """Test assignment with invalid data."""
        # Missing required fields
        invalid_data = {"recipient_ids": [1]}
        response = client.post("/api/categories/assign", json=invalid_data)
        assert response.status_code == 422

        # Invalid recipient IDs
        invalid_data = {
            "category_general": "groceries",
            "category_detail": "food",
            "recipient_ids": "invalid"
        }
        response = client.post("/api/categories/assign", json=invalid_data)
        assert response.status_code == 422


class TestCategoriesOptionsEndpoints:
    """Test cases for OPTIONS endpoints."""

    def test_categories_collection_options(self, client: TestClient):
        """Test OPTIONS /api/categories endpoint."""
        response = client.options("/api/categories")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert "methods" in data
        assert "links" in data

        # Verify available methods
        methods = [method["method"] for method in data["methods"]]
        expected_methods = ["GET", "POST", "OPTIONS"]
        for method in expected_methods:
            assert method in methods

    def test_category_resource_options(self, client: TestClient, test_db: Session):
        """Test OPTIONS /api/categories/{id} endpoint."""
        # Create test category
        category = Category(general="GROCERIES", detail="FOOD")
        test_db.add(category)
        test_db.commit()

        response = client.options(f"/api/categories/{category.id}")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert "methods" in data
        assert "links" in data

        # Verify available methods
        methods = [method["method"] for method in data["methods"]]
        expected_methods = ["GET", "PATCH", "DELETE", "OPTIONS"]
        for method in expected_methods:
            assert method in methods

    # def test_category_assign_options(self, client: TestClient):
    #     """Test OPTIONS /api/categories/assign endpoint."""
    #     response = client.options("/api/categories/assign")
    #     # FIXME
    #
    #     assert response.status_code == 200
    #     data = response.json()
    #
    #     # Verify response structure
    #     assert "methods" in data
    #     assert "links" in data
    #
    #     # Verify available methods
    #     methods = [method["method"] for method in data["methods"]]
    #     expected_methods = ["POST", "OPTIONS"]
    #     for method in expected_methods:
    #         assert method in methods


class TestCategoriesHATEOASCompliance:
    """Test cases for HATEOAS compliance in category endpoints."""

    def test_category_response_links_structure(self, client: TestClient, sample_category_data):
        """Test that category responses include proper HATEOAS links."""
        response = client.post("/api/categories", json=sample_category_data)

        assert response.status_code == 201
        data = response.json()

        # Verify HATEOAS links structure
        links = data["links"]
        for link in links:
            assert "rel" in link
            assert "href" in link
            assert "method" in link

            # Verify field types
            assert isinstance(link["rel"], str)
            assert isinstance(link["href"], str)
            assert isinstance(link["method"], str)

            # Verify href is a valid URL
            assert link["href"].startswith("http")

    def test_categories_list_navigation_links(self, client: TestClient, test_db: Session, multiple_categories_data):
        """Test pagination navigation links in categories list."""
        # Create test categories
        for category_data in multiple_categories_data:
            category = Category(**category_data)
            test_db.add(category)
        test_db.commit()

        # Test first page
        response = client.get("/api/categories?limit=2&offset=0")
        data = response.json()

        links = data["links"]
        link_rels = [link["rel"] for link in links]

        # Should have next link but not prev on first page
        assert "next" in link_rels
        assert "prev" not in link_rels

        # Test middle page
        response = client.get("/api/categories?limit=2&offset=2")
        data = response.json()

        links = data["links"]
        link_rels = [link["rel"] for link in links]

        # Should have both next and prev links
        assert "next" in link_rels
        assert "prev" in link_rels

    def test_category_links_point_to_correct_resources(self, client: TestClient, sample_category_data):
        """Test that HATEOAS links point to correct resources."""
        response = client.post("/api/categories", json=sample_category_data)
        data = response.json()
        category_id = data["id"]

        links = data["links"]

        # Find self link and verify it points to correct resource
        self_link = next((link for link in links if link["rel"] == "self"), None)
        assert self_link is not None
        assert f"/api/categories/{category_id}" in self_link["href"]

        # Verify the self link actually works
        self_response = client.get(self_link["href"])
        assert self_response.status_code == 200


class TestCategoriesErrorHandling:
    """Test cases for error handling in category endpoints."""

    def test_malformed_json_request(self, client: TestClient):
        """Test handling of malformed JSON requests."""
        response = client.post(
            "/api/categories",
            data="{'invalid': 'json'",  # Malformed JSON
            headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 422

    def test_unsupported_content_type(self, client: TestClient):
        """Test handling of unsupported content types."""
        response = client.post(
            "/api/categories",
            data="general=groceries&detail=food",  # Form data instead of JSON
            headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        assert response.status_code == 422

    @patch('api.api_routes_categories.CategoryService')
    def test_database_error_handling(self, mock_service_class, client: TestClient, sample_category_data):
        """Test handling of database errors."""
        # Mock service to raise database error
        mock_service = MagicMock()
        mock_service.create_or_get_category.side_effect = Exception("Database connection failed")
        mock_service_class.return_value = mock_service

        response = client.post("/api/categories", json=sample_category_data)
        assert response.status_code == 500


class TestCategoriesBusinessLogic:
    """Test cases for category business logic."""

    def test_category_name_normalization(self, client: TestClient):
        """Test that category names are properly normalized."""
        category_data = {
            "general": "  GrOcErIeS  ",  # Mixed case with spaces
            "detail": "  FoOd  ",
            "description": "Test category"
        }

        response = client.post("/api/categories", json=category_data)

        assert response.status_code == 201
        data = response.json()

        # Verify normalization to uppercase and trimming
        assert data["general"] == "GROCERIES"
        assert data["detail"] == "FOOD"

    def test_category_uniqueness_constraint(self, client: TestClient):
        """Test category uniqueness is enforced - duplicates return 200."""
        category_data = {"general": "groceries", "detail": "food", "description": "First"}

        # Create first category
        response1 = client.post("/api/categories", json=category_data)
        assert response1.status_code == 201
        first_id = response1.json()["id"]

        # Try to create same category with different description
        category_data["description"] = "Second"
        response2 = client.post("/api/categories", json=category_data)
        assert response2.status_code == 200  # Returns existing category
        second_id = response2.json()["id"]

        # Should return the same category (uniqueness by general+detail)
        assert first_id == second_id

    def test_inactive_categories_excluded_from_list(self, client: TestClient, test_db: Session):
        """Test that inactive categories are excluded from listing."""
        # Create active and inactive categories
        active_category = Category(general="ACTIVE", detail="CATEGORY", is_active=True)
        inactive_category = Category(general="INACTIVE", detail="CATEGORY", is_active=False)

        test_db.add_all([active_category, inactive_category])
        test_db.commit()

        response = client.get("/api/categories")
        data = response.json()

        # Should only return active categories
        assert len(data["items"]) == 1
        assert data["items"][0]["general"] == "ACTIVE"


class TestCategoriesExceptionHandling:
    """Test exception handling in category endpoints."""

    def test_get_categories_database_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test get_categories handles database exceptions."""
        from services.category_service import CategoryService

        def mock_get_all(*args, **kwargs):
            raise Exception("Database connection failed")

        monkeypatch.setattr(CategoryService, "get_all", mock_get_all)

        response = client.get("/api/categories")
        assert response.status_code == 500
        assert "Failed to retrieve categories" in response.json()["detail"]

    def test_get_category_by_id_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test get_category handles exceptions."""
        from services.category_service import CategoryService

        def mock_get_by_id(*args, **kwargs):
            raise Exception("Database error")

        monkeypatch.setattr(CategoryService, "get_by_id", mock_get_by_id)

        response = client.get("/api/categories/1")
        assert response.status_code == 500
        assert "Failed to retrieve category" in response.json()["detail"]

    def test_update_category_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test update_category handles exceptions."""
        from services.category_service import CategoryService

        def mock_update(*args, **kwargs):
            raise Exception("Update failed")

        monkeypatch.setattr(CategoryService, "update", mock_update)

        response = client.patch("/api/categories/1", json={"general": "UPDATED"})
        assert response.status_code == 500
        assert "Failed to update category" in response.json()["detail"]

    def test_delete_category_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test delete_category handles exceptions properly."""
        from services.category_service import CategoryService
        from database.models import Category

        # Create a test category first
        category = Category(general="GROCERIES", detail="FOOD")
        test_db.add(category)
        test_db.commit()
        test_db.refresh(category)

        def mock_hard_delete(*args, **kwargs):
            raise Exception("Delete failed")

        monkeypatch.setattr(CategoryService, "hard_delete", mock_hard_delete)

        response = client.delete(f"/api/categories/{category.id}")
        assert response.status_code == 500
        assert "Failed to delete category" in response.json()["detail"]

    def test_delete_category_hard_delete_not_found(self, client: TestClient, test_db: Session):
        """Test hard delete returns 404 when category not found."""
        response = client.delete("/api/categories/999?soft=false")
        assert response.status_code == 404
        assert "Category 999 not found" == response.json()["detail"]

    def test_assign_category_exception(self, client: TestClient, test_db: Session, monkeypatch):
        """Test assign_category handles exceptions."""
        from services.category_service import CategoryService

        def mock_create_or_get(*args, **kwargs):
            raise Exception("Assignment failed")

        monkeypatch.setattr(CategoryService, "create_or_get_category", mock_create_or_get)

        response = client.post("/api/categories/assign", json={
            "category_general": "TEST",
            "category_detail": "TEST",
            "recipient_ids": [1]
        })
        assert response.status_code == 500
        assert "Failed to assign category" in response.json()["detail"]

    def test_assign_category_http_exception_reraise(self, client: TestClient, test_db: Session, monkeypatch):
        """Test assign_category re-raises HTTPException."""
        from services.category_service import CategoryService
        from fastapi import HTTPException

        def mock_create_or_get(*args, **kwargs):
            raise HTTPException(status_code=403, detail="Forbidden")

        monkeypatch.setattr(CategoryService, "create_or_get_category", mock_create_or_get)

        response = client.post("/api/categories/assign", json={
            "category_general": "TEST",
            "category_detail": "TEST",
            "recipient_ids": [1]
        })
        assert response.status_code == 403
        assert "Forbidden" in response.json()["detail"]
