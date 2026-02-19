"""Unit tests for import API endpoints.

Tests Level 3 REST API compliance, HATEOAS links, import operations,
and proper error handling.
"""
from io import BytesIO
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session


class TestImportCSVEndpoint:
    """Test cases for CSV import endpoint."""

    def test_import_csv_success(self, client: TestClient, test_db: Session):
        """Test successful CSV import with predefined bank adapter."""
        # Create a simple CSV content
        csv_content = "Date,Description,Amount\n2024-01-15,Test Transaction,100.00\n"
        csv_file = ("test.csv", BytesIO(csv_content.encode()), "text/csv")

        with patch('services.raw_transaction_import_service.RawTransactionImportService.import_csv') as mock_import:
            mock_import.return_value = {
                'total_processed': 1,
                'imported': 1,
                'duplicates': 0,
                'errors': 0,
                'status': 'completed'
            }

            response = client.post(
                "/api/import/csv?bank_name=Chase",
                files={"file": csv_file}
            )

            assert response.status_code == 201
            data = response.json()

            # Verify response structure
            assert "total_processed" in data
            assert "imported" in data
            assert "duplicates" in data
            assert "errors" in data
            assert "status" in data
            assert "links" in data

            # Verify statistics
            assert data["total_processed"] == 1
            assert data["imported"] == 1
            assert data["duplicates"] == 0
            assert data["errors"] == 0
            assert data["status"] == "completed"

            # Verify HATEOAS links
            links = data["links"]
            assert len(links) > 0
            link_rels = [link["rel"] for link in links]
            assert "transactions" in link_rels
            assert "new_import" in link_rels
            assert "import_history" in link_rels

    def test_import_csv_invalid_file_type(self, client: TestClient):
        """Test CSV import with invalid file type."""
        txt_file = ("test.txt", BytesIO(b"Not a CSV"), "text/plain")

        response = client.post(
            "/api/import/csv?bank_name=Chase",
            files={"file": txt_file}
        )

        assert response.status_code == 400
        assert "CSV" in response.json()["detail"]

    def test_import_csv_missing_bank_name(self, client: TestClient):
        """Test CSV import without bank name parameter."""
        csv_file = ("test.csv", BytesIO(b"Date,Amount\n"), "text/csv")

        response = client.post(
            "/api/import/csv",
            files={"file": csv_file}
        )

        assert response.status_code == 422  # Validation error

    def test_import_csv_file_too_large(self, client: TestClient):
        """Test CSV import with file exceeding size limit."""
        # Create a file larger than 50MB (mocked)
        csv_file = ("test.csv", BytesIO(b"x" * (51 * 1024 * 1024)), "text/csv")

        with patch('services.file_import_handler.FileImportHandler.validate_file_size') as mock_validate:
            mock_validate.return_value = (False, "File size exceeds 50MB limit")

            response = client.post(
                "/api/import/csv?bank_name=Chase",
                files={"file": csv_file}
            )

            assert response.status_code == 400
            assert "50MB" in response.json()["detail"]

    def test_import_csv_with_errors(self, client: TestClient):
        """Test CSV import that completes with errors."""
        csv_file = ("test.csv", BytesIO(b"Date,Amount\n2024-01-15,100\n"), "text/csv")

        with patch('services.raw_transaction_import_service.RawTransactionImportService.import_csv') as mock_import:
            mock_import.return_value = {
                'total_processed': 10,
                'imported': 8,
                'duplicates': 1,
                'errors': 1,
                'status': 'completed_with_errors'
            }

            response = client.post(
                "/api/import/csv?bank_name=Chase",
                files={"file": csv_file}
            )

            assert response.status_code == 201
            data = response.json()
            assert data["status"] == "completed_with_errors"
            assert data["errors"] == 1
            assert data["imported"] == 8

    def test_import_csv_failed(self, client: TestClient):
        """Test CSV import that fails completely."""
        csv_file = ("test.csv", BytesIO(b"Invalid CSV"), "text/csv")

        with patch('services.raw_transaction_import_service.RawTransactionImportService.import_csv') as mock_import:
            mock_import.side_effect = Exception("Parse error")

            response = client.post(
                "/api/import/csv?bank_name=Chase",
                files={"file": csv_file}
            )

            assert response.status_code == 500
            assert "Import failed" in response.json()["detail"]

    def test_import_csv_options(self, client: TestClient):
        """Test OPTIONS request on CSV import endpoint."""
        response = client.options("/api/import/csv")

        assert response.status_code == 200
        data = response.json()

        # Verify OPTIONS response structure
        assert "methods" in data
        assert "links" in data

        # Verify available methods
        methods = [m["method"] for m in data["methods"]]
        assert "POST" in methods
        assert "OPTIONS" in methods

        # Verify links
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "custom_import" in link_rels


