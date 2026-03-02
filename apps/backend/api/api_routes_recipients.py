"""
API routes for recipient management.

Handles all recipient-related endpoints with Level 3 REST API (HATEOAS) support.
Provides CRUD operations for financial transaction recipients with proper
validation and response models.

See docs/HTTP_PARAMETER_USAGE_GUIDELINES.md for comprehensive parameter usage patterns.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.params import Path, Body
from pydantic import HttpUrl
from sqlalchemy.orm import Session

from api.api_schemas import (
    RecipientResponse, RecipientsListResponse,
    RecipientBase, RecipientUpdate, MessageResponse, OptionsResponse,
    MethodInfo, Link
)
from apps.backend.services.hateoas_links import hateoas_service
from config.logging_config import setup_logging
from database.connection import get_db
from services.recipient_service import RecipientService

router = APIRouter(prefix="/api/recipients", tags=["recipients"])
logger = setup_logging(__name__)


@router.options("", response_model=OptionsResponse,
                description="Discover available methods on recipients collection endpoint")
async def recipients_collection_options(
        request: Request,
        limit: int = Query(50, ge=1, le=1000, description="Maximum number of recipients to return"),
        offset: int = Query(0, ge=0, description="Number of recipients to skip for pagination"),
        name: Optional[str] = Query(None, description="Filter by partial name match"),
        default_category_id: Optional[int] = Query(None, description="Filter by default category ID"),
        active: bool = Query(True, description="Filter by active status")
):
    """
    OPTIONS method for recipients collection endpoint discovery.

    Allows clients to discover what HTTP methods are available on the recipients collection endpoint.
    Accepts same query parameters as GET endpoint to support CORS preflight requests with query strings.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve all recipients with pagination"
            ),
            MethodInfo(
                method="POST",
                description="Create a new recipient"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=[
            Link(
                rel="self",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/recipients"),
                method="GET",
                title="List all recipients"
            )
        ]
    )


