"""API routes for CSV import functionality.

Handles all CSV import-related endpoints with Level 3 REST API (HATEOAS) support.
Provides endpoints for importing transactions from CSV files with support for
predefined bank adapters and custom configurations, as well as import history tracking.

The import process:
1. Validates uploaded file (type, size)
2. Saves file temporarily
3. Uses bank adapter (predefined or custom) to parse CSV
4. Deduplicates transactions
5. Creates/links recipients automatically
6. Persists transactions with batch tracking
7. Returns comprehensive results with HATEOAS links

See docs/HTTP_PARAMETER_USAGE_GUIDELINES.md for comprehensive parameter usage patterns.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Request
from fastapi.params import Path
from sqlalchemy.orm import Session

from api.api_schemas import (
    ImportResultWithLinks, ImportBatchResponse,
    ImportBatchesListResponse, OptionsResponse, MethodInfo, Link
)
from api.hateoas_links import (
    get_import_result_links, get_import_batch_links, get_collection_links
)
from config.logging_config import setup_logging
from database.connection import get_db
from services.csv_configuration_factory import CSVConfigurationFactory, CSVConfigurationError
from services.file_import_handler import FileImportHandler
from services.transaction_import_service import TransactionImportService

router = APIRouter(prefix="/api/import", tags=["import"])
logger = setup_logging(__name__)


@router.options("/csv", response_model=OptionsResponse,
                description="Discover available methods on CSV import endpoint")
async def import_csv_options(request: Request):
    """OPTIONS method for CSV import endpoint discovery.

    Allows clients to discover what HTTP methods are available on the CSV import endpoint.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    from pydantic import HttpUrl
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="POST",
                description="Import transactions from a CSV file with predefined bank adapter"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=[
            Link(
                rel="self",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/import/csv"),
                method="POST",
                title="Import CSV file"
            ),
            Link(
                rel="custom_import",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/import/csv/custom"),
                method="POST",
                title="Import CSV with custom configuration"
            ),
            Link(
                rel="import_history",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/import/batches"),
                method="GET",
                title="View import history"
            )
        ]
    )


@router.post("/csv", response_model=ImportResultWithLinks, status_code=201,
             description="Import transactions from CSV file using predefined bank adapter")
