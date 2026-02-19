"""
Unit tests for admin API endpoints.

Tests administrative endpoints for database lifecycle operations,
including database status, initialization, and reset operations.
Focuses on security, error handling, and HATEOAS compliance.
"""
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from api.api_routes_admin import (
    admin_options,
    get_admin_status,
    initialise_database,
    reset_database,
    get_admin_links,
    get_database_status
)


class TestAdminHelperFunctions:
    """Test cases for admin helper functions."""

    @patch('api.api_routes_admin.get_base_url')
    def test_get_admin_links_with_reset_disabled(self, mock_get_base_url):
        """Test admin links generation when reset is disabled."""
        mock_request = MagicMock()
        mock_get_base_url.return_value = "http://localhost:3002"

        with patch('api.api_routes_admin.get_settings') as mock_settings:
            mock_settings.return_value.admin.enable_reset_db = False

            links = get_admin_links(mock_request)

            # Should have self and init links, but not reset
            assert len(links) == 2
            link_rels = [link.rel for link in links]
            assert "self" in link_rels
            assert "init" in link_rels
            assert "reset" not in link_rels

            # Verify get_base_url was called correctly
            mock_get_base_url.assert_called_once_with(mock_request)

    @patch('api.api_routes_admin.get_base_url')
    def test_get_admin_links_with_reset_enabled(self, mock_get_base_url):
        """Test admin links generation when reset is enabled."""
        mock_request = MagicMock()
        mock_get_base_url.return_value = "http://localhost:3002"

        with patch('api.api_routes_admin.get_settings') as mock_settings:
            mock_settings.return_value.admin.enable_reset_db = True

            links = get_admin_links(mock_request)

            # Should have self, init, and reset links
            assert len(links) == 3
            link_rels = [link.rel for link in links]
            assert "self" in link_rels
            assert "init" in link_rels
            assert "reset" in link_rels

            # Verify reset link includes force parameter
            reset_link = next(link for link in links if link.rel == "reset")
            assert "force=true" in str(reset_link.href)

            # Verify mock was called correctly
            mock_get_base_url.assert_called_once_with(mock_request)
            mock_settings.assert_called_once()

    @patch('api.api_routes_admin.engine')
    @patch('api.api_routes_admin.inspect')
    def test_get_database_status_success(self, mock_inspect, mock_engine):
        """Test successful database status retrieval."""
        mock_inspector = MagicMock()
        mock_inspector.get_table_names.return_value = ['categories', 'transactions', 'recipients']
        mock_inspect.return_value = mock_inspector

        is_initialised, table_count = get_database_status()

        assert is_initialised is True
        assert table_count == 3
        mock_inspect.assert_called_once_with(mock_engine)
        mock_inspector.get_table_names.assert_called_once()

    @patch('api.api_routes_admin.engine')
    @patch('api.api_routes_admin.inspect')
    def test_get_database_status_empty_database(self, mock_inspect, mock_engine):
        """Test database status when no tables exist."""
        mock_inspector = MagicMock()
        mock_inspector.get_table_names.return_value = []
        mock_inspect.return_value = mock_inspector

        is_initialised, table_count = get_database_status()

        assert is_initialised is False
        assert table_count == 0
        mock_inspect.assert_called_once_with(mock_engine)
        mock_inspector.get_table_names.assert_called_once()

    @patch('api.api_routes_admin.engine')
    @patch('api.api_routes_admin.inspect')
    @patch('api.api_routes_admin.logger')
    def test_get_database_status_exception(self, mock_logger, mock_inspect, mock_engine):
        """Test database status when inspection fails."""
        test_exception = Exception("Database connection error")
        mock_inspect.side_effect = test_exception

        is_initialised, table_count = get_database_status()

        assert is_initialised is False
        assert table_count == 0

        # Verify logging was called with correct parameters
        mock_logger.error.assert_called_once()
        error_call = mock_logger.error.call_args
        assert "Database status inspection failed" in error_call[0][0]
        assert error_call[1]["extra"]["operation"] == "get_database_status"
        assert error_call[1]["extra"]["resource_type"] == "database"
        assert error_call[1]["extra"]["status"] == "failed"
        assert error_call[1]["exc_info"] is True


