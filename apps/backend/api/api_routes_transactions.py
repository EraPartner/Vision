"""
API routes for transaction management.

Handles all transaction-related endpoints with Level 3 REST API (HATEOAS) support.
Provides CRUD operations for financial transactions with proper validation and
response models.

See docs/HTTP_PARAMETER_USAGE_GUIDELINES.md for comprehensive parameter usage patterns.
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.params import Path, Body
from fastapi.responses import FileResponse
from pydantic import HttpUrl
from sqlalchemy.orm import Session

from api.api_schemas import (
    TransactionResponse, TransactionsListResponse,
    TransactionCreate, TransactionUpdate, OptionsResponse,
    MethodInfo, Link, MessageResponse
)
from api.hateoas_links import (
    get_resource_links, get_collection_links
)
from config.logging_config import setup_logging
from database.connection import get_db
from services.transaction_query_service import TransactionQueryService

router = APIRouter(prefix="/api/transactions", tags=["transactions"])
logger = setup_logging(__name__)


@router.options("", response_model=OptionsResponse,
                description="Discover available methods on transactions collection endpoint")
async def transactions_collection_options(
        request: Request,
        limit: int = Query(50, ge=1, le=5000, description="Maximum number of transactions to return"),
        offset: int = Query(0, ge=0, description="Number of transactions to skip for pagination"),
        start_date: Optional[str] = Query(None, description="Start date filter (YYYY-MM-DD)"),
        end_date: Optional[str] = Query(None, description="End date filter (YYYY-MM-DD)"),
        bank_account: Optional[str] = Query(None, description="Filter by partial bank account match"),
        category_id: Optional[int] = Query(None, description="Filter by category ID"),
        recipient_id: Optional[int] = Query(None, description="Filter by recipient ID"),
        recipient_name: Optional[str] = Query(None, description="Filter by partial recipient name match"),
        uncategorised: bool = Query(False, description="Filter for uncategorised transactions"),
        active: bool = Query(True, description="Filter by active status")
):
    """
    OPTIONS method for transactions collection endpoint discovery.

    Allows clients to discover what HTTP methods are available on the transactions collection endpoint.
    Accepts same query parameters as GET endpoint to support CORS preflight requests with query strings.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve all transactions with pagination"
            ),
            MethodInfo(
                method="POST",
                description="Create a new transaction"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=[
            Link(
                rel="self",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/transactions"),
                method="GET",
                title="List all transactions"
            ),
            Link(
                rel="export",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/transactions/export/csv"),
                method="GET",
                title="Export transactions to CSV"
            )
        ]
    )


@router.get("", response_model=TransactionsListResponse, status_code=200,
            description="Retrieves all transactions.")
