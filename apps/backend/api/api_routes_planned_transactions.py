"""
API routes for planned transaction management.

Handles all planned transaction-related endpoints with Level 3 REST API (HATEOAS) support.
Provides CRUD operations for planned financial transactions with proper validation and
response models.
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.params import Path, Body
from pydantic import HttpUrl
from sqlalchemy.orm import Session

from api.api_schemas import (
    PlannedTransactionResponse, PlannedTransactionsListResponse,
    PlannedTransactionCreate, PlannedTransactionUpdate,
    PlannedTransactionExecuteRequest, OptionsResponse,
    MethodInfo, Link, MessageResponse
)
from api.hateoas_links import (
    get_resource_links, get_collection_links
)
from config.logging_config import setup_logging
from database.connection import get_db
from repositories.planned_transaction_repository import PlannedTransactionRepository
from services.planned_transaction_service import PlannedTransactionService

router = APIRouter(prefix="/api/planned-transactions", tags=["planned-transactions"])
logger = setup_logging(__name__)


@router.options("", response_model=OptionsResponse,
                description="Discover available methods on planned transactions collection endpoint")
async def planned_transactions_collection_options(
        request: Request,
        limit: int = Query(50, ge=1, le=5000, description="Maximum number of planned transactions to return"),
        offset: int = Query(0, ge=0, description="Number of planned transactions to skip for pagination"),
        start_date: Optional[str] = Query(None, description="Start date filter (YYYY-MM-DD)"),
        end_date: Optional[str] = Query(None, description="End date filter (YYYY-MM-DD)"),
        bank_account: Optional[str] = Query(None, description="Filter by partial bank account match"),
        category_id: Optional[int] = Query(None, description="Filter by category ID"),
        recipient_id: Optional[int] = Query(None, description="Filter by recipient ID"),
        is_recurring: Optional[bool] = Query(None, description="Filter by recurring status"),
        is_executed: Optional[bool] = Query(None, description="Filter by execution status"),
        active: bool = Query(True, description="Filter by active status")
):
    """
    OPTIONS method for planned transactions collection endpoint discovery.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve all planned transactions with pagination"
            ),
            MethodInfo(
                method="POST",
                description="Create a new planned transaction"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=[
            Link(
                rel="self",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/planned-transactions"),
                method="GET",
                title="List all planned transactions"
            )
        ]
    )


@router.get("", response_model=PlannedTransactionsListResponse, status_code=200,
            description="Retrieves all planned transactions.")