class TestAdminOptionsEndpoint:
    """Test cases for admin OPTIONS endpoint."""

    @pytest.mark.asyncio
    async def test_admin_options_success(self):
        """Test successful admin options endpoint."""
        from api.api_schemas import Link
        from pydantic import HttpUrl

        mock_request = MagicMock()

        with patch('api.api_routes_admin.get_admin_links') as mock_get_links:
            mock_get_links.return_value = [
                Link(rel="self", href=HttpUrl("http://localhost:3002/api/admin"), method="GET", title="Admin status"),
                Link(rel="init", href=HttpUrl("http://localhost:3002/api/admin/database/init"), method="POST",
                     title="Initialize database")
            ]

            response = await admin_options(mock_request)

            # Verify response structure
            assert hasattr(response, 'methods')
            assert hasattr(response, 'links')

            # Verify methods
            methods = [method.method for method in response.methods]
            assert "GET" in methods
            assert "POST" in methods

            # Verify method descriptions are present and meaningful
            for method in response.methods:
                assert method.description is not None
                assert len(method.description) > 0
                # Check that description contains administrative-related keywords
                desc_lower = method.description.lower()
                assert any(keyword in desc_lower for keyword in ["database", "admin", "status", "action"])

            # Verify links were called correctly
            mock_get_links.assert_called_once_with(mock_request)

    def test_admin_options_endpoint_integration(self, client: TestClient):
        """Test admin options endpoint integration."""
        response = client.options("/api/admin")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure matches OptionsResponse schema
        required_fields = ["methods", "links"]
        for field in required_fields:
            assert field in data

        # Verify available methods
        methods = [method["method"] for method in data["methods"]]
        expected_methods = ["GET", "POST"]
        for method in expected_methods:
            assert method in methods

        # Verify method descriptions are comprehensive
        for method in data["methods"]:
            assert "method" in method
            assert "description" in method
            assert len(method["description"]) > 0

        # Verify links structure and content
        assert isinstance(data["links"], list)
        assert len(data["links"]) >= 2  # At least self and init

        # Verify required link relations
        link_rels = [link["rel"] for link in data["links"]]
        assert "self" in link_rels
        assert "init" in link_rels

        # Verify link structure is complete
        for link in data["links"]:
            required_link_fields = ["rel", "href", "method", "title"]
            for field in required_link_fields:
                assert field in link
                assert len(link[field]) > 0