async def get_transactions(
        limit: int = Query(50, ge=1, le=5000, description="Maximum number of transactions to return"),
        offset: int = Query(0, ge=0, description="Number of transactions to skip for pagination"),
        start_date: Optional[str] = Query(None, description="Start date filter (YYYY-MM-DD)"),
        end_date: Optional[str] = Query(None, description="End date filter (YYYY-MM-DD)"),
        bank_account: Optional[str] = Query(None,
                                            description="Filter by partial bank account match (case-insensitive)"),
        category_id: Optional[int] = Query(None, description="Filter by category ID"),
        recipient_id: Optional[int] = Query(None, description="Filter by recipient ID"),
        recipient_name: Optional[str] = Query(None,
                                              description="Filter by partial recipient name match (case-insensitive)"),
        uncategorised: bool = Query(False,
                                    description="Filter for uncategorised transactions (recipient has no default category)"),
        active: bool = Query(True, description="Filter by active status. True for active only, False for all"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get transactions with pagination, filtering, and HATEOAS links.

    Retrieves a paginated and optionally filtered list of transactions with links to available actions.
    Supports comprehensive filtering by date range, bank account, category, recipient, and more.

    Args:
        limit (int): Maximum number of transactions to return (1-5000). Defaults to 50.
        offset (int): Number of transactions to skip before returning results. Defaults to 0.
        start_date (Optional[str]): Filter by start date (YYYY-MM-DD format, inclusive).
        end_date (Optional[str]): Filter by end date (YYYY-MM-DD format, inclusive).
        bank_account (Optional[str]): Filter by partial bank account match (case-insensitive).
        category_id (Optional[int]): Filter by exact category ID.
        recipient_id (Optional[int]): Filter by exact recipient ID.
        recipient_name (Optional[str]): Filter by partial recipient name match (case-insensitive).
        uncategorised (bool): If True, return only transactions where recipient has no default category.
        active (bool): Filter by active status. True for active only, False for all. Defaults to True.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        TransactionsListResponse: Paginated and filtered transactions list with HATEOAS links.

    Raises:
        HTTPException: 400 error if date format is invalid.
        HTTPException: 500 error if retrieval fails.

    Example:
        # Get all active transactions
        GET /api/transactions

        # Get transactions for specific date range
        GET /api/transactions?start_date=2024-01-01&end_date=2024-12-31

        # Get transactions for specific bank account
        GET /api/transactions?bank_account=revolut

        # Get transactions by category
        GET /api/transactions?category_id=5

        # Get uncategorised transactions
        GET /api/transactions?uncategorised=true

        # Combined filters with pagination
        GET /api/transactions?bank_account=revolut&start_date=2024-01-01&limit=100&offset=0
    """
    try:
        service = TransactionQueryService(db)

        # Parse dates if provided
        s_date = date.fromisoformat(start_date) if start_date else None
        e_date = date.fromisoformat(end_date) if end_date else None

        # Get transactions based on filters
        if uncategorised:
            transactions = service.get_uncategorised_transactions(
                limit=limit,
                offset=offset,
                start_date=s_date,
                end_date=e_date,
                bank_account=bank_account,
                recipient_id=recipient_id,
                recipient_name=recipient_name,
            )
        else:
            transactions = service.get_transactions(
                limit=limit,
                offset=offset,
                start_date=s_date,
                end_date=e_date,
                bank_account=bank_account,
                category_id=category_id,
                recipient_id=recipient_id,
                recipient_name=recipient_name,
                active=active
            )

        # Get filtered count when filters are applied
        if any([start_date, end_date, bank_account, category_id, recipient_id, recipient_name]):
            total = service.get_filtered_count(
                bank_account=bank_account,
                start_date=s_date,
                end_date=e_date,
                category_id=category_id,
                recipient_id=recipient_id,
                recipient_name=recipient_name,
                active=active
            )
        else:
            total = service.get_total_count(active)

        logger.info(
            "Retrieved transactions successfully",
            extra={
                "operation": "get_transactions",
                "resource_type": "transactions",
                "count": len(transactions),
                "offset": offset,
                "limit": limit,
                "total": total,
                "active_filter": active,
                "uncategorised_filter": uncategorised,
                "filters": {
                    "start_date": start_date,
                    "end_date": end_date,
                    "bank_account": bank_account,
                    "category_id": category_id,
                    "recipient_id": recipient_id,
                    "recipient_name": recipient_name
                }
            }
        )

        # Build response with HATEOAS links
        transaction_responses = []
        for txn in transactions:
            txn.links = get_resource_links(request, "transactions", txn.id)
            transaction_responses.append(TransactionResponse.model_validate(txn))

        # Build query parameters for pagination links
        query_params = {}
        if start_date:
            query_params["start_date"] = start_date
        if end_date:
            query_params["end_date"] = end_date
        if bank_account:
            query_params["bank_account"] = bank_account
        if category_id:
            query_params["category_id"] = category_id
        if recipient_id:
            query_params["recipient_id"] = recipient_id
        if recipient_name:
            query_params["recipient_name"] = recipient_name
        if uncategorised:
            query_params["uncategorised"] = uncategorised
        if not active:
            query_params["active"] = active

        return TransactionsListResponse(
            items=transaction_responses,
            total=total,
            limit=limit,
            offset=offset,
            links=get_collection_links(request, "transactions", limit, offset, total, **query_params)
        )

    except ValueError as e:
        logger.error(
            "Invalid date format",
            extra={
                "operation": "get_transactions",
                "error": str(e),
                "start_date": start_date,
                "end_date": end_date
            }
        )
        raise HTTPException(status_code=400, detail="Invalid date format; use YYYY-MM-DD")
    except Exception as e:
        logger.error(
            "Error retrieving transactions",
            extra={
                "operation": "get_transactions",
                "error": str(e)
            }
        )
        raise HTTPException(status_code=500, detail="Error retrieving transactions")


@router.post("", response_model=TransactionResponse, status_code=201,
             description="Creates a new transaction.")
async def create_transaction(
        transaction: TransactionCreate = Body(...,
                                              description="Transaction creation data including date, bank account, recipient, amount, and optional fields."),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Create a new transaction with HATEOAS links and duplicate detection.

    Creates a new financial transaction with all required and optional fields.
    Validates that the recipient and category (if provided) exist before creation.
    Performs duplicate checking using bank_reference and original_raw_data to prevent
    duplicate imports.

    Args:
        transaction (TransactionCreate): Transaction creation data including:
            - transaction_date: Transaction date (required)
            - bank_account: Bank account name (required)
            - recipient_id: Recipient ID (required)
            - amount: Transaction amount (required)
            - memo: Transaction memo/note (optional)
            - currency: Currency code (EUR, USD, etc.) (optional)
            - balance: Account balance after transaction (optional)
            - category_id: Category ID (optional)
            - comment: Additional comment (optional)
            - batch_id: Import batch ID (optional)
            - original_raw_data: Original CSV row for duplicate detection (optional)
            - bank_reference: Bank's transaction ID for duplicate detection (optional)
            - skip_duplicate_check: Skip duplicate checking (optional, default: False)
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        TransactionResponse: The created transaction with HATEOAS links.

    Raises:
        HTTPException: 400 error for validation errors (invalid recipient_id, category_id, duplicate found).
        HTTPException: 500 error if creation fails.

    Example:
        POST /api/transactions
        Content-Type: application/json

        {
            "date": "2026-02-16",
            "bank_account": "Revolut",
            "recipient_id": 5,
            "amount": 25.50,
            "memo": "Coffee shop purchase",
            "currency": "EUR",
            "category_id": 3,
            "bank_reference": "TXN-2026-001234",
            "original_raw_data": "2026-02-16,Coffee Shop,4.50,EUR,..."
        }

        Response (201 Created):
        {
            "id": 123,
            "transaction_date": "2026-02-16",
            "bank_account": "Revolut",
            "recipient_id": 5,
            "recipient_name": "Coffee Shop",
            "amount": 25.50,
            "memo": "Coffee shop purchase",
            "currency": "EUR",
            "category_id": 3,
            "category_name": "FOOD:BEVERAGES",
            "created_at": "2026-02-16T10:30:00Z",
            "links": [...]
        }

        # Duplicate attempt returns 400 error
        {
            "detail": "Duplicate transaction found (ID: 123). A transaction with the same bank reference already exists for Revolut."
        }

    Note:
        - Recipient must exist in database
        - Category must exist if category_id is provided
        - Duplicate checking prevents re-importing the same transaction
        - All creations are logged for audit purposes
    """
    try:
        from services.transaction_service import TransactionService

        service = TransactionService(db)

        # Create transaction using service layer with duplicate checking
        new_transaction = service.create(
            transaction_date=transaction.transaction_date,
            bank_account=transaction.bank_account,
            recipient_id=transaction.recipient_id,
            amount=transaction.amount,
            memo=transaction.memo,
            currency=transaction.currency,
            balance=transaction.balance,
            category_id=transaction.category_id,
            comment=transaction.comment,
            batch_id=transaction.batch_id,
            original_raw_data=transaction.original_raw_data,
            bank_reference=transaction.bank_reference,
            skip_duplicate_check=transaction.skip_duplicate_check
        )

        logger.info(
            "Transaction created successfully",
            extra={
                "operation": "create_transaction",
                "resource_type": "transaction",
                "resource_id": new_transaction.id,
                "bank_account": transaction.bank_account,
                "recipient_id": transaction.recipient_id,
                "amount": transaction.amount,
                "has_bank_reference": transaction.bank_reference is not None,
                "has_raw_data": transaction.original_raw_data is not None
            }
        )

        new_transaction.links = get_resource_links(request, "transactions", new_transaction.id)
        return TransactionResponse.model_validate(new_transaction)

    except ValueError as e:
        logger.error(
            "Validation error creating transaction",
            extra={
                "operation": "create_transaction",
                "resource_type": "transaction",
                "error": str(e)
            }
        )
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(
            "Failed to create transaction",
            extra={
                "operation": "create_transaction",
                "resource_type": "transaction",
                "status": "failed",
                "error": str(e)
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error creating transaction")


@router.get("/{transaction_id}", response_model=TransactionResponse, status_code=200,
            description="Retrieves a single transaction by ID.")
async def get_transaction_by_id(
        transaction_id: int = Path(..., ge=1, description="Transaction ID"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get a single transaction by its ID.

    Retrieves detailed information about a specific transaction identified by its ID.

    Args:
        transaction_id (int): The unique identifier of the transaction (must be >= 1).
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        TransactionResponse: Transaction details with HATEOAS links.

    Raises:
        HTTPException: 404 error if transaction not found.
        HTTPException: 500 error if retrieval fails.

    Example:
        GET /api/transactions/123
    """
    try:
        service = TransactionQueryService(db)
        transaction = service.get_transaction_by_id(transaction_id)

        if not transaction:
            logger.warning(
                "Transaction not found",
                extra={
                    "operation": "get_transaction_by_id",
                    "resource_type": "transaction",
                    "resource_id": transaction_id
                }
            )
            raise HTTPException(status_code=404, detail=f"Transaction with ID {transaction_id} not found")

        logger.info(
            "Retrieved transaction successfully",
            extra={
                "operation": "get_transaction_by_id",
                "resource_type": "transaction",
                "resource_id": transaction_id
            }
        )

        transaction.links = get_resource_links(request, "transactions", transaction.id)
        return TransactionResponse.model_validate(transaction)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Error retrieving transaction",
            extra={
                "operation": "get_transaction_by_id",
                "resource_type": "transaction",
                "resource_id": transaction_id,
                "error": str(e)
            }
        )
        raise HTTPException(status_code=500, detail="Error retrieving transaction")


@router.patch("/{transaction_id}", response_model=TransactionResponse, status_code=200,
              description="Updates an existing transaction.")
async def update_transaction(
        transaction_id: int = Path(..., ge=1, description="Transaction ID"),
        transaction_data: TransactionUpdate = Body(...),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Update an existing transaction with support for name-based updates.

    Updates one or more fields of an existing transaction. Only provided fields are updated.
    Supports updating recipients and categories by either ID or name:

    - Use recipient_id or recipient_name (name will be resolved to ID)
    - Use category_id or category_name in 'General:Detail' format (name will be resolved to ID)
    - If both ID and name are provided, ID takes precedence
    - Names are automatically normalized to uppercase

    Args:
        transaction_id (int): The unique identifier of the transaction to update.
        transaction_data (TransactionUpdate): Fields to update (all fields optional).
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        TransactionResponse: Updated transaction with HATEOAS links.

    Raises:
        HTTPException: 400 error for validation errors (recipient/category not found).
        HTTPException: 404 error if transaction not found.
        HTTPException: 500 error if update fails.

    Example:
        # Update by ID
        PATCH /api/transactions/123
        {
            "amount": 30.00,
            "category_id": 5,
            "memo": "Updated memo"
        }

        # Update by name
        PATCH /api/transactions/123
        {
            "recipient_name": "Coffee Shop",
            "category_name": "FOOD:BEVERAGES",
            "amount": 4.50
        }

        # Update with mixed ID and name (case-insensitive input)
        PATCH /api/transactions/123
        {
            "recipient_name": "coffee shop",  # Will be normalized to "COFFEE SHOP"
            "category_name": "food:beverages",  # Will be normalized to "FOOD:BEVERAGES"
            "memo": "Morning coffee"
        }

    Note:
        - Names are automatically normalized to uppercase
        - Category name must be in 'General:Detail' format
        - Recipient and category must exist in database
    """
    try:
        from services.transaction_service import TransactionService

        service = TransactionService(db)

        # Extract update data excluding unset fields
        update_data = transaction_data.model_dump(exclude_unset=True, by_alias=False)

        # Handle transaction_date alias mapping
        if "transaction_date" in update_data:
            update_data["transaction_date"] = update_data.pop("transaction_date")

        # Update transaction using service layer with name-to-ID translation
        updated_transaction = service.update(
            transaction_id=transaction_id,
            **update_data
        )

        logger.info(
            "Transaction updated successfully",
            extra={
                "operation": "update_transaction",
                "resource_type": "transaction",
                "resource_id": transaction_id,
                "updated_fields": list(update_data.keys())
            }
        )

        updated_transaction.links = get_resource_links(request, "transactions", updated_transaction.id)
        return TransactionResponse.model_validate(updated_transaction)

    except ValueError as e:
        # Handle validation errors from service layer
        logger.error(
            "Validation error updating transaction",
            extra={
                "operation": "update_transaction",
                "resource_type": "transaction",
                "resource_id": transaction_id,
                "error": str(e)
            }
        )
        # Check if it's a "not found" error for the transaction itself
        if "does not exist" in str(e) and f"ID {transaction_id}" in str(e):
            raise HTTPException(status_code=404, detail=str(e))
        # Otherwise it's a validation error (invalid recipient/category)
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Error updating transaction",
            extra={
                "operation": "update_transaction",
                "resource_type": "transaction",
                "resource_id": transaction_id,
                "error": str(e)
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail=f"Error updating transaction: {str(e)}")


@router.delete("/{transaction_id}", response_model=MessageResponse, status_code=200,
               description="Deletes a transaction.")
async def delete_transaction(
        transaction_id: int = Path(..., ge=1, description="Transaction ID"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Delete a transaction permanently with HATEOAS links in response.

    Performs a hard delete by permanently removing the transaction from the database.
    To deactivate a transaction instead, use PATCH to set is_active to false.

    Args:
        transaction_id (int): The unique identifier of the transaction to delete.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        MessageResponse: Success message confirming deletion with HATEOAS links.

    Raises:
        HTTPException: 404 error if transaction not found.
        HTTPException: 500 error if deletion fails.

    Example:
        DELETE /api/transactions/123

    Note:
        Use PATCH with is_active=false to deactivate instead of permanently deleting.
    """
    try:
        from services.transaction_service import TransactionService
        from api.hateoas_links import get_deletion_response_links

        service = TransactionService(db)
        if not service.hard_delete(transaction_id):
            logger.warning(
                "Transaction not found for deletion",
                extra={
                    "operation": "delete_transaction",
                    "resource_type": "transaction",
                    "resource_id": transaction_id
                }
            )
            raise HTTPException(status_code=404, detail=f"Transaction with ID {transaction_id} not found")

        logger.info(
            "Transaction deleted successfully",
            extra={
                "operation": "delete_transaction",
                "resource_type": "transaction",
                "resource_id": transaction_id
            }
        )

        return MessageResponse(
            message="Transaction deleted permanently",
            details={"method": "hard delete"},
            links=get_deletion_response_links(request, "transactions")
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to delete transaction",
            extra={
                "operation": "delete_transaction",
                "resource_type": "transaction",
                "resource_id": transaction_id,
                "error": str(e),
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error deleting transaction")


@router.options("/export/csv", response_model=OptionsResponse,
                description="Discover available methods on transactions export endpoint")
async def export_transactions_options(request: Request):
    """OPTIONS method for transactions export endpoint discovery.

    Allows clients to discover what HTTP methods are available on the export endpoint.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Export transactions to CSV file"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=[
            Link(
                rel="self",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/transactions/export/csv"),
                method="GET",
                title="Export transactions to CSV"
            ),
            Link(
                rel="collection",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/transactions"),
                method="GET",
                title="List all transactions"
            )
        ]
    )


@router.get("/export/csv", response_class=FileResponse,
            description="Export transactions to CSV file.")
async def export_transactions_csv(
        start_date: Optional[str] = Query(None, description="Start date filter (YYYY-MM-DD)"),
        end_date: Optional[str] = Query(None, description="End date filter (YYYY-MM-DD)"),
        bank_account: Optional[str] = Query(None, description="Filter by bank account"),
        category_id: Optional[int] = Query(None, description="Filter by category ID", ge=1),
        db: Session = Depends(get_db)
):
    """Export transactions to CSV file with optional filtering.

    Exports transactions to a CSV file with support for filtering by date range,
    bank account, and category. The CSV includes all transaction details including
    recipient, category, amounts, and metadata.

    Args:
        start_date (Optional[str]): Start date filter in YYYY-MM-DD format.
        end_date (Optional[str]): End date filter in YYYY-MM-DD format.
        bank_account (Optional[str]): Filter by specific bank account.
        category_id (Optional[int]): Filter by category ID.
        db (Session): Database session dependency.

    Returns:
        FileResponse: CSV file download with transactions data.

    Raises:
        HTTPException: 400 error if date format is invalid.
        HTTPException: 404 error if no transactions found.
        HTTPException: 500 error if export fails.

    Example:
        # Export all transactions
        GET /api/transactions/export/csv

        # Export transactions for specific date range
        GET /api/transactions/export/csv?start_date=2026-01-01&end_date=2026-12-31

        # Export transactions for specific bank account and category
        GET /api/transactions/export/csv?bank_account=Revolut&category_id=5

    CSV Format:
        Date, Bank Account, Recipient, Recipient Account, Memo, Amount,
        Currency, Balance, Category, Comment

    Note:
        - Transactions are ordered by date (oldest first)
        - Category format: "GENERAL:DETAIL"
        - File is returned as attachment with timestamp in filename
    """
    import tempfile
    import os
    from fastapi.responses import FileResponse
    from datetime import datetime

    try:
        # Parse dates if provided
        from_date = None
        to_date = None

        if start_date:
            try:
                from_date = date.fromisoformat(start_date)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid start_date format: {start_date}. Use YYYY-MM-DD"
                )

        if end_date:
            try:
                to_date = date.fromisoformat(end_date)
            except ValueError:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid end_date format: {end_date}. Use YYYY-MM-DD"
                )

        # Create temporary file for export
        temp_dir = tempfile.gettempdir()
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"transactions_export_{timestamp}.csv"
        file_path = os.path.join(temp_dir, filename)

        # Use export service
        from services.transaction_export_service import TransactionExportService

        export_service = TransactionExportService(db)
        result = export_service.export_to_csv(
            file_path=file_path,
            from_date=from_date,
            to_date=to_date,
            bank_account=bank_account,
            category_id=category_id
        )

        if not result['success']:
            logger.warning(
                "Export returned no transactions",
                extra={
                    "operation": "export_transactions_csv",
                    "resource_type": "transactions",
                    "filters": {
                        "start_date": start_date,
                        "end_date": end_date,
                        "bank_account": bank_account,
                        "category_id": category_id
                    }
                }
            )
            raise HTTPException(
                status_code=404,
                detail=result['message']
            )

        logger.info(
            "Transactions exported successfully",
            extra={
                "operation": "export_transactions_csv",
                "resource_type": "transactions",
                "count": result['count'],
                "file_path": file_path
            }
        )

        # Return file as download
        return FileResponse(
            path=file_path,
            filename=filename,
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename={filename}"
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to export transactions",
            extra={
                "operation": "export_transactions_csv",
                "resource_type": "transactions",
                "error": str(e),
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail=f"Error exporting transactions: {str(e)}")
