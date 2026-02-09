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
from pydantic import HttpUrl
from sqlalchemy.orm import Session

from api.api_schemas import (
    TransactionResponse, TransactionsListResponse,
    TransactionUpdate, OptionsResponse,
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
    """Update an existing transaction.

    Updates one or more fields of an existing transaction. Only provided fields are updated.

    Args:
        transaction_id (int): The unique identifier of the transaction to update.
        transaction_data (TransactionUpdate): Fields to update (all fields optional).
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        TransactionResponse: Updated transaction with HATEOAS links.

    Raises:
        HTTPException: 404 error if transaction not found.
        HTTPException: 500 error if update fails.

    Example:
        PATCH /api/transactions/123
        {
            "amount": 30.00,
            "category_id": 5,
            "memo": "Updated memo"
        }
    """
    try:
        from repositories.transaction_repository import TransactionRepository

        repo = TransactionRepository(db)
        transaction = repo.get_by_id(transaction_id)

        if not transaction:
            logger.warning(
                "Transaction not found for update",
                extra={
                    "operation": "update_transaction",
                    "resource_type": "transaction",
                    "resource_id": transaction_id
                }
            )
            raise HTTPException(status_code=404, detail=f"Transaction with ID {transaction_id} not found")

        # Update only provided fields
        update_data = transaction_data.model_dump(exclude_unset=True, by_alias=False)
        for field, value in update_data.items():
            # Map transaction_date to date for the model
            if field == "transaction_date":
                setattr(transaction, "date", value)
            else:
                setattr(transaction, field, value)

        updated_transaction = repo.update(transaction)

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
            }
        )
        raise HTTPException(status_code=500, detail=f"Error updating transaction: {str(e)}")


@router.delete("/{transaction_id}", response_model=MessageResponse, status_code=200,
               description="Deletes a transaction.")
async def delete_transaction(
        transaction_id: int = Path(..., ge=1, description="Transaction ID"),
        soft: bool = Query(True, description="Perform a soft delete (True) or hard delete (False)"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Delete a transaction with HATEOAS links in response.

    Performs deletion of a transaction. Note: For transactions, both soft and hard
    delete perform permanent deletion as the Transaction model does not have an
    is_active field. The soft parameter is maintained for API consistency.

    Args:
        transaction_id (int): The unique identifier of the transaction to delete.
        soft (bool): Deletion type flag. Defaults to True. Note: Both soft and hard
            delete perform permanent deletion for transactions.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        MessageResponse: Success message confirming deletion with HATEOAS links.

    Raises:
        HTTPException: 404 error if transaction not found.
        HTTPException: 500 error if deletion fails.

    Example:
        DELETE /api/transactions/123
        DELETE /api/transactions/123?soft=false

    Warning:
        Both soft and hard delete perform permanent deletion for transactions.
        Consider archiving transactions instead for audit trail purposes.
    """
    try:
        from services.transaction_service import TransactionService
        from api.hateoas_links import get_deletion_response_links

        service = TransactionService(db)
        if soft:
            if not service.soft_delete(transaction_id):
                logger.warning(
                    "Transaction not found for deletion",
                    extra={
                        "operation": "delete_transaction",
                        "resource_type": "transaction",
                        "resource_id": transaction_id,
                        "soft_delete": soft
                    }
                )
                raise HTTPException(status_code=404, detail=f"Transaction with ID {transaction_id} not found")
        else:
            if not service.hard_delete(transaction_id):
                logger.warning(
                    "Transaction not found for deletion",
                    extra={
                        "operation": "delete_transaction",
                        "resource_type": "transaction",
                        "resource_id": transaction_id,
                        "soft_delete": soft
                    }
                )
                raise HTTPException(status_code=404, detail=f"Transaction with ID {transaction_id} not found")

        logger.info(
            "Transaction deleted successfully",
            extra={
                "operation": "delete_transaction",
                "resource_type": "transaction",
                "resource_id": transaction_id,
                "soft_delete": soft,
                "status": "success"
            }
        )

        return MessageResponse(
            message="Transaction soft deleted successfully" if soft else "Transaction deleted permanently",
            details={"method": "soft delete" if soft else "hard delete"},
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
                "soft_delete": soft,
                "error": str(e),
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error deleting transaction")