@router.get("", response_model=RecipientsListResponse, status_code=200, description="Retrieves all recipients.")
async def get_recipients(
        limit: int = Query(50, ge=1, le=1000, description="Maximum number of recipients to return"),
        offset: int = Query(0, ge=0, description="Number of recipients to skip for pagination"),
        name: Optional[str] = Query(None, description="Filter by partial name match (case-insensitive)"),
        default_category_id: Optional[int] = Query(None, description="Filter by default category ID"),
        active: bool = Query(True, description="Filter by active status. True for active only, False for all"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get recipients with pagination, filtering, and HATEOAS links.

    Retrieves a paginated and optionally filtered list of recipients with links to available actions.
    Supports filtering by name and default category for flexible recipient discovery.

    **Recipient Storage and Display:**
    Recipient names are always stored and displayed in UPPERCASE for consistency. Users can input
    recipient names in any case, but they will be automatically normalised to uppercase.

    Args:
        limit (int): Maximum number of recipients to return (1-1000). Defaults to 50.
        offset (int): Number of recipients to skip before returning results. Defaults to 0.
        name (Optional[str]): Filter by partial name match (case-insensitive).
        default_category_id (Optional[int]): Filter by exact default category ID.
        active (bool): Filter by active status. True for active only, False for all. Defaults to True.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        RecipientsListResponse: Paginated and filtered recipients list with HATEOAS links.
        All recipient names will be in UPPERCASE regardless of input case.

    Raises:
        HTTPException: 500 error if retrieval fails.

    Example:
        # Get all active recipients (all names returned in UPPERCASE)
        GET /api/recipients

        # Get all recipients including inactive ones
        GET /api/recipients?active=false

        # Filter by name (case-insensitive input, UPPERCASE results)
        GET /api/recipients?name=john  # Finds recipients with "JOHN"

        # Combined with pagination and active filter
        GET /api/recipients?name=smith&limit=10&offset=0&active=true

        # Filter by default category
        GET /api/recipients?default_category_id=5
    """
    try:
        service = RecipientService(db)
        recipients = service.get_all(
            limit=limit,
            offset=offset,
            name=name,
            default_category_id=default_category_id,
            active=active
        )

        # Use filtered count when filters are applied, otherwise use total count
        if name or default_category_id:
            total = service.get_filtered_count(name, default_category_id, active)
        else:
            total = service.get_total_count(active)

        logger.info(
            "Retrieved recipients successfully",
            extra={
                "operation": "get_recipients",
                "resource_type": "recipients",
                "count": len(recipients),
                "offset": offset,
                "limit": limit,
                "total": total,
                "active_filter": active,
                "filters": {
                    "name": name,
                    "default_category_id": default_category_id
                }
            }
        )

        for recipient in recipients:
            recipient.links = hateoas_service.get_resource_links(request, "recipients", recipient.id)

        return RecipientsListResponse(
            items=[RecipientResponse.model_validate(r) for r in recipients],
            total=total,
            limit=limit,
            offset=offset,
            links=hateoas_service.get_collection_links(
                request, "recipients", limit, offset, total,
                name=name,
                default_category_id=default_category_id, active=active
            )
        )
    except Exception as e:
        logger.error(
            "Failed to retrieve recipients",
            extra={
                "operation": "get_recipients",
                "resource_type": "recipients",
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error retrieving recipients")


@router.post("", response_model=RecipientResponse, status_code=201, description="Creates a new recipient.")
async def create_or_get_recipient(
        recipient: RecipientBase = Body(...,
                                        description="Recipient creation data including name, account number, address, and optional notes."),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Create a new recipient or return an existing one with HATEOAS links.

    Creates a new recipient with the specified name, account number, and address. If a recipient
    with the same name already exists, returns the existing recipient.

    **Recipient Normalisation:**
    Recipient names are automatically normalised to UPPERCASE for consistency.
    Input can be provided in any case.

    Args:
        recipient (RecipientBase): Recipient creation data including name and notes.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        RecipientResponse: The created or existing recipient with HATEOAS links.
        Recipient names will be normalised to UPPERCASE in the response.

    Raises:
        HTTPException: 400 error for validation errors.
        HTTPException: 500 error if creation fails.

    Example:
        POST /api/recipients
        Content-Type: application/json

        {
            "name": "john smith",         // Will be stored as "JOHN SMITH"
            "notes": "Regular client"
        }

        Response:
        {
            "id": 1,
            "name": "JOHN SMITH",         // Always returned in UPPERCASE
            "notes": "Regular client",
            ...
        }

    Note:
        Requires testing: TODO duplicate handling, HATEOAS links, validation errors
    """
    try:
        service = RecipientService(db)
        new_recipient, created = service.create_or_get_recipient(
            name=recipient.name
        )

        # Update additional fields if provided (category and notes)
        if recipient.default_category_id is not None or recipient.notes is not None:
            new_recipient = service.update(
                recipient_id=new_recipient.id,
                default_category_id=recipient.default_category_id,
                notes=recipient.notes
            )

        new_recipient.links = hateoas_service.get_resource_links(request, "recipients", new_recipient.id)

        response = RecipientResponse.model_validate(new_recipient)

        # Use different status codes based on whether recipient was created
        from fastapi import Response as FastAPIResponse
        return FastAPIResponse(
            content=response.model_dump_json(),
            status_code=201 if created else 200,
            media_type="application/json"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(
            "Failed to create recipient",
            extra={
                "operation": "create_recipient",
                "resource_type": "recipient",
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error creating recipient")


@router.options("/{recipient_id}", response_model=OptionsResponse,
                description="Discover available methods on individual recipient endpoint")
async def recipient_resource_options(
        recipient_id: int = Path(ge=1, description="The ID of the recipient"),
        request: Request = None
):
    """
    OPTIONS method for individual recipient resource endpoint discovery.

    Allows clients to discover what HTTP methods are available on a specific recipient resource.

    Args:
        recipient_id (int): The ID of the recipient.
        request (Request): Request object for generating absolute URLs.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve a specific recipient by ID"
            ),
            MethodInfo(
                method="PATCH",
                description="Update a recipient"
            ),
            MethodInfo(
                method="DELETE",
                description="Delete a recipient"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=hateoas_service.get_resource_links(request, "recipients", recipient_id)
    )


@router.get("/{recipient_id}", response_model=RecipientResponse, status_code=200,
            description="Retrieves a specific recipient by ID.")
async def get_recipient(
        recipient_id: int = Path(ge=1, description="The ID of the recipient to retrieve"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get a specific recipient by ID with HATEOAS links.

    Retrieves detailed information for a single recipient identified by its ID.

    Args:
        recipient_id (int): The ID of the recipient to retrieve.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        RecipientResponse: The requested recipient details with HATEOAS links.

    Raises:
        HTTPException: 404 error if recipient not found.
        HTTPException: 500 error if retrieval fails.
    """
    try:
        service = RecipientService(db)
        recipient = service.get_by_id(recipient_id)
        if not recipient:
            raise HTTPException(status_code=404, detail="Recipient not found")
        recipient.links = hateoas_service.get_resource_links(request, "recipients", recipient.id)
        return RecipientResponse.model_validate(recipient)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to retrieve recipient",
            extra={
                "operation": "get_recipient",
                "resource_type": "recipient",
                "resource_id": recipient_id,
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error retrieving recipient")


@router.patch("/{recipient_id}", response_model=RecipientResponse, status_code=200, description="Updates a recipient.")
async def update_recipient(
        recipient_update: RecipientUpdate = Body(description="Updated recipient data."),
        recipient_id: int = Path(ge=1, description="The ID of the recipient to update"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Partially update an existing recipient with HATEOAS links.

    Updates the specified recipient with any provided values for name,
    category_id, notes, and/or is_active status.

    Args:
        recipient_id (int): The ID of the recipient to update.
        recipient_update (RecipientUpdate): Updated recipient data.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        RecipientResponse: The updated recipient with HATEOAS links.

    Raises:
        HTTPException: 404 error if recipient not found.
        HTTPException: 500 error if update fails.

    Note:
        Requires testing: TODO partial updates, not found scenarios, HATEOAS links
    """
    try:
        # Get only the fields that were actually set in the request
        update_data = recipient_update.model_dump(exclude_unset=True)

        logger.info(
            "Received recipient update request",
            extra={
                "operation": "update_recipient",
                "resource_type": "recipient",
                "resource_id": recipient_id,
                "update_data": update_data
            }
        )

        service = RecipientService(db)
        recipient = service.update(
            recipient_id=recipient_id,
            name=update_data.get('name'),
            default_category_id=update_data.get('default_category_id'),
            notes=update_data.get('notes'),
            is_active=update_data.get('is_active')
        )
        if not recipient:
            raise HTTPException(status_code=404, detail="Recipient not found")
        db.commit()
        recipient.links = hateoas_service.get_resource_links(request, "recipients", recipient.id)
        return RecipientResponse.model_validate(recipient)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to update recipient",
            extra={
                "operation": "update_recipient",
                "resource_type": "recipient",
                "resource_id": recipient_id,
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error updating recipient")


@router.delete("/{recipient_id}", response_model=MessageResponse, status_code=200, description="Deletes a recipient.")
async def delete_recipient(
        recipient_id: int = Path(ge=1, description="The ID of the recipient to delete"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Delete a recipient permanently with HATEOAS links in response.

    Performs a hard delete by permanently removing the recipient from the database.
    To deactivate a recipient instead, use PATCH to set is_active to false.

    This is a Level 3 REST API endpoint that returns hypermedia links.

    Args:
        recipient_id (int): The ID of the recipient to delete.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        MessageResponse: Success message confirming deletion with HATEOAS links to next actions.

    Raises:
        HTTPException: 404 error if recipient not found.
        HTTPException: 500 error if deletion fails.

    Note:
        Use PATCH with is_active=false to deactivate instead of permanently deleting.
    """
    try:
        service = RecipientService(db)
        if not service.hard_delete(recipient_id):
            raise HTTPException(status_code=404, detail="Recipient not found")

        return MessageResponse(
            message="Recipient deleted permanently",
            details={"method": "hard delete"},
            links=hateoas_service.get_deletion_response_links(request, "recipients")
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to delete recipient",
            extra={
                "operation": "delete_recipient",
                "resource_type": "recipient",
                "resource_id": recipient_id,
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error deleting recipient")