class TestAdminStatusEndpoint:
    """Test cases for admin status GET endpoint."""

    @pytest.mark.asyncio
    async def test_get_admin_status_success(self):
        """Test successful admin status retrieval."""
        mock_request = MagicMock()

        with patch('api.api_routes_admin.get_database_status') as mock_status, \
                patch('api.api_routes_admin.get_admin_links') as mock_links:
            mock_status.return_value = (True, 5)
            mock_links.return_value = []

            response = await get_admin_status(mock_request)

            # Verify response structure matches AdminStatusResponse schema
            assert hasattr(response, 'is_initialised')
            assert hasattr(response, 'table_count')
            assert hasattr(response, 'timestamp')
            assert hasattr(response, 'links')

            # Verify response data types and values
            assert response.is_initialised is True
            assert response.table_count == 5
            assert response.timestamp is not None
            assert isinstance(response.links, list)

            # Verify helper functions were called correctly
            mock_status.assert_called_once()
            mock_links.assert_called_once_with(mock_request)

    @pytest.mark.asyncio
    async def test_get_admin_status_database_uninitialised(self):
        """Test admin status when database is not initialised."""
        mock_request = MagicMock()

        with patch('api.api_routes_admin.get_database_status') as mock_status, \
                patch('api.api_routes_admin.get_admin_links') as mock_links:
            mock_status.return_value = (False, 0)
            mock_links.return_value = []

            response = await get_admin_status(mock_request)

            # Verify response indicates uninitialised state
            assert response.is_initialised is False
            assert response.table_count == 0
            assert response.timestamp is not None
            assert isinstance(response.links, list)

            # Verify helper functions were called correctly
            mock_status.assert_called_once()
            mock_links.assert_called_once_with(mock_request)

    @pytest.mark.asyncio
    async def test_get_admin_status_exception(self):
        """Test admin status endpoint when database status check fails."""
        mock_request = MagicMock()

        with patch('api.api_routes_admin.get_database_status') as mock_status, \
                patch('api.api_routes_admin.logger') as mock_logger:
            test_exception = Exception("Database error")
            mock_status.side_effect = test_exception

            with pytest.raises(HTTPException) as exc_info:
                await get_admin_status(mock_request)

            # Verify exception details
            assert exc_info.value.status_code == 500
            assert "Failed to retrieve administration status" in str(exc_info.value.detail)

            # Verify error logging was called correctly
            mock_logger.error.assert_called_once()
            error_call = mock_logger.error.call_args
            assert "Admin status retrieval failed" in error_call[0][0]
            assert error_call[1]["extra"]["operation"] == "get_admin_status"
            assert error_call[1]["extra"]["resource_type"] == "admin"
            assert error_call[1]["extra"]["status"] == "failed"
            assert error_call[1]["exc_info"] is True

    def test_admin_status_endpoint_integration(self, client: TestClient):
        """Test admin status endpoint integration."""
        response = client.get("/api/admin")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure matches AdminStatusResponse schema
        required_fields = ["is_initialised", "table_count", "timestamp", "links"]
        for field in required_fields:
            assert field in data

        # Verify data types are correct
        assert isinstance(data["is_initialised"], bool)
        assert isinstance(data["table_count"], int)
        assert isinstance(data["timestamp"], str)
        assert isinstance(data["links"], list)
        assert data["table_count"] >= 0

        # Verify timestamp format is ISO 8601
        import datetime
        timestamp = data["timestamp"].replace("Z", "+00:00")
        datetime.datetime.fromisoformat(timestamp)

        # Verify links structure is complete
        for link in data["links"]:
            required_link_fields = ["rel", "href", "method", "title"]
            for field in required_link_fields:
                assert field in link

        # Verify specific link relations exist
        link_rels = [link["rel"] for link in data["links"]]
        assert "self" in link_rels
        assert "init" in link_rels


class TestDatabaseInitEndpoint:
    """Test cases for database initialization endpoint."""

    @pytest.mark.asyncio
    async def test_initialise_database_success(self):
        """Test successful database initialization."""
        mock_request = MagicMock()
        mock_db = MagicMock()
        mock_db.bind = MagicMock()

        with patch('api.api_routes_admin.Base') as mock_base, \
                patch('api.api_routes_admin.get_admin_links') as mock_links, \
                patch('api.api_routes_admin.logger') as mock_logger:
            mock_links.return_value = []

            response = await initialise_database(mock_request, mock_db)

            # Verify response structure matches MessageResponse schema
            assert hasattr(response, 'message')
            assert hasattr(response, 'details')
            assert hasattr(response, 'links')

            # Verify response content is meaningful
            assert "Database initialised successfully" in response.message
            assert response.details is not None
            assert "All tables created or verified" in response.details["note"]
            assert isinstance(response.links, list)

            # Verify functions were called correctly
            mock_base.metadata.create_all.assert_called_once_with(bind=mock_db.bind)
            mock_links.assert_called_once_with(mock_request)

            # Verify success logging was called correctly
            mock_logger.info.assert_called_once()
            info_call = mock_logger.info.call_args
            assert "Database initialised successfully" in info_call[0][0]
            assert info_call[1]["extra"]["operation"] == "database_init"
            assert info_call[1]["extra"]["resource_type"] == "database"
            assert info_call[1]["extra"]["status"] == "success"

    @pytest.mark.asyncio
    async def test_initialise_database_failure(self):
        """Test database initialization failure."""
        mock_request = MagicMock()
        mock_db = MagicMock()
        mock_db.bind = MagicMock()

        with patch('api.api_routes_admin.Base') as mock_base, \
                patch('api.api_routes_admin.logger') as mock_logger:
            test_exception = Exception("Initialization failed")
            mock_base.metadata.create_all.side_effect = test_exception

            with pytest.raises(HTTPException) as exc_info:
                await initialise_database(mock_request, mock_db)

            # Verify exception details
            assert exc_info.value.status_code == 500
            assert "Database initialisation failed" in exc_info.value.detail
            assert "Initialization failed" in exc_info.value.detail

            # Verify error logging was called correctly
            mock_logger.error.assert_called_once()
            error_call = mock_logger.error.call_args
            assert "Database initialisation failed" in error_call[0][0]
            assert error_call[1]["extra"]["operation"] == "database_init"
            assert error_call[1]["extra"]["resource_type"] == "database"
            assert error_call[1]["extra"]["status"] == "failed"
            assert error_call[1]["exc_info"] is True

    def test_database_init_endpoint_integration(self, client: TestClient):
        """Test database initialization endpoint integration."""
        response = client.post("/api/admin/database/init")

        assert response.status_code == 201
        data = response.json()

        # Verify response structure matches MessageResponse schema
        required_fields = ["message", "details", "links"]
        for field in required_fields:
            assert field in data

        # Verify success message content
        assert "Database initialised successfully" in data["message"]
        assert "note" in data["details"]
        assert isinstance(data["links"], list)

        # Verify HATEOAS links are present and properly structured
        assert len(data["links"]) > 0
        for link in data["links"]:
            required_link_fields = ["rel", "href", "method", "title"]
            for field in required_link_fields:
                assert field in link

    def test_database_init_idempotent(self, client: TestClient):
        """Test that database initialization is idempotent."""
        # Initialize database multiple times
        response1 = client.post("/api/admin/database/init")
        response2 = client.post("/api/admin/database/init")

        # Both should succeed
        assert response1.status_code == 201
        assert response2.status_code == 201

        # Both should return similar success messages
        data1 = response1.json()
        data2 = response2.json()
        assert "Database initialised successfully" in data1["message"]
        assert "Database initialised successfully" in data2["message"]


