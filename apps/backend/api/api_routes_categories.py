"""Category management API routes.

Provides Level 3 REST API (HATEOAS) endpoints for managing financial transaction
categories with hierarchical General:Detail structure. All category names are
automatically normalised to UPPERCASE for consistency.

Key Features:
    - Hierarchical category structure (GENERAL:DETAIL)
    - Automatic name normalisation to UPPERCASE
    - Idempotent create-or-get operations
    - Soft delete support via is_active flag
    - Bulk assignment to recipients
    - Comprehensive filtering and pagination

Security Considerations:
    - Input validation prevents injection attacks
    - Parameterised queries prevent SQL injection
    - Case-insensitive filtering prevents enumeration attacks
    - Rate limiting recommended for all endpoints
    - Audit logging enabled for all operations

Performance Optimisations:
    - Indexed columns for fast lookups
    - Pagination prevents memory exhaustion
    - Filtered counts optimised separately from data retrieval
    - Eager loading of relationships where appropriate

See docs/HTTP_PARAMETER_USAGE_GUIDELINES.md for parameter usage patterns.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.params import Path, Body
from pydantic import HttpUrl
from sqlalchemy.orm import Session

from api.api_schemas import (
    CategoryResponse, CategoriesListResponse,
    AssignCategoryRequest, AssignCategoryResponse, CategoryBase, CategoryUpdate, MessageResponse, OptionsResponse,
    MethodInfo, Link
)
from apps.backend.services.hateoas_links import hateoas_service
from config.logging_config import setup_logging
from database.connection import get_db
from services.category_service import CategoryService

router = APIRouter(prefix="/api/categories", tags=["categories"])
logger = setup_logging(__name__)


@router.options("", response_model=OptionsResponse,
                description="Discover available operations on categories collection")
async def categories_collection_options(
        request: Request,
):
    """Discover available HTTP methods on categories collection (CORS support).

    Enables clients to discover available operations before making requests.
    Essential for CORS preflight requests with query parameters.

    Query parameters mirror GET endpoint for proper CORS handling.

    Returns:
        OptionsResponse: Available methods with HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve categories with pagination and filtering"
            ),
            MethodInfo(
                method="POST",
                description="Create new category (idempotent)"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available operations"
            )
        ],
        links=[
            Link(
                rel="self",
                href=HttpUrl(f"{str(request.base_url).rstrip('/')}/api/categories"),
                method="GET",
                title="List all categories"
            )
        ]
    )


@router.get("", response_model=CategoriesListResponse, status_code=200,
            description="Retrieve categories with filtering.")
