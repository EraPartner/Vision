"""Unit tests for import API endpoints.

Tests Level 3 REST API compliance, HATEOAS links, import operations,
batch tracking functionality, and proper error handling.
"""
from io import BytesIO
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from database.models import ImportBatch


class TestImportCSVEndpoint:
    """Test cases for CSV import endpoint."""

    def test_import_csv_success(self, client: TestClient, test_db: Session):
        """Test successful CSV import with predefined bank adapter."""
        # Create a simple CSV content
        csv_content = "Date,Description,Amount\n2024-01-15,Test Transaction,100.00\n"
        csv_file = ("test.csv", BytesIO(csv_content.encode()), "text/csv")

        with patch('services.transaction_import_service.TransactionImportService.import_csv') as mock_import:
            mock_import.return_value = {
                'batch_id': 1,
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
            assert "batch_id" in data
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
            assert "batch" in link_rels
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

        with patch('services.transaction_import_service.TransactionImportService.import_csv') as mock_import:
            mock_import.return_value = {
                'batch_id': 1,
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

        with patch('services.transaction_import_service.TransactionImportService.import_csv') as mock_import:
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
        assert "import_history" in link_rels


class TestImportCSVCustomEndpoint:
    """Test cases for custom CSV import endpoint."""

    def test_import_csv_custom_success(self, client: TestClient):
        """Test successful custom CSV import."""
        csv_content = "Date,Description,Amount\n15/01/2024,Test,100.00\n"
        csv_file = ("custom.csv", BytesIO(csv_content.encode()), "text/csv")

        with patch('services.transaction_import_service.TransactionImportService.import_csv') as mock_import:
            mock_import.return_value = {
                'batch_id': 2,
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

            assert data["batch_id"] == "2"
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


class TestImportBatchesListEndpoint:
    """Test cases for import batches collection endpoints."""

    def test_get_import_batches_empty_list(self, client: TestClient):
        """Test GET /api/import/batches with empty database."""
        with patch('services.transaction_import_service.TransactionImportService') as mock_service:
            mock_service.return_value.batch_repo.list_recent.return_value = []
            mock_service.return_value.batch_repo.get_total_count.return_value = 0

            response = client.get("/api/import/batches")

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

    def test_get_import_batches_with_data(self, client: TestClient, test_db: Session):
        """Test GET /api/import/batches with existing batches."""
        # Create test import batches
        batches = []
        for i in range(3):
            batch = ImportBatch(
                filename=f"test_{i}.csv",
                bank_name="Chase",
                status="completed",
                total_processed=10 * (i + 1),
                imported_count=9 * (i + 1),
                duplicate_count=1 * (i + 1),
                error_count=0
            )
            test_db.add(batch)
            batches.append(batch)
        test_db.commit()

        response = client.get("/api/import/batches")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert "items" in data
        assert "total" in data
        assert len(data["items"]) == 3
        assert data["total"] == 3

        # Verify each batch has proper structure
        for item in data["items"]:
            assert "id" in item
            assert "filename" in item
            assert "bank_name" in item
            assert "status" in item
            assert "total_processed" in item
            assert "imported_count" in item
            assert "duplicate_count" in item
            assert "error_count" in item
            assert "created_at" in item
            assert "links" in item

            # Verify HATEOAS links for each item
            item_links = item["links"]
            assert len(item_links) > 0
            item_link_rels = [link["rel"] for link in item_links]
            assert "self" in item_link_rels
            assert "transactions" in item_link_rels

    def test_get_import_batches_with_pagination(self, client: TestClient, test_db: Session):
        """Test GET /api/import/batches with pagination parameters."""
        # Create test batches
        for i in range(5):
            batch = ImportBatch(
                filename=f"test_{i}.csv",
                bank_name="Chase",
                status="completed"
            )
            test_db.add(batch)
        test_db.commit()

        # Test with limit and offset
        response = client.get("/api/import/batches?limit=2&offset=1")

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
        assert "next" in link_rels or "prev" in link_rels

    def test_get_import_batches_filter_by_bank_name(self, client: TestClient, test_db: Session):
        """Test GET /api/import/batches with bank name filter."""
        # Create test batches with different banks
        chase_batch = ImportBatch(filename="chase.csv", bank_name="Chase", status="completed")
        revolut_batch = ImportBatch(filename="revolut.csv", bank_name="Revolut", status="completed")
        test_db.add(chase_batch)
        test_db.add(revolut_batch)
        test_db.commit()

        response = client.get("/api/import/batches?bank_name=Chase")

        assert response.status_code == 200
        data = response.json()

        # Should only return Chase batches
        for item in data["items"]:
            assert "CHASE" in item["bank_name"].upper()

    def test_get_import_batches_filter_by_status(self, client: TestClient, test_db: Session):
        """Test GET /api/import/batches with status filter."""
        # Create test batches with different statuses
        completed_batch = ImportBatch(filename="completed.csv", bank_name="Chase", status="completed")
        failed_batch = ImportBatch(filename="failed.csv", bank_name="Chase", status="failed")
        test_db.add(completed_batch)
        test_db.add(failed_batch)
        test_db.commit()

        response = client.get("/api/import/batches?status=failed")

        assert response.status_code == 200
        data = response.json()

        # Should only return failed batches
        for item in data["items"]:
            assert item["status"] == "failed"

    def test_get_import_batches_invalid_pagination(self, client: TestClient):
        """Test GET /api/import/batches with invalid pagination parameters."""
        # Test negative limit
        response = client.get("/api/import/batches?limit=-1")
        assert response.status_code == 422

        # Test negative offset
        response = client.get("/api/import/batches?offset=-1")
        assert response.status_code == 422

        # Test limit exceeding maximum
        response = client.get("/api/import/batches?limit=1001")
        assert response.status_code == 422

    def test_import_batches_options(self, client: TestClient):
        """Test OPTIONS request on import batches collection endpoint."""
        response = client.options("/api/import/batches")

        assert response.status_code == 200
        data = response.json()

        assert "methods" in data
        assert "links" in data

        methods = [m["method"] for m in data["methods"]]
        assert "GET" in methods
        assert "OPTIONS" in methods


class TestImportBatchResourceEndpoint:
    """Test cases for individual import batch resource endpoints."""

    def test_get_import_batch_success(self, client: TestClient, test_db: Session):
        """Test successful retrieval of a single import batch."""
        # Create test batch
        batch = ImportBatch(
            filename="test.csv",
            bank_name="Chase",
            status="completed",
            total_processed=100,
            imported_count=95,
            duplicate_count=5,
            error_count=0
        )
        test_db.add(batch)
        test_db.commit()
        test_db.refresh(batch)

        response = client.get(f"/api/import/batches/{batch.id}")

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert data["id"] == batch.id
        assert data["filename"] == "test.csv"
        assert data["bank_name"] == "Chase"
        assert data["status"] == "completed"
        assert data["total_processed"] == 100
        assert data["imported_count"] == 95
        assert data["duplicate_count"] == 5
        assert data["error_count"] == 0
        assert "created_at" in data
        assert "links" in data

        # Verify HATEOAS links
        links = data["links"]
        link_rels = [link["rel"] for link in links]
        assert "self" in link_rels
        assert "transactions" in link_rels
        assert "list" in link_rels
        assert "new_import" in link_rels

    def test_get_import_batch_not_found(self, client: TestClient):
        """Test GET /api/import/batches/{id} with non-existent batch."""
        response = client.get("/api/import/batches/99999")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_get_import_batch_invalid_id(self, client: TestClient):
        """Test GET /api/import/batches/{id} with invalid ID."""
        response = client.get("/api/import/batches/invalid")

        assert response.status_code == 422  # Validation error

    def test_get_import_batch_zero_id(self, client: TestClient):
        """Test GET /api/import/batches/{id} with zero ID."""
        response = client.get("/api/import/batches/0")

        assert response.status_code == 422  # Validation error (ID must be >= 1)

    def test_import_batch_resource_options(self, client: TestClient):
        """Test OPTIONS request on individual import batch endpoint."""
        response = client.options("/api/import/batches/1")

        assert response.status_code == 200
        data = response.json()

        assert "methods" in data
        assert "links" in data

        methods = [m["method"] for m in data["methods"]]
        assert "GET" in methods
        assert "OPTIONS" in methods


class TestImportServiceIntegration:
    """Integration tests for import service layer."""

    def test_import_batch_repository_create(self, test_db: Session):
        """Test creating an import batch through repository."""
        from repositories.import_batch_repository import ImportBatchRepository

        repo = ImportBatchRepository(test_db)
        batch = ImportBatch(
            filename="integration_test.csv",
            bank_name="TestBank",
            status="processing"
        )

        created = repo.create(batch)

        assert created.id is not None
        assert created.filename == "integration_test.csv"
        assert created.bank_name == "TestBank"
        assert created.status == "processing"
        assert created.created_at is not None

    def test_import_batch_repository_update(self, test_db: Session):
        """Test updating an import batch through repository."""
        from repositories.import_batch_repository import ImportBatchRepository

        repo = ImportBatchRepository(test_db)

        # Create batch
        batch = ImportBatch(filename="test.csv", bank_name="TestBank", status="processing")
        created = repo.create(batch)

        # Update batch
        created.status = "completed"
        created.imported_count = 50
        updated = repo.update(created)

        assert updated.status == "completed"
        assert updated.imported_count == 50

    def test_import_batch_repository_get_by_id(self, test_db: Session):
        """Test retrieving import batch by ID."""
        from repositories.import_batch_repository import ImportBatchRepository

        repo = ImportBatchRepository(test_db)
        batch = ImportBatch(filename="test.csv", bank_name="TestBank", status="completed")
        created = repo.create(batch)

        retrieved = repo.get_by_id(created.id)

        assert retrieved is not None
        assert retrieved.id == created.id
        assert retrieved.filename == "test.csv"

    def test_import_batch_repository_get_by_id_not_found(self, test_db: Session):
        """Test retrieving non-existent import batch."""
        from repositories.import_batch_repository import ImportBatchRepository

        repo = ImportBatchRepository(test_db)
        retrieved = repo.get_by_id(99999)

        assert retrieved is None

    def test_import_batch_repository_list_recent(self, test_db: Session):
        """Test listing recent import batches."""
        from repositories.import_batch_repository import ImportBatchRepository

        repo = ImportBatchRepository(test_db)

        # Create multiple batches
        for i in range(5):
            batch = ImportBatch(filename=f"test_{i}.csv", bank_name="TestBank", status="completed")
            repo.create(batch)

        recent = repo.list_recent(limit=3)

        assert len(recent) == 3
        # Should be ordered by created_at desc (newest first)

    def test_import_batch_repository_get_by_bank_name(self, test_db: Session):
        """Test filtering batches by bank name."""
        from repositories.import_batch_repository import ImportBatchRepository

        repo = ImportBatchRepository(test_db)

        # Create batches with different banks
        repo.create(ImportBatch(filename="chase.csv", bank_name="Chase", status="completed"))
        repo.create(ImportBatch(filename="revolut.csv", bank_name="Revolut", status="completed"))
        repo.create(ImportBatch(filename="chase2.csv", bank_name="Chase", status="completed"))

        chase_batches = repo.get_by_bank_name("Chase")

        assert len(chase_batches) == 2
        for batch in chase_batches:
            assert "Chase" in batch.bank_name

    def test_import_batch_repository_get_by_status(self, test_db: Session):
        """Test filtering batches by status."""
        from repositories.import_batch_repository import ImportBatchRepository

        repo = ImportBatchRepository(test_db)

        # Create batches with different statuses
        repo.create(ImportBatch(filename="completed.csv", bank_name="TestBank", status="completed"))
        repo.create(ImportBatch(filename="failed.csv", bank_name="TestBank", status="failed"))
        repo.create(ImportBatch(filename="processing.csv", bank_name="TestBank", status="processing"))

        failed_batches = repo.get_by_status("failed")

        assert len(failed_batches) == 1
        assert failed_batches[0].status == "failed"

    def test_import_batch_repository_get_total_count(self, test_db: Session):
        """Test getting total count of import batches."""
        from repositories.import_batch_repository import ImportBatchRepository

        repo = ImportBatchRepository(test_db)

        # Create multiple batches
        for i in range(7):
            repo.create(ImportBatch(filename=f"test_{i}.csv", bank_name="TestBank", status="completed"))

        total = repo.get_total_count()

        assert total == 7


class TestImportExceptionHandling:
    """Test exception handling in import endpoints."""

    def test_import_csv_invalid_bank_config(self, client: TestClient, test_db: Session):
        """Test import_csv handles invalid bank configuration."""
        from services.csv_configuration_factory import CSVConfigurationError

        csv_content = "Date,Description,Amount\n2024-01-01,Test,100.00"
        csv_file = ("test.csv", BytesIO(csv_content.encode()), "text/csv")

        with patch('services.transaction_import_service.TransactionImportService.import_csv') as mock_import:
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

        with patch('services.transaction_import_service.TransactionImportService.import_csv') as mock_import:
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

    def test_get_import_batch_exception(self, client: TestClient, test_db: Session):
        """Test get_import_batch handles exceptions."""
        with patch('repositories.import_batch_repository.ImportBatchRepository.get_by_id') as mock_get:
            mock_get.side_effect = Exception("Database error")

            response = client.get("/api/import/batches/1")

            assert response.status_code == 500
            assert "Error retrieving import batch" in response.json()["detail"]

    def test_get_import_batches_list_exception(self, client: TestClient, test_db: Session):
        """Test get_import_batches handles exceptions."""
        with patch('repositories.import_batch_repository.ImportBatchRepository.list_recent') as mock_list:
            mock_list.side_effect = Exception("Database error")

            response = client.get("/api/import/batches")

            assert response.status_code == 500
            assert "Error retrieving import batches" in response.json()["detail"]