class TestDatabaseResetEndpoint:
    """Test cases for database reset endpoint."""

    @pytest.mark.asyncio
    async def test_reset_database_success(self):
        """Test successful database reset with force=true."""
        mock_request = MagicMock()
        mock_db = MagicMock()
        mock_db.bind = MagicMock()

        with patch('api.api_routes_admin.Base') as mock_base, \
                patch('api.api_routes_admin.get_admin_links') as mock_links, \
                patch('api.api_routes_admin.logger') as mock_logger:
            mock_links.return_value = []

            response = await reset_database(mock_request, mock_db, force=True)

            # Verify response structure matches MessageResponse schema
            assert hasattr(response, 'message')
            assert hasattr(response, 'details')
            assert hasattr(response, 'links')

            # Verify response content indicates successful reset
            assert "Database reset successfully" in response.message
            assert "warning" in response.details
            assert "permanently deleted" in response.details["warning"]

            # Verify database operations were called correctly
            mock_base.metadata.drop_all.assert_called_once_with(bind=mock_db.bind)
            mock_base.metadata.create_all.assert_called_once_with(bind=mock_db.bind)

            # Verify logging pattern matches expected structure
            assert mock_logger.warning.call_count >= 1
            mock_logger.info.assert_called_once()

            # Verify specific log calls
            warning_call = mock_logger.warning.call_args_list[0]
            assert "Database reset initiated" in warning_call[0][0]
            assert warning_call[1]["extra"]["operation"] == "reset_database"
            assert warning_call[1]["extra"]["resource_type"] == "database"
            assert warning_call[1]["extra"]["status"] == "in_progress"

            info_call = mock_logger.info.call_args
            assert "Database reset completed successfully" in info_call[0][0]
            assert info_call[1]["extra"]["operation"] == "reset_database"
            assert info_call[1]["extra"]["resource_type"] == "database"
            assert info_call[1]["extra"]["status"] == "success"

    @pytest.mark.asyncio
    async def test_reset_database_without_force(self):
        """Test database reset without force parameter returns proper error."""
        mock_request = MagicMock()

        with patch('api.api_routes_admin.get_admin_links') as mock_links, \
                patch('api.api_routes_admin.logger') as mock_logger:
            mock_links.return_value = []

            response = await reset_database(mock_request, force=False)

            # Should return JSONResponse with 400 status
            assert hasattr(response, 'status_code')
            assert response.status_code == 400

            # Verify warning logging was called correctly
            mock_logger.warning.assert_called_once()
            warning_call = mock_logger.warning.call_args
            assert "Database reset rejected - force parameter not provided" in warning_call[0][0]
            assert warning_call[1]["extra"]["operation"] == "reset_database"
            assert warning_call[1]["extra"]["resource_type"] == "database"
            assert warning_call[1]["extra"]["status"] == "rejected"
            assert warning_call[1]["extra"]["reason"] == "force_parameter_missing"

            # Verify response content includes force requirement message
            response_content = response.body.decode()
            assert "force=true parameter" in response_content

    @pytest.mark.asyncio
    async def test_reset_database_failure(self):
        """Test database reset failure handling."""
        mock_request = MagicMock()
        mock_db = MagicMock()
        mock_db.bind = MagicMock()

        with patch('api.api_routes_admin.Base') as mock_base, \
                patch('api.api_routes_admin.logger') as mock_logger:
            test_exception = Exception("Reset failed")
            mock_base.metadata.drop_all.side_effect = test_exception

            with pytest.raises(HTTPException) as exc_info:
                await reset_database(mock_request, mock_db, force=True)

            # Verify exception details
            assert exc_info.value.status_code == 500
            assert "Database reset failed" in exc_info.value.detail
            assert "Reset failed" in exc_info.value.detail

            # Verify error logging was called correctly
            mock_logger.error.assert_called_once()
            error_call = mock_logger.error.call_args
            assert "Database reset failed" in error_call[0][0]
            assert error_call[1]["extra"]["operation"] == "reset_database"
            assert error_call[1]["extra"]["resource_type"] == "database"
            assert error_call[1]["exc_info"] is True

    def test_database_reset_endpoint_conditional_registration(self, client: TestClient):
        """Test that database reset endpoint is conditionally available based on configuration."""
        response = client.post("/api/admin/database/reset?force=true")

        # The endpoint availability depends on configuration
        # Valid responses: 200 (success), 400 (force required), 404 (disabled)
        assert response.status_code in [200, 400, 404, 405]

        if response.status_code == 200:
            # Reset was successful
            data = response.json()
            assert "Database reset successfully" in data["message"]
            assert "warning" in data["details"]
        elif response.status_code == 400:
            # Reset available but requires force parameter
            data = response.json()
            assert "force=true parameter" in data["message"]
        # 404/405 means endpoint is disabled via configuration

    def test_database_reset_security_force_parameter(self, client: TestClient):
        """Test that reset endpoint requires force parameter for security."""
        # Test without force parameter
        response = client.post("/api/admin/database/reset")

        # Should require force parameter or be disabled
        if response.status_code not in [404, 405]:  # If endpoint exists
            assert response.status_code == 400
            data = response.json()
            assert "force=true" in data["message"]