async def get_planned_transactions(
        limit: int = Query(50, ge=1, le=5000, description="Maximum number of planned transactions to return"),
        offset: int = Query(0, ge=0, description="Number of planned transactions to skip for pagination"),
        start_date: Optional[str] = Query(None, description="Start date filter (YYYY-MM-DD)"),
        end_date: Optional[str] = Query(None, description="End date filter (YYYY-MM-DD)"),
        bank_account: Optional[str] = Query(None,
                                            description="Filter by partial bank account match (case-insensitive)"),
        category_id: Optional[int] = Query(None, description="Filter by category ID"),
        recipient_id: Optional[int] = Query(None, description="Filter by recipient ID"),
        is_recurring: Optional[bool] = Query(None, description="Filter by recurring status"),
        is_executed: Optional[bool] = Query(None, description="Filter by execution status"),
        active: bool = Query(True, description="Filter by active status. True for active only, False for all"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get planned transactions with pagination, filtering, and HATEOAS links.

    Retrieves a paginated and optionally filtered list of planned transactions.

    Returns:
        PlannedTransactionsListResponse: Paginated planned transactions list with HATEOAS links.
    """
    try:
        # Parse date filters
        start_date_obj = None
        end_date_obj = None
        if start_date and start_date.strip():
            try:
                start_date_obj = date.fromisoformat(start_date)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid start_date format: {start_date}. Use YYYY-MM-DD")

        if end_date and end_date.strip():
            try:
                end_date_obj = date.fromisoformat(end_date)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid end_date format: {end_date}. Use YYYY-MM-DD")

        # Query planned transactions
        repo = PlannedTransactionRepository(db)
        planned_transactions, total = repo.get_all(
            limit=limit,
            offset=offset,
            start_date=start_date_obj,
            end_date=end_date_obj,
            bank_account=bank_account,
            category_id=category_id,
            recipient_id=recipient_id,
            is_recurring=is_recurring,
            is_executed=is_executed,
            active=active
        )

        # Convert to response models
        items = []
        for pt in planned_transactions:
            pt.links = get_resource_links(
                request=request,
                resource_type="planned-transactions",
                resource_id=pt.id
            )
            response = PlannedTransactionResponse.model_validate(pt)
            response.execution_count = len(pt.executions) if pt.executions else 0
            items.append(response)

        # Collection links
        collection_links = get_collection_links(
            request=request,
            resource_type="planned-transactions",
            limit=limit,
            offset=offset,
            total=total
        )

        return PlannedTransactionsListResponse(
            items=items,
            total=total,
            limit=limit,
            offset=offset,
            links=collection_links
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving planned transactions: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to retrieve planned transactions: {str(e)}")


@router.post("", response_model=PlannedTransactionResponse, status_code=201,
             description="Creates a new planned transaction.")
async def create_planned_transaction(
        planned_transaction_data: PlannedTransactionCreate = Body(...),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Create a new planned transaction.

    Returns:
        PlannedTransactionResponse: Created planned transaction with HATEOAS links.
    """
    try:
        service = PlannedTransactionService(db)

        # Create planned transaction
        planned_transaction = service.create(
            planned_date=planned_transaction_data.planned_date,
            bank_account=planned_transaction_data.bank_account,
            recipient_id=planned_transaction_data.recipient_id,
            amount=planned_transaction_data.amount,
            memo=planned_transaction_data.memo,
            currency=planned_transaction_data.currency,
            category_id=planned_transaction_data.category_id,
            comment=planned_transaction_data.comment,
            is_recurring=planned_transaction_data.is_recurring,
            recurrence_pattern=planned_transaction_data.recurrence_pattern
        )

        # Generate HATEOAS links
        planned_transaction.links = get_resource_links(
            request=request,
            resource_type="planned-transactions",
            resource_id=planned_transaction.id
        )

        return PlannedTransactionResponse.model_validate(planned_transaction)

    except ValueError as e:
        logger.error(f"Validation error creating planned transaction: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating planned transaction: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create planned transaction: {str(e)}")


@router.options("/{plannedTransactionId}", response_model=OptionsResponse,
                description="Discover available methods on planned transaction resource endpoint")
async def planned_transaction_resource_options(
        plannedTransactionId: int = Path(..., description="Planned transaction ID", ge=1),
        request: Request = None
):
    """
    OPTIONS method for planned transaction resource endpoint discovery.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve planned transaction by ID"
            ),
            MethodInfo(
                method="PATCH",
                description="Update planned transaction"
            ),
            MethodInfo(
                method="DELETE",
                description="Delete planned transaction"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=[
            Link(
                rel="self",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/planned-transactions/{plannedTransactionId}"),
                method="GET",
                title="Get this planned transaction"
            ),
            Link(
                rel="parent",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/planned-transactions"),
                method="GET",
                title="List all planned transactions"
            )
        ]
    )


@router.get("/{plannedTransactionId}", response_model=PlannedTransactionResponse, status_code=200,
            description="Retrieves a planned transaction by ID.")
async def get_planned_transaction(
        plannedTransactionId: int = Path(..., description="Planned transaction ID", ge=1),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get a planned transaction by ID.

    Returns:
        PlannedTransactionResponse: Planned transaction with HATEOAS links.
    """
    try:
        repo = PlannedTransactionRepository(db)
        planned_transaction = repo.get_by_id(plannedTransactionId)

        if not planned_transaction:
            raise HTTPException(status_code=404, detail=f"Planned transaction {plannedTransactionId} not found")

        # Generate HATEOAS links
        planned_transaction.links = get_resource_links(
            request=request,
            resource_type="planned-transactions",
            resource_id=planned_transaction.id
        )

        response = PlannedTransactionResponse.model_validate(planned_transaction)
        response.execution_count = len(planned_transaction.executions) if planned_transaction.executions else 0

        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving planned transaction {plannedTransactionId}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to retrieve planned transaction: {str(e)}")


@router.patch("/{plannedTransactionId}", response_model=PlannedTransactionResponse, status_code=200,
              description="Updates a planned transaction.")
async def update_planned_transaction(
        plannedTransactionId: int = Path(..., description="Planned transaction ID", ge=1),
        update_data: PlannedTransactionUpdate = Body(...),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Update a planned transaction.

    Returns:
        PlannedTransactionResponse: Updated planned transaction with HATEOAS links.
    """
    try:
        repo = PlannedTransactionRepository(db)
        planned_transaction = repo.get_by_id(plannedTransactionId)

        if not planned_transaction:
            raise HTTPException(status_code=404, detail=f"Planned transaction {plannedTransactionId} not found")

        # Update fields if provided
        update_fields = update_data.model_dump(exclude_unset=True)

        # Handle recipient_name resolution
        if "recipient_name" in update_fields and update_fields["recipient_name"]:
            from repositories.recipient_repository import RecipientRepository
            recipient_repo = RecipientRepository(db)
            recipient = recipient_repo.get_by_name(update_fields["recipient_name"])
            if recipient:
                update_fields["recipient_id"] = recipient.id
            del update_fields["recipient_name"]

        # Handle category_name resolution
        if "category_name" in update_fields and update_fields["category_name"]:
            from repositories.category_repository import CategoryRepository
            from services.text_normalization_service import TextNormalizationService
            category_repo = CategoryRepository(db)
            parts = update_fields["category_name"].split(":")
            if len(parts) == 2:
                # Normalize category names to uppercase for lookup
                general_normalized = TextNormalizationService.normalize_category_name(parts[0])
                detail_normalized = TextNormalizationService.normalize_category_name(parts[1])
                category = category_repo.get_by_general_detail(general_normalized, detail_normalized)
                if category:
                    update_fields["category_id"] = category.id
            del update_fields["category_name"]

        # Apply updates
        for field, value in update_fields.items():
            setattr(planned_transaction, field, value)

        # Save changes
        updated = repo.update(planned_transaction)

        # Generate HATEOAS links
        updated.links = get_resource_links(
            request=request,
            resource_type="planned-transactions",
            resource_id=updated.id
        )

        return PlannedTransactionResponse.model_validate(updated)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating planned transaction {plannedTransactionId}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update planned transaction: {str(e)}")


@router.post("/{plannedTransactionId}/execute", response_model=PlannedTransactionResponse, status_code=200,
             description="Execute a planned transaction by linking it to an actual transaction.")
async def execute_planned_transaction(
        plannedTransactionId: int = Path(..., description="Planned transaction ID", ge=1),
        execute_data: PlannedTransactionExecuteRequest = Body(...),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Execute a planned transaction by linking it to an actual transaction.

    For one-time transactions: marks as executed permanently.
    For recurring transactions: creates execution record, resets is_executed to False,
    and updates planned_date to the next occurrence based on recurrence_pattern.

    Returns:
        PlannedTransactionResponse: Updated planned transaction with HATEOAS links.
    """
    try:
        service = PlannedTransactionService(db)

        # Execute the planned transaction
        updated = service.execute_planned_transaction(
            planned_transaction_id=plannedTransactionId,
            executed_transaction_id=execute_data.executed_transaction_id,
            execution_date=execute_data.execution_date
        )

        if not updated:
            raise HTTPException(status_code=404, detail=f"Planned transaction {plannedTransactionId} not found")

        # Refresh to get executions relationship
        db.refresh(updated)

        # Generate HATEOAS links
        updated.links = get_resource_links(
            request=request,
            resource_type="planned-transactions",
            resource_id=updated.id
        )

        # Add execution count and executions to response
        response_data = PlannedTransactionResponse.model_validate(updated)
        response_data.execution_count = len(updated.executions) if updated.executions else 0

        return response_data

    except HTTPException:
        raise
    except ValueError as e:
        # ValidationError from service
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error executing planned transaction {plannedTransactionId}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to execute planned transaction: {str(e)}")


@router.delete("/{plannedTransactionId}", response_model=MessageResponse, status_code=200,
               description="Deletes a planned transaction permanently.")
async def delete_planned_transaction(
        plannedTransactionId: int = Path(..., description="Planned transaction ID", ge=1),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Delete a planned transaction permanently.

    Returns:
        MessageResponse: Confirmation message with HATEOAS links.
    """
    try:
        service = PlannedTransactionService(db)
        success = service.delete_planned_transaction(plannedTransactionId, soft=False)

        if not success:
            raise HTTPException(status_code=404, detail=f"Planned transaction {plannedTransactionId} not found")

        # Generate HATEOAS links
        links = get_collection_links(
            request=request,
            resource_type="planned-transactions",
            limit=50,
            offset=0,
            total=0
        )

        return MessageResponse(
            message=f"Planned transaction {plannedTransactionId} deleted successfully",
            links=links
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting planned transaction {plannedTransactionId}: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete planned transaction: {str(e)}")