class TestImportCSVCustomEndpoint:
    """Test cases for custom CSV import endpoint."""

    def test_import_csv_custom_success(self, client: TestClient):
        """Test successful custom CSV import."""
        csv_content = "Date,Description,Amount\n15/01/2024,Test,100.00\n"
        csv_file = ("custom.csv", BytesIO(csv_content.encode()), "text/csv")

        with patch('services.raw_transaction_import_service.RawTransactionImportService.import_csv') as mock_import:
            mock_import.return_value = {
                'total_processed': 1,
                'imported': 1,
                'duplicates': 0,
                'errors': 0,
                'status': 'completed'
            }

            response = client.post(
                "/api/import/csv/custom"
                "?bank_name=CustomBank"
                "&date_format=%d/%m/%Y"
                "&date_column=Date"
                "&recipient_column=Description"
                "&amount_column=Amount"
                "&separator=,"
                "&encoding=utf-8"
                "&skip_rows=0",
                files={"file": csv_file}
            )

            assert response.status_code == 201
            data = response.json()

            assert data["total_processed"] == 1
            assert data["imported"] == 1
            assert "links" in data

    def test_import_csv_custom_invalid_config(self, client: TestClient):
        """Test custom CSV import with invalid configuration."""
        csv_file = ("custom.csv", BytesIO(b"data"), "text/csv")

        with patch('services.csv_configuration_factory.CSVConfigurationFactory.create_custom_config') as mock_config:
            from services.csv_configuration_factory import CSVConfigurationError
            mock_config.side_effect = CSVConfigurationError("Invalid date format")

            response = client.post(
                "/api/import/csv/custom"
                "?bank_name=CustomBank"
                "&date_format=invalid"
                "&date_column=Date"
                "&recipient_column=Desc"
                "&amount_column=Amount",
                files={"file": csv_file}
            )

            assert response.status_code == 400
            assert "Invalid configuration" in response.json()["detail"]

    def test_import_csv_custom_missing_required_params(self, client: TestClient):
        """Test custom CSV import with missing required parameters."""
        csv_file = ("custom.csv", BytesIO(b"data"), "text/csv")

        # Missing date_column parameter
        response = client.post(
            "/api/import/csv/custom"
            "?bank_name=CustomBank"
            "&date_format=%d/%m/%Y"
            "&recipient_column=Desc"
            "&amount_column=Amount",
            files={"file": csv_file}
        )

        assert response.status_code == 422  # Validation error

    def test_import_csv_custom_options(self, client: TestClient):
        """Test OPTIONS request on custom CSV import endpoint."""
        response = client.options("/api/import/csv/custom")

        assert response.status_code == 200
        data = response.json()

        assert "methods" in data
        assert "links" in data

        methods = [m["method"] for m in data["methods"]]
        assert "POST" in methods
        assert "OPTIONS" in methods


class TestImportExceptionHandling:
    """Test exception handling in import endpoints."""

    def test_import_csv_invalid_bank_config(self, client: TestClient, test_db: Session):
        """Test import_csv handles invalid bank configuration."""
        from services.csv_configuration_factory import CSVConfigurationError

        csv_content = "Date,Description,Amount\n2024-01-01,Test,100.00"
        csv_file = ("test.csv", BytesIO(csv_content.encode()), "text/csv")

        with patch('services.raw_transaction_import_service.RawTransactionImportService.import_csv') as mock_import:
            mock_import.side_effect = CSVConfigurationError("Invalid bank configuration")

            response = client.post(
                "/api/import/csv?bank_name=UnknownBank",
                files={"file": csv_file}
            )

            assert response.status_code == 400
            assert "Invalid bank configuration" in response.json()["detail"]

    def test_import_csv_custom_invalid_file_type(self, client: TestClient, test_db: Session):
        """Test import_csv_custom rejects non-CSV files."""
        # Create a non-CSV file with proper content but wrong extension
        txt_file = ("test.txt", BytesIO(b"Not a CSV"), "text/plain")

        response = client.post(
            "/api/import/csv/custom"
            "?bank_name=CustomBank"
            "&date_column=Date"
            "&recipient_column=Description"
            "&amount_column=Amount"
            "&date_format=%Y-%m-%d",
            files={"file": txt_file}
        )

        assert response.status_code == 400
        assert "File must be a CSV" in response.json()["detail"]

    def test_import_csv_custom_file_too_large(self, client: TestClient, test_db: Session):
        """Test import_csv_custom rejects files that are too large."""
        # Create a file and mock the size validation
        csv_file = ("test.csv", BytesIO(b"Date,Amount\n2024-01-01,100"), "text/csv")

        with patch('services.file_import_handler.FileImportHandler.validate_file_size') as mock_validate:
            mock_validate.return_value = (False, "File size exceeds maximum allowed size of 50MB")

            response = client.post(
                "/api/import/csv/custom"
                "?bank_name=CustomBank"
                "&date_column=Date"
                "&recipient_column=Description"
                "&amount_column=Amount"
                "&date_format=%Y-%m-%d",
                files={"file": csv_file}
            )

            assert response.status_code == 400
            assert "exceeds maximum allowed size" in response.json()["detail"]

    def test_import_csv_custom_exception(self, client: TestClient, test_db: Session):
        """Test import_csv_custom handles general exceptions."""
        csv_file = ("test.csv", BytesIO(b"Date,Description,Amount\n2024-01-01,Test,100.00"), "text/csv")

        with patch('services.raw_transaction_import_service.RawTransactionImportService.import_csv') as mock_import:
            mock_import.side_effect = Exception("Import processing failed")

            response = client.post(
                "/api/import/csv/custom"
                "?bank_name=CustomBank"
                "&date_column=Date"
                "&recipient_column=Description"
                "&amount_column=Amount"
                "&date_format=%Y-%m-%d",
                files={"file": csv_file}
            )

            assert response.status_code == 500
            assert "Import failed" in response.json()["detail"]