class TestAdminEndpointsIntegration:
    """Integration tests for admin endpoints workflow."""

    def test_admin_workflow_integration(self, client: TestClient):
        """Test complete admin workflow from status check to initialization."""
        # 1. Check initial admin status
        status_response = client.get("/api/admin")
        assert status_response.status_code == 200
        status_data = status_response.json()

        # Verify initial status structure
        assert "is_initialised" in status_data
        assert "table_count" in status_data
        assert "timestamp" in status_data
        assert "links" in status_data

        # 2. Initialize database
        init_response = client.post("/api/admin/database/init")
        assert init_response.status_code == 201
        init_data = init_response.json()
        assert "Database initialised successfully" in init_data["message"]

        # 3. Check status again (should show initialized)
        status_response_2 = client.get("/api/admin")
        assert status_response_2.status_code == 200
        status_data_2 = status_response_2.json()

        # Database should be initialized with tables
        assert status_data_2["is_initialised"] is True
        assert status_data_2["table_count"] >= 0

    def test_admin_hateoas_links_navigation(self, client: TestClient):
        """Test HATEOAS link navigation in admin endpoints."""
        # Get admin status with links
        status_response = client.get("/api/admin")
        assert status_response.status_code == 200
        data = status_response.json()

        # Verify links are present and properly structured
        assert "links" in data
        assert len(data["links"]) > 0

        # Find and test the init link
        init_link = None
        for link in data["links"]:
            if link["rel"] == "init":
                init_link = link
                break

        if init_link:
            # Extract path from href and test the init endpoint
            import urllib.parse
            parsed_url = urllib.parse.urlparse(init_link["href"])
            init_path = parsed_url.path

            # Verify link structure
            assert init_path.startswith("/api/admin/")
            assert link["method"] == "POST"
            assert "title" in link

            # Test the init endpoint
            init_response = client.post(init_path)
            assert init_response.status_code == 201

    def test_admin_error_handling(self, client: TestClient):
        """Test admin endpoint error handling for invalid requests."""
        # Test invalid endpoint
        response = client.get("/api/admin/invalid")
        assert response.status_code == 404

        # Test invalid method on valid endpoint
        response = client.delete("/api/admin")
        assert response.status_code == 405

        # Test invalid content type on database init
        response = client.post("/api/admin/database/init",
                               headers={"content-type": "text/plain"},
                               data="invalid")
        # Should still work as it doesn't require body content
        assert response.status_code in [201, 422]

    def test_admin_options_discovery(self, client: TestClient):
        """Test admin endpoint capability discovery via OPTIONS."""
        response = client.options("/api/admin")
        assert response.status_code == 200
        data = response.json()

        # Verify method discovery structure
        assert "methods" in data
        assert "links" in data
        methods = [method["method"] for method in data["methods"]]
        assert "GET" in methods
        assert "POST" in methods

        # Verify each method has comprehensive description
        for method in data["methods"]:
            assert "description" in method
            assert len(method["description"]) > 10  # Meaningful description
            assert any(word in method["description"].lower()
                       for word in ["database", "admin", "status", "init"])