async def import_csv_file(
        file: UploadFile = File(..., description="CSV file to import"),
        bank_name: str = Query(..., description="Name of the bank (e.g., 'Chase', 'Belfius', 'Revolut')"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Import transactions from a CSV file using a predefined bank adapter.

    Accepts a CSV file upload and processes it using a predefined bank adapter
    that knows the specific CSV format for that bank. The import process includes
    deduplication, automatic recipient creation, and comprehensive result tracking.

    **Supported Banks:**
    - Chase
    - Belfius
    - Revolut
    - (Add more as adapters are created)

    **Import Process:**
    1. Validates file type and size (max 50MB)
    2. Creates an import batch record for tracking
    3. Parses CSV using bank-specific adapter
    4. Deduplicates transactions using hash-based comparison
    5. Creates or links recipients automatically
    6. Persists transactions to database
    7. Returns comprehensive results with HATEOAS links

    Args:
        file (UploadFile): CSV file containing transactions. Must have .csv extension.
        bank_name (str): Name of the bank to select the appropriate adapter.
            Case-insensitive (e.g., 'chase', 'Chase', 'CHASE' all work).
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        ImportResultWithLinks: Import results with statistics and HATEOAS links.
            - batch_id: Unique identifier for this import batch
            - total_processed: Number of transactions found in CSV
            - imported: Number of new transactions imported
            - duplicates: Number of duplicates skipped
            - errors: Number of transactions that failed
            - status: 'completed', 'completed_with_errors', or 'failed'
            - error_message: Details if status is 'failed'
            - links: HATEOAS links for next actions

    Raises:
        HTTPException: 400 error if file validation fails or bank name is invalid.
        HTTPException: 500 error if import process fails unexpectedly.

    Example:
        POST /api/import/csv?bank_name=Chase
        Content-Type: multipart/form-data

        file: [binary CSV file data]

        Response (201 Created):
        {
            "batch_id": "123",
            "total_processed": 150,
            "imported": 145,
            "duplicates": 5,
            "errors": 0,
            "status": "completed",
            "error_message": null,
            "links": [
                {
                    "rel": "batch",
                    "href": "http://localhost:8000/api/import/batches/123",
                    "method": "GET",
                    "title": "View import batch details"
                },
                {
                    "rel": "transactions",
                    "href": "http://localhost:8000/api/transactions?batch_id=123",
                    "method": "GET",
                    "title": "View imported transactions"
                },
                ...
            ]
        }

    Note:
        - Maximum file size: 50MB
        - Supported file types: .csv only
        - Duplicate detection is based on transaction hash (date, amount, recipient)
        - Recipients are automatically created if not found
        - All transactions in a batch are associated with the batch_id for tracking
    """
    # Validate file type
    if not FileImportHandler.validate_csv_file(file.filename):
        logger.warning(
            "Invalid file type attempted",
            extra={
                "operation": "import_csv",
                "file_name": file.filename,
                "error": "Not a CSV file"
            }
        )
        raise HTTPException(status_code=400, detail="File must be a CSV")

    tmp_file_path = None
    try:
        # Read file content and save to temporary location
        content = await file.read()

        # Validate file size (50MB max)
        is_valid, error_msg = FileImportHandler.validate_file_size(len(content), max_size_mb=50)
        if not is_valid:
            logger.warning(
                "File size validation failed",
                extra={
                    "operation": "import_csv",
                    "file_name": file.filename,
                    "size_bytes": len(content),
                    "error": error_msg
                }
            )
            raise HTTPException(status_code=400, detail=error_msg)

        # Save to temporary file
        tmp_file_path = FileImportHandler.save_upload_to_temp(content, ".csv")
        logger.debug(f"Saved upload to temporary file: {tmp_file_path}")

        # Perform import using service
        service = TransactionImportService(db)
        result = service.import_csv(tmp_file_path, bank_name)

        logger.info(
            "CSV import completed",
            extra={
                "operation": "import_csv",
                "batch_id": result.get('batch_id'),
                "file_name": file.filename,
                "bank_name": bank_name,
                "imported": result.get('imported', 0),
                "duplicates": result.get('duplicates', 0),
                "errors": result.get('errors', 0),
                "status": result.get('status')
            }
        )

        # Add HATEOAS links - convert batch_id to string as required by schema
        batch_id_int = int(result['batch_id'])
        result['batch_id'] = str(result['batch_id'])
        result_with_links = ImportResultWithLinks(
            **result,
            links=get_import_result_links(request, batch_id_int)
        )

        return result_with_links

    except CSVConfigurationError as e:
        logger.error(
            "CSV configuration error",
            extra={
                "operation": "import_csv",
                "bank_name": bank_name,
                "error": str(e)
            }
        )
        raise HTTPException(status_code=400, detail=f"Invalid bank configuration: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Error importing CSV",
            extra={
                "operation": "import_csv",
                "file_name": file.filename,
                "bank_name": bank_name,
                "error": str(e)
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")
    finally:
        # Clean up temporary file
        if tmp_file_path:
            FileImportHandler.cleanup_temp_file(tmp_file_path)
            logger.debug(f"Cleaned up temporary file: {tmp_file_path}")


@router.options("/csv/custom", response_model=OptionsResponse,
                description="Discover available methods on custom CSV import endpoint")
async def import_csv_custom_options(request: Request):
    """OPTIONS method for custom CSV import endpoint discovery.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    from pydantic import HttpUrl
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="POST",
                description="Import transactions from a CSV file with custom configuration"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=[
            Link(
                rel="self",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/import/csv/custom"),
                method="POST",
                title="Import CSV with custom configuration"
            ),
            Link(
                rel="standard_import",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/import/csv"),
                method="POST",
                title="Import CSV with predefined adapter"
            )
        ]
    )


@router.post("/csv/custom", response_model=ImportResultWithLinks, status_code=201,
             description="Import transactions from CSV with custom configuration")
async def import_csv_custom_config(
        file: UploadFile = File(..., description="CSV file to import"),
        bank_name: str = Query(..., description="Custom bank name for identification"),
        date_format: str = Query(..., description="Date format string (e.g., '%m/%d/%Y', '%d/%m/%Y')"),
        date_column: str = Query(..., description="Name of the date column in CSV"),
        recipient_column: str = Query(..., description="Name of the recipient/description column in CSV"),
        amount_column: str = Query(..., description="Name of the amount column in CSV"),
        memo_column: str = Query(None, description="Name of the memo/notes column in CSV (optional)"),
        separator: str = Query(",", description="CSV separator character (e.g., ',', ';', '\t')"),
        encoding: str = Query("utf-8", description="File encoding (e.g., 'utf-8', 'latin-1', 'iso-8859-1')"),
        skip_rows: int = Query(0, ge=0, description="Number of header rows to skip before data starts"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Import transactions from a CSV file with custom configuration.

    Allows importing transactions from banks or sources that don't have predefined
    adapters by specifying the CSV structure and parsing rules. This is useful for
    one-off imports or testing new bank formats before creating a dedicated adapter.

    **When to Use Custom Import:**
    - Bank doesn't have a predefined adapter
    - Testing a new bank format
    - One-off imports from non-standard sources
    - CSV format varies between downloads

    **Configuration Parameters:**
    The custom configuration defines how to parse the CSV file:
    - **date_format**: Python strftime format (e.g., '%d/%m/%Y' for 31/12/2024)
    - **date_column**: Exact column name containing transaction dates
    - **recipient_column**: Column name for payee/merchant/description
    - **amount_column**: Column name for transaction amounts
    - **memo_column**: Optional column for additional notes
    - **separator**: Character separating columns (comma, semicolon, tab, etc.)
    - **encoding**: Character encoding of the file
    - **skip_rows**: How many header rows to skip

    Args:
        file (UploadFile): CSV file containing transactions.
        bank_name (str): Custom bank name for identification and tracking.
        date_format (str): Python strftime format for parsing dates.
        date_column (str): Name of the date column in the CSV.
        recipient_column (str): Name of the recipient/description column.
        amount_column (str): Name of the amount column.
        memo_column (Optional[str]): Name of the memo column (optional).
        separator (str): CSV separator character. Defaults to comma.
        encoding (str): File encoding. Defaults to 'utf-8'.
        skip_rows (int): Number of rows to skip at file start. Defaults to 0.
        request (Request): Request object for generating URLs.
        db (Session): Database session dependency.

    Returns:
        ImportResultWithLinks: Import results with statistics and HATEOAS links.

    Raises:
        HTTPException: 400 error if file validation or configuration is invalid.
        HTTPException: 500 error if import process fails.

    Example:
        POST /api/import/csv/custom
        ?bank_name=MyBank
        &date_format=%d/%m/%Y
        &date_column=Date
        &recipient_column=Description
        &amount_column=Amount
        &separator=;
        &encoding=utf-8
        &skip_rows=1

        Content-Type: multipart/form-data
        file: [binary CSV file data]

        Response (201 Created):
        {
            "batch_id": "124",
            "total_processed": 75,
            "imported": 70,
            "duplicates": 5,
            "errors": 0,
            "status": "completed",
            "error_message": null,
            "links": [...]
        }

    Note:
        - Configuration is saved with the import batch for reference
        - Same validation and deduplication as standard imports
        - Maximum file size: 50MB
        - Configuration errors are caught and returned with 400 status
    """
    # Validate file type
    if not FileImportHandler.validate_csv_file(file.filename):
        logger.warning(
            "Invalid file type for custom import",
            extra={
                "operation": "import_csv_custom",
                "file_name": file.filename
            }
        )
        raise HTTPException(status_code=400, detail="File must be a CSV")

    tmp_file_path = None
    try:
        # Create and validate configuration using factory
        try:
            custom_config = CSVConfigurationFactory.create_custom_config(
                bank_name=bank_name,
                date_format=date_format,
                date_column=date_column,
                recipient_column=recipient_column,
                amount_column=amount_column,
                memo_column=memo_column,
                separator=separator,
                encoding=encoding,
                skip_rows=skip_rows
            )
            logger.debug(
                "Created custom CSV configuration",
                extra={
                    "operation": "import_csv_custom",
                    "bank_name": bank_name,
                    "separator": separator,
                    "encoding": encoding
                }
            )
        except CSVConfigurationError as e:
            logger.warning(
                "Invalid custom CSV configuration",
                extra={
                    "operation": "import_csv_custom",
                    "bank_name": bank_name,
                    "error": str(e)
                }
            )
            raise HTTPException(status_code=400, detail=f"Invalid configuration: {str(e)}")

        # Read file content and save to temporary location
        content = await file.read()

        # Validate file size (50MB max)
        is_valid, error_msg = FileImportHandler.validate_file_size(len(content), max_size_mb=50)
        if not is_valid:
            logger.warning(
                "File size validation failed for custom import",
                extra={
                    "operation": "import_csv_custom",
                    "file_name": file.filename,
                    "size_bytes": len(content)
                }
            )
            raise HTTPException(status_code=400, detail=error_msg)

        # Save to temporary file
        tmp_file_path = FileImportHandler.save_upload_to_temp(content, ".csv")
        logger.debug(f"Saved custom import to temporary file: {tmp_file_path}")

        # Perform import using service
        service = TransactionImportService(db)
        result = service.import_csv(tmp_file_path, bank_name, custom_config)

        logger.info(
            "Custom CSV import completed",
            extra={
                "operation": "import_csv_custom",
                "batch_id": result.get('batch_id'),
                "file_name": file.filename,
                "bank_name": bank_name,
                "imported": result.get('imported', 0),
                "duplicates": result.get('duplicates', 0),
                "errors": result.get('errors', 0)
            }
        )

        # Add HATEOAS links - convert batch_id to string as required by schema
        batch_id_int = int(result['batch_id'])
        result['batch_id'] = str(result['batch_id'])
        result_with_links = ImportResultWithLinks(
            **result,
            links=get_import_result_links(request, batch_id_int)
        )

        return result_with_links

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Error importing CSV with custom config",
            extra={
                "operation": "import_csv_custom",
                "file_name": file.filename,
                "bank_name": bank_name,
                "error": str(e)
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")
    finally:
        # Clean up temporary file
        if tmp_file_path:
            FileImportHandler.cleanup_temp_file(tmp_file_path)
            logger.debug(f"Cleaned up temporary file: {tmp_file_path}")


# ==================== Import History / Batch Management ====================

@router.options("/batches", response_model=OptionsResponse,
                description="Discover available methods on import batches collection endpoint")
async def import_batches_options(request: Request):
    """OPTIONS method for import batches collection endpoint discovery.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    from pydantic import HttpUrl
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve import batch history with pagination and filtering"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=[
            Link(
                rel="self",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/import/batches"),
                method="GET",
                title="View import history"
            ),
            Link(
                rel="new_import",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/import/csv"),
                method="POST",
                title="Import new CSV file"
            )
        ]
    )


@router.get("/batches", response_model=ImportBatchesListResponse, status_code=200,
            description="Retrieve import batch history")
async def get_import_batches(
        limit: int = Query(50, ge=1, le=1000, description="Maximum number of batches to return"),
        offset: int = Query(0, ge=0, description="Number of batches to skip for pagination"),
        bank_name: str = Query(None, description="Filter by bank name (case-insensitive)"),
        status: str = Query(None, description="Filter by status (e.g., 'completed', 'failed', 'processing')"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get import batch history with pagination, filtering, and HATEOAS links.

    Retrieves a paginated list of import batches with support for filtering by
    bank name and status. Each batch includes comprehensive statistics about the
    import operation and links to view the imported transactions.

    **Use Cases:**
    - Audit import history
    - Monitor import failures
    - Track data provenance
    - Identify duplicate import attempts
    - Review custom import configurations

    Args:
        limit (int): Maximum number of batches to return (1-1000). Defaults to 50.
        offset (int): Number of batches to skip before returning results. Defaults to 0.
        bank_name (str): Filter by partial bank name match (case-insensitive).
        status (str): Filter by exact status match.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        ImportBatchesListResponse: Paginated import batches list with HATEOAS links.

    Raises:
        HTTPException: 500 error if retrieval fails.

    Example:
        # Get all import batches
        GET /api/import/batches

        # Filter by bank name
        GET /api/import/batches?bank_name=Chase

        # Filter by status
        GET /api/import/batches?status=failed

        # Combined with pagination
        GET /api/import/batches?bank_name=Revolut&limit=10&offset=0

        Response (200 OK):
        {
            "items": [
                {
                    "id": 123,
                    "filename": "transactions.csv",
                    "bank_name": "Chase",
                    "status": "completed",
                    "total_processed": 150,
                    "imported_count": 145,
                    "duplicate_count": 5,
                    "error_count": 0,
                    "created_at": "2024-01-15T10:30:00Z",
                    "completed_at": "2024-01-15T10:30:15Z",
                    "links": [...]
                }
            ],
            "total": 45,
            "limit": 50,
            "offset": 0,
            "links": [...]
        }
    """
    try:
        service = TransactionImportService(db)

        # Get batches based on filters
        if bank_name:
            batches = service.batch_repo.get_by_bank_name(bank_name, limit, offset)
        elif status:
            batches = service.batch_repo.get_by_status(status, limit, offset)
        else:
            batches = service.batch_repo.list_recent(limit, offset)

        # Get total count
        total = service.batch_repo.get_total_count()

        logger.info(
            "Retrieved import batches successfully",
            extra={
                "operation": "get_import_batches",
                "count": len(batches),
                "offset": offset,
                "limit": limit,
                "total": total,
                "filters": {
                    "bank_name": bank_name,
                    "status": status
                }
            }
        )

        # Add HATEOAS links to each batch
        for batch in batches:
            batch.links = get_import_batch_links(request, batch.id)

        return ImportBatchesListResponse(
            items=[ImportBatchResponse.model_validate(b) for b in batches],
            total=total,
            limit=limit,
            offset=offset,
            links=get_collection_links(
                request, "import/batches", limit, offset, total,
                bank_name=bank_name, status=status
            )
        )
    except Exception as e:
        logger.error(
            "Failed to retrieve import batches",
            extra={
                "operation": "get_import_batches",
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error retrieving import batches")


@router.options("/batches/{batch_id}", response_model=OptionsResponse,
                description="Discover available methods on individual import batch endpoint")
async def import_batch_resource_options(
        batch_id: int = Path(ge=1, description="The ID of the import batch"),
        request: Request = None
):
    """OPTIONS method for individual import batch resource endpoint discovery.

    Args:
        batch_id (int): The ID of the import batch.
        request (Request): Request object for generating URLs.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve a specific import batch by ID"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=get_import_batch_links(request, batch_id)
    )


@router.get("/batches/{batch_id}", response_model=ImportBatchResponse, status_code=200,
            description="Retrieve a specific import batch by ID")
async def get_import_batch(
        batch_id: int = Path(ge=1, description="The ID of the import batch to retrieve"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get a specific import batch by ID with HATEOAS links.

    Retrieves detailed information about a specific import batch, including
    all statistics, configuration used, and links to view the imported transactions.

    Args:
        batch_id (int): The unique identifier of the import batch.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        ImportBatchResponse: Import batch details with HATEOAS links.

    Raises:
        HTTPException: 404 error if batch not found.
        HTTPException: 500 error if retrieval fails.

    Example:
        GET /api/import/batches/123

        Response (200 OK):
        {
            "id": 123,
            "filename": "transactions.csv",
            "bank_name": "Chase",
            "status": "completed",
            "total_processed": 150,
            "imported_count": 145,
            "duplicate_count": 5,
            "error_count": 0,
            "error_message": null,
            "config_used": null,
            "created_at": "2024-01-15T10:30:00Z",
            "completed_at": "2024-01-15T10:30:15Z",
            "links": [
                {
                    "rel": "self",
                    "href": "http://localhost:8000/api/import/batches/123",
                    "method": "GET",
                    "title": "View this import batch"
                },
                {
                    "rel": "transactions",
                    "href": "http://localhost:8000/api/transactions?batch_id=123",
                    "method": "GET",
                    "title": "View transactions from this batch"
                },
                ...
            ]
        }
    """
    try:
        service = TransactionImportService(db)
        batch = service.batch_repo.get_by_id(batch_id)

        if not batch:
            logger.warning(
                "Import batch not found",
                extra={
                    "operation": "get_import_batch",
                    "batch_id": batch_id
                }
            )
            raise HTTPException(status_code=404, detail=f"Import batch {batch_id} not found")

        logger.info(
            "Retrieved import batch successfully",
            extra={
                "operation": "get_import_batch",
                "batch_id": batch_id,
                "status": batch.status
            }
        )

        # Add HATEOAS links
        batch.links = get_import_batch_links(request, batch.id)

        return ImportBatchResponse.model_validate(batch)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to retrieve import batch",
            extra={
                "operation": "get_import_batch",
                "batch_id": batch_id
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error retrieving import batch")