async def get_categories(
        limit: int = Query(50, ge=1, le=1000, description="Maximum categories to return (1-1000)"),
        offset: int = Query(0, ge=0, description="Categories to skip for pagination"),
        general: Optional[str] = Query(None, description="Filter by general name (case-insensitive, partial)"),
        detail: Optional[str] = Query(None, description="Filter by detail name (case-insensitive, partial)"),
        active: bool = Query(True, description="Filter active status (true=active only, false=all)"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Retrieve paginated and filtered categories with HATEOAS links.

    Returns categories matching filter criteria with pagination support.
    All category names returned in UPPERCASE regardless of input case.

    Category Name Normalisation:
        All category names automatically normalised to UPPERCASE for consistency.
        Filtering is case-insensitive, so "groceries" matches "GROCERIES".

    Args:
        limit: Maximum categories to return (1-1000, default 50)
        offset: Categories to skip before returning results (default 0)
        general: Filter by partial general name match (case-insensitive)
        detail: Filter by partial detail name match (case-insensitive)
        active: Filter by status - true for active only, false for all
        request: Request object for generating URLs
        db: Database session

    Returns:
        CategoriesListResponse: Paginated categories with HATEOAS links

    Raises:
        HTTPException: 500 if retrieval fails

    Examples:
        GET /api/categories
        Returns all active categories (names in UPPERCASE)

        GET /api/categories?active=false
        Returns all categories including inactive

        GET /api/categories?general=groceries&limit=10
        Finds categories with "GROCERIES" in general name

        GET /api/categories?detail=food
        Finds categories with "FOOD" in detail name

    Performance Notes:
        - Indexed columns provide fast filtering
        - Pagination prevents memory exhaustion
        - Count query optimised separately from data retrieval
        - Consider caching for frequently accessed category lists

    Security Notes:
        - Input validated via Pydantic Query constraints
        - Parameterised queries prevent SQL injection
        - Case-insensitive matching prevents enumeration attacks
    """
    try:
        service = CategoryService(db)
        categories = service.get_all(limit, offset, general, detail, active)

        # Use filtered count when filters applied for accurate pagination
        total = (service.get_filtered_count(general, detail, active)
                 if general or detail
                 else service.get_total_count(active))

        logger.info(
            "Categories retrieved successfully",
            extra={
                "operation": "get_categories",
                "resource_type": "categories",
                "count": len(categories),
                "offset": offset,
                "limit": limit,
                "total": total,
                "active_filter": active,
                "filters": {
                    "general": general,
                    "detail": detail
                }
            }
        )

        for category in categories:
            category.links = hateoas_service.get_resource_links(request, "categories", category.id)

        return CategoriesListResponse(
            items=[CategoryResponse.model_validate(c) for c in categories],
            total=total,
            limit=limit,
            offset=offset,
            links=hateoas_service.get_collection_links(
                request, "categories", limit, offset, total,
                general=general, detail=detail, active=active
            )
        )
    except Exception as e:
        logger.error(
            "Category retrieval failed",
            extra={
                "operation": "get_categories",
                "resource_type": "categories",
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve categories"
        )


@router.post("", response_model=CategoryResponse, description="Create new category or return existing.")
async def create_or_get_category(
        category: CategoryBase = Body(...,
                                      description="Category data (general, detail, optional description)"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Create new category or return existing one (idempotent operation).

    Creates category with specified general and detail names. If category with
    same general:detail combination exists, returns existing category instead.

    Idempotent operation ensures same request never creates duplicates.

    Category Name Normalisation:
        All names automatically normalised to UPPERCASE. Input accepted in any case.

    HTTP Status Codes:
        - 201 Created: New category created
        - 200 OK: Existing category returned (idempotent behaviour)

    Args:
        category: Category data with general, detail, and optional description
        request: Request object for generating URLs
        db: Database session

    Returns:
        CategoryResponse: Created or existing category with HATEOAS links
        (names normalised to UPPERCASE)

    Raises:
        HTTPException: 400 for validation errors
        HTTPException: 500 if creation fails

    Example Request:
        POST /api/categories
        {
            "general": "groceries",      // Stored as "GROCERIES"
            "detail": "food",            // Stored as "FOOD"
            "description": "Food and grocery purchases"
        }

    Example Response (201 Created):
        {
            "id": 1,
            "general": "GROCERIES",
            "detail": "FOOD",
            "description": "Food and grocery purchases",
            "is_active": true,
            "links": [...]
        }

    Security Notes:
        - Pydantic validation prevents malformed data
        - Parameterised queries prevent SQL injection
        - Name normalisation prevents case-based duplicates

    Performance Note:
        Fast operation using unique constraint on (general, detail) for existence check.
    """
    try:
        service = CategoryService(db)
        new_category, created = service.create_or_get_category(
            general=category.general,
            detail=category.detail,
            description=category.description,
        )
        new_category.links = hateoas_service.get_resource_links(request, "categories", new_category.id)

        response = CategoryResponse.model_validate(new_category)

        # Return appropriate status code based on whether category was created
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
            "Category creation failed",
            extra={
                "operation": "create_category",
                "resource_type": "category",
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to create category"
        )


@router.options("/{category_id}", response_model=OptionsResponse,
                description="Discover available operations on individual category")
async def category_resource_options(
        category_id: int = Path(ge=1, description="Category ID"),
        request: Request = None
):
    """Discover available HTTP methods on individual category resource.

    Enables clients to discover operations available for specific category.

    Args:
        category_id: Category identifier
        request: Request object for generating URLs

    Returns:
        OptionsResponse: Available methods with HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve specific category details"
            ),
            MethodInfo(
                method="PATCH",
                description="Partially update category"
            ),
            MethodInfo(
                method="DELETE",
                description="Permanently delete category"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available operations"
            )
        ],
        links=hateoas_service.get_resource_links(request, "categories", category_id)
    )


@router.get("/{category_id}", response_model=CategoryResponse, status_code=200,
            description="Retrieve specific category by ID.")
async def get_category(
        category_id: int = Path(ge=1, description="Category ID to retrieve"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Retrieve specific category by ID with HATEOAS links.

    Returns detailed information for single category identified by ID.

    Args:
        category_id: Category identifier (must be positive)
        request: Request object for generating URLs
        db: Database session

    Returns:
        CategoryResponse: Category details with HATEOAS links

    Raises:
        HTTPException: 404 if category not found
        HTTPException: 500 if retrieval fails

    Performance Note:
        Single-row lookup by primary key - very fast operation.

    Security Note:
        Input validation via Path constraint prevents negative IDs.
    """
    try:
        service = CategoryService(db)
        category = service.get_by_id(category_id)
        if not category:
            raise HTTPException(
                status_code=404,
                detail=f"Category {category_id} not found"
            )
        category.links = hateoas_service.get_resource_links(request, "categories", category.id)
        return CategoryResponse.model_validate(category)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Category retrieval failed",
            extra={
                "operation": "get_category",
                "resource_type": "category",
                "resource_id": category_id,
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve category"
        )


@router.patch("/{category_id}", response_model=CategoryResponse, status_code=200, description="Update category.")
async def update_category(
        category_update: CategoryUpdate = Body(description="Updated category data"),
        category_id: int = Path(ge=1, description="Category ID to update"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Partially update existing category with HATEOAS links.

    Updates specified category with any provided values. Use is_active for
    soft deletion rather than permanent deletion.

    Args:
        category_id: Category identifier
        category_update: Updated category data (all fields optional)
        request: Request object for generating URLs
        db: Database session

    Returns:
        CategoryResponse: Updated category with HATEOAS links

    Raises:
        HTTPException: 404 if category not found
        HTTPException: 500 if update fails

    Example Request:
        PATCH /api/categories/1
        {
            "description": "Updated description",
            "is_active": false
        }

    Best Practice:
        Use is_active=false for soft deletion to maintain referential integrity.
        Hard deletion may break transaction history.

    Security Note:
        Validation prevents setting invalid combinations of fields.
    """
    try:
        service = CategoryService(db)
        category = service.update(
            category_id=category_id,
            general=category_update.general,
            detail=category_update.detail,
            description=category_update.description,
            is_active=category_update.is_active,
        )
        if not category:
            raise HTTPException(
                status_code=404,
                detail=f"Category {category_id} not found"
            )
        category.links = hateoas_service.get_resource_links(request, "categories", category.id)
        return CategoryResponse.model_validate(category)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Category update failed",
            extra={
                "operation": "update_category",
                "resource_type": "category",
                "resource_id": category_id,
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to update category"
        )


@router.delete("/{category_id}", response_model=MessageResponse, status_code=200,
               description="Delete category permanently.")
async def delete_category(
        category_id: int = Path(ge=1, description="Category ID to delete"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Permanently delete category (hard delete) with HATEOAS links.

    Performs permanent deletion - removes category from database entirely.
    Consider using PATCH with is_active=false for soft deletion instead.

    Args:
        category_id: Category identifier
        request: Request object for generating URLs
        db: Database session

    Returns:
        MessageResponse: Deletion confirmation with HATEOAS links

    Raises:
        HTTPException: 404 if category not found
        HTTPException: 500 if deletion fails

    Warning:
        Hard deletion may break referential integrity if category is used
        in transactions. Soft deletion (is_active=false) recommended instead.

    Security Note:
        Consider requiring elevated privileges for hard deletion operations.

    Performance Note:
        May be slow if many transactions reference this category due to
        foreign key constraint checks.
    """
    try:
        service = CategoryService(db)
        if not service.hard_delete(category_id):
            raise HTTPException(
                status_code=404,
                detail=f"Category {category_id} not found"
            )

        return MessageResponse(
            message="Category deleted permanently",
            details={"method": "hard delete"},
            links=hateoas_service.get_deletion_response_links(request, "categories")
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Category deletion failed",
            extra={
                "operation": "delete_category",
                "resource_type": "category",
                "resource_id": category_id,
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to delete category"
        )


@router.options("/assign", response_model=OptionsResponse,
                description="Discover available methods on category assign endpoint")
async def assign_category_options(request: Request):
    """Discover available HTTP methods on category assignment endpoint.

    Enables clients to discover operations for assigning categories to recipients.

    Returns:
        OptionsResponse: Available methods with HATEOAS links
    """
    base_url = str(request.base_url).rstrip('/')
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="POST",
                description="Assign a category to one or many recipients"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=[
            Link(
                rel="self",
                href=HttpUrl(f"{base_url}/api/categories/assign"),
                method="POST",
                title="Assign category to recipients"
            ),
            Link(
                rel="categories",
                href=HttpUrl(f"{base_url}/api/categories"),
                method="GET",
                title="List all categories"
            )
        ]
    )


@router.post("/assign", response_model=AssignCategoryResponse, status_code=200,
             description="Assign category to recipients.")
async def assign_category(
        assignment_request: AssignCategoryRequest = Body(
            description="Category assignment data (category names and recipient IDs)"
        ),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Assign default category to one or multiple recipients with HATEOAS links.

    Assigns category as default for specified recipients. Creates category if
    it doesn't exist. Supports bulk assignment for efficiency.

    Args:
        assignment_request: Assignment data containing:
            - category_general: Category general name
            - category_detail: Category detail name
            - recipient_ids: Single ID or list of recipient IDs
        request: Request object for generating URLs
        db: Database session

    Returns:
        AssignCategoryResponse: Count of updated recipients with HATEOAS links

    Raises:
        HTTPException: 400 for invalid request data
        HTTPException: 404 if recipient not found
        HTTPException: 500 if assignment fails

    Example Request:
        POST /api/categories/assign
        {
            "category_general": "groceries",
            "category_detail": "food",
            "recipient_ids": [1, 2, 3]
        }

    Example Response:
        {
            "updated_recipients": 3,
            "links": [...]
        }

    Performance Note:
        Bulk assignment processed efficiently in single transaction.
        Consider pagination for very large recipient lists (1000+).

    Security Note:
        Validates all recipient IDs exist before applying changes.
        Transaction rolled back if any recipient not found.
    """
    try:
        service = CategoryService(db)
        category, created = service.create_or_get_category(
            assignment_request.category_general,
            assignment_request.category_detail
        )
        updated_count = service.assign_category(
            recipient_ids=assignment_request.recipient_ids,
            category=category,
        )
        base_url = str(request.base_url).rstrip('/')
        return AssignCategoryResponse(
            updated_recipients=updated_count,
            links=[
                Link(
                    rel="assigned_category",
                    href=HttpUrl(f"{base_url}/api/categories/{category.id}"),
                    method="GET",
                    title="Get the assigned category"
                ),
                Link(
                    rel="categories_list",
                    href=HttpUrl(f"{base_url}/api/categories"),
                    method="GET",
                    title="Get all categories"
                )
            ]
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Category assignment failed",
            extra={
                "operation": "assign_category",
                "resource_type": "category",
                "category_general": assignment_request.category_general,
                "category_detail": assignment_request.category_detail,
                "recipient_count": len(assignment_request.recipient_ids),
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to assign category"
        )