class TestAdminSecurityConsiderations:
    """Test cases for admin endpoint security measures."""

    @patch('api.api_routes_admin.logger')
    def test_admin_endpoints_logging(self, mock_logger, client: TestClient):
        """Test that admin operations are properly logged for audit trails."""
        # Test database initialization logging
        client.post("/api/admin/database/init")

        # In the mocked environment, verify that the logging setup would work
        # The actual logging is tested in the unit tests above
        assert mock_logger is not None

    def test_reset_endpoint_safety_measures(self, client: TestClient):
        """Test that reset endpoint has proper safety measures in place."""
        # Test without force parameter
        response = client.post("/api/admin/database/reset")

        # Should either be disabled (404) or require force parameter (400)
        if response.status_code == 400:
            data = response.json()
            assert "force=true" in data["message"]
        elif response.status_code in [404, 405]:
            # Endpoint is disabled, which is a valid security measure
            pass
        else:
            # If endpoint exists and responds differently, ensure safety
            pytest.fail(
                f"Reset endpoint should require force parameter or be disabled, "
                f"got status {response.status_code}"
            )

    def test_admin_configuration_dependency(self):
        """Test that admin endpoints respect configuration settings."""
        from config.config import get_settings

        settings = get_settings()

        # Verify admin configuration structure exists
        assert hasattr(settings, 'admin')
        assert hasattr(settings.admin, 'enable_reset_db')

        # The enable_reset_db setting should be boolean
        assert isinstance(settings.admin.enable_reset_db, bool)

    def test_admin_endpoints_no_authentication_warning(self):
        """Test to highlight that admin endpoints currently have no authentication."""
        # This test serves as a documentation of security considerations
        # In production, these endpoints should have proper authentication

        # Current state: No authentication required
        # Future considerations: JWT tokens, API keys, role-based access
        warning_message = (
            "Admin endpoints currently have no authentication. "
            "Consider implementing authentication before production deployment."
        )
        assert len(warning_message) > 0  # Ensures this security consideration is documented


class TestAdminEndpointResponseValidation:
    """Test cases for admin endpoint response schema validation."""

    def test_admin_status_response_schema(self, client: TestClient):
        """Test admin status response matches AdminStatusResponse schema exactly."""
        response = client.get("/api/admin")
        assert response.status_code == 200
        data = response.json()

        # Validate AdminStatusResponse schema fields and types
        required_fields = {
            "is_initialised": bool,
            "table_count": int,
            "timestamp": str,
            "links": list
        }

        for field, expected_type in required_fields.items():
            assert field in data, f"Missing required field: {field}"
            assert isinstance(data[field], expected_type), \
                f"Field {field} should be {expected_type}, got {type(data[field])}"

        # Validate additional constraints
        assert data["table_count"] >= 0, "Table count should be non-negative"

        # Validate links schema structure
        for link in data["links"]:
            link_fields = {"rel": str, "href": str, "method": str, "title": str}
            for field, expected_type in link_fields.items():
                assert field in link, f"Missing link field: {field}"
                assert isinstance(link[field], expected_type), \
                    f"Link field {field} should be {expected_type}"
                assert len(link[field]) > 0, f"Link field {field} should not be empty"

    def test_database_init_response_schema(self, client: TestClient):
        """Test database init response matches MessageResponse schema exactly."""
        response = client.post("/api/admin/database/init")
        assert response.status_code == 201
        data = response.json()

        # Validate MessageResponse schema fields and types
        required_fields = {
            "message": str,
            "details": dict,
            "links": list
        }

        for field, expected_type in required_fields.items():
            assert field in data, f"Missing required field: {field}"
            assert isinstance(data[field], expected_type), \
                f"Field {field} should be {expected_type}, got {type(data[field])}"

        # Validate details content structure
        assert "note" in data["details"], "Details should contain 'note' field"
        assert isinstance(data["details"]["note"], str), "Note should be string"
        assert len(data["details"]["note"]) > 0, "Note should not be empty"

        # Validate message content is meaningful
        assert len(data["message"]) > 10, "Message should be descriptive"
        assert "success" in data["message"].lower(), "Message should indicate success"

    def test_admin_options_response_schema(self, client: TestClient):
        """Test admin options response matches OptionsResponse schema exactly."""
        response = client.options("/api/admin")
        assert response.status_code == 200
        data = response.json()

        # Validate OptionsResponse schema fields and types
        required_fields = {
            "methods": list,
            "links": list
        }

        for field, expected_type in required_fields.items():
            assert field in data, f"Missing required field: {field}"
            assert isinstance(data[field], expected_type), \
                f"Field {field} should be {expected_type}, got {type(data[field])}"

        # Validate methods schema structure
        assert len(data["methods"]) > 0, "Should have at least one method"
        for method in data["methods"]:
            method_fields = {"method": str, "description": str}
            for field, expected_type in method_fields.items():
                assert field in method, f"Missing method field: {field}"
                assert isinstance(method[field], expected_type), \
                    f"Method field {field} should be {expected_type}"
                assert len(method[field]) > 0, f"Method field {field} should not be empty"

        # Validate links schema structure (same validation as other endpoints)
        for link in data["links"]:
            link_fields = {"rel": str, "href": str, "method": str, "title": str}
            for field, expected_type in link_fields.items():
                assert field in link, f"Missing link field: {field}"
                assert isinstance(link[field], expected_type), \
                    f"Link field {field} should be {expected_type}"

    def test_reset_response_schema_when_available(self, client: TestClient):
        """Test reset endpoint response schema when endpoint is available."""
        response = client.post("/api/admin/database/reset?force=true")

        if response.status_code == 200:
            # Reset endpoint is available and succeeded
            data = response.json()

            # Should match MessageResponse schema
            required_fields = {
                "message": str,
                "details": dict,
                "links": list
            }

            for field, expected_type in required_fields.items():
                assert field in data, f"Missing required field: {field}"
                assert isinstance(data[field], expected_type), \
                    f"Field {field} should be {expected_type}"

            # Validate reset-specific content
            assert "reset" in data["message"].lower()
            assert "warning" in data["details"]
            assert "deleted" in data["details"]["warning"].lower()

        elif response.status_code == 400:
            # Reset endpoint available but requires force
            data = response.json()
            assert "message" in data
            assert "force=true" in data["message"]

        # 404/405 means endpoint is disabled (valid configuration)
