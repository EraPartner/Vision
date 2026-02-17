"""
API routes for category management.

Handles all category-related endpoints with Level 3 REST API (HATEOAS) support.
Provides CRUD operations for financial transaction categories with hierarchical
General:Detail structure.

See docs/HTTP_PARAMETER_USAGE_GUIDELINES.md for comprehensive parameter usage patterns.
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
from api.hateoas_links import (
    get_resource_links, get_deletion_response_links, get_collection_links
)
from config.logging_config import setup_logging
from database.connection import get_db
from services.category_service import CategoryService

router = APIRouter(prefix="/api/categories", tags=["categories"])
logger = setup_logging(__name__)


@router.options("", response_model=OptionsResponse,
                description="Discover available methods on categories collection endpoint")
async def categories_collection_options(
        request: Request,
        limit: int = Query(50, ge=1, le=1000, description="Maximum number of categories to return"),
        offset: int = Query(0, ge=0, description="Number of categories to skip for pagination"),
        general: Optional[str] = Query(None, description="Filter by partial general name match"),
        detail: Optional[str] = Query(None, description="Filter by partial detail name match"),
        active: bool = Query(True, description="Filter by active status")
):
    """
    OPTIONS method for categories collection endpoint discovery.

    Allows clients to discover what HTTP methods are available on the categories collection endpoint.
    Accepts same query parameters as GET endpoint to support CORS preflight requests with query strings.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve all categories with pagination"
            ),
            MethodInfo(
                method="POST",
                description="Create a new category"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
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


@router.get("", response_model=CategoriesListResponse, status_code=200, description="Retrieves all categories.")
async def get_categories(
        limit: int = Query(50, ge=1, le=1000, description="Maximum number of categories to return"),
        offset: int = Query(0, ge=0, description="Number of categories to skip for pagination"),
        general: Optional[str] = Query(None, description="Filter by partial general name match (case-insensitive)"),
        detail: Optional[str] = Query(None, description="Filter by partial detail name match (case-insensitive)"),
        active: bool = Query(True, description="Filter by active status. True for active only, False for all"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get categories with pagination, filtering, and HATEOAS links.

    Retrieves a paginated and optionally filtered list of categories with links to available actions.
    Supports filtering by general and detail names, and by active status for flexible category discovery.

    **Category Storage and Display:**
    Categories are always stored and displayed in UPPERCASE for consistency. Users can input
    category names in any case, but they will be automatically normalized to uppercase.

    Args:
        limit (int): Maximum number of categories to return (1-1000). Defaults to 50.
        offset (int): Number of categories to skip before returning results. Defaults to 0.
        general (Optional[str]): Filter by partial general name match (case-insensitive).
        detail (Optional[str]): Filter by partial detail name match (case-insensitive).
        active (bool): Filter by active status. True for active only, False for all. Defaults to True.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        CategoriesListResponse: Paginated and filtered categories list with HATEOAS links.
        All category names will be in UPPERCASE regardless of input case.

    Raises:
        HTTPException: 500 error if retrieval fails.

    Example:
        # Get all active categories (all names returned in UPPERCASE)
        GET /api/categories

        # Get all categories including inactive ones
        GET /api/categories?active=false

        # Filter by general name (case-insensitive input, UPPERCASE results)
        GET /api/categories?general=groceries  # Finds categories with "GROCERIES"

        # Filter by both general and detail (case-insensitive input)
        GET /api/categories?general=groceries&detail=food  # Finds "GROCERIES:FOOD"

        # Combined with pagination and active filter
        GET /api/categories?general=groceries&limit=10&offset=0&active=true

        # Filter by detail only
        GET /api/categories?detail=beverages  # Finds categories with "BEVERAGES"
    """
    try:
        service = CategoryService(db)
        categories = service.get_all(limit, offset, general, detail, active)

        # Use filtered count when filters are applied, otherwise use total count
        if general or detail:
            total = service.get_filtered_count(general, detail, active)
        else:
            total = service.get_total_count(active)

        logger.info(
            "Retrieved categories successfully",
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
            category.links = get_resource_links(request, "categories", category.id)

        return CategoriesListResponse(
            items=[CategoryResponse.model_validate(c) for c in categories],
            total=total,
            limit=limit,
            offset=offset,
            links=get_collection_links(request, "categories", limit, offset, total, general=general, detail=detail,
                                       active=active)
        )
    except Exception as e:
        logger.error(
            "Failed to retrieve categories",
            extra={
                "operation": "get_categories",
                "resource_type": "categories",
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error retrieving categories")


@router.post("", response_model=CategoryResponse, status_code=201, description="Creates a new category.")
async def create_or_get_category(
        category: CategoryBase = Body(...,
                                      description="Category creation data including general, detail, and optional description."),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Create a new category or return an existing one with HATEOAS links.

    Creates a new category with the specified general and detail names. If a category
    with the same general:detail combination already exists, returns the existing category.

    **Category Normalization:**
    General and detail names are automatically normalized to UPPERCASE for consistency.
    Input can be provided in any case.

    Args:
        category (CategoryBase): Category creation data including general, detail,
            description.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The created or existing category with HATEOAS links.
        Category names will be normalized to UPPERCASE in the response.

    Raises:
        HTTPException: 400 error for validation errors.
        HTTPException: 500 error if creation fails.

    Example:
        POST /api/categories
        Content-Type: application/json

        {
            "general": "groceries",      // Will be stored as "GROCERIES"
            "detail": "food",            // Will be stored as "FOOD"
            "description": "Food and grocery purchases",

        Response:
        {
            "id": 1,
            "general": "GROCERIES",      // Always returned in UPPERCASE
            "detail": "FOOD",            // Always returned in UPPERCASE
            "description": "Food and grocery purchases",
            ...
        }

    Note:
        Requires testing: TODO duplicate handling, HATEOAS links, validation errors
    """
    try:
        service = CategoryService(db)
        new_category = service.create_or_get_category(
            general=category.general,
            detail=category.detail,
            description=category.description,
        )
        new_category.links = get_resource_links(request, "categories", new_category.id)

        return CategoryResponse.model_validate(new_category)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(
            "Failed to create category",
            extra={
                "operation": "create_category",
                "resource_type": "category",
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error creating category")


@router.options("/{category_id}", response_model=OptionsResponse,
                description="Discover available methods on individual category endpoint")
async def category_resource_options(
        category_id: int = Path(ge=1, description="The ID of the category"),
        request: Request = None
):
    """
    OPTIONS method for individual category resource endpoint discovery.

    Allows clients to discover what HTTP methods are available on a specific category resource.

    Args:
        category_id (int): The ID of the category.
        request (Request): Request object for generating absolute URLs.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve a specific category by ID"
            ),
            MethodInfo(
                method="PATCH",
                description="Update a category"
            ),
            MethodInfo(
                method="DELETE",
                description="Delete a category"
            ),
            MethodInfo(
                method="OPTIONS",
                description="Discover available methods on this endpoint"
            )
        ],
        links=get_resource_links(request, "categories", category_id)
    )


@router.get("/{category_id}", response_model=CategoryResponse, status_code=200,
            description="Retrieves a specific category by ID.")
async def get_category(
        category_id: int = Path(ge=1, description="The ID of the category to retrieve"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get a specific category by ID with HATEOAS links.

    Retrieves detailed information for a single category identified by its ID.

    Args:
        category_id (int): The ID of the category to retrieve.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        CategoryResponseWithLinks: The requested category details with HATEOAS links.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if retrieval fails.
    """
    try:
        service = CategoryService(db)
        category = service.get_by_id(category_id)
        if not category:
            raise HTTPException(status_code=404, detail="Category not found")
        category.links = get_resource_links(request, "categories", category.id)
        return CategoryResponse.model_validate(category)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to retrieve category",
            extra={
                "operation": "get_category",
                "resource_type": "category",
                "resource_id": category_id,
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error retrieving category")


@router.patch("/{category_id}", response_model=CategoryResponse, status_code=200, description="Updates a category.")
async def update_category(
        category_update: CategoryUpdate = Body(description="Updated category data."),
        category_id: int = Path(ge=1, description="The ID of the category to update"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Partially update an existing category with HATEOAS links.

    Updates the specified category with any provided values for general, detail,
    description, and/or is_active. Use is_active to deactivate categories instead
    of deleting them.

    Args:
        category_id (int): The ID of the category to update.
        category_update (CategoryUpdate): Updated category data.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        CategoryResponseWithLinks: The updated category with HATEOAS links.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if update fails.

    Note:
        Use is_active=false to deactivate instead of deleting permanently.
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
            raise HTTPException(status_code=404, detail="Category not found")
        category.links = get_resource_links(request, "categories", category.id)
        return CategoryResponse.model_validate(category)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to update category",
            extra={
                "operation": "update_category",
                "resource_type": "category",
                "resource_id": category_id,
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error updating category")


@router.delete("/{category_id}", response_model=MessageResponse, status_code=200, description="Deletes a category.")
async def delete_category(
        category_id: int = Path(ge=1, description="The ID of the category to delete"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Delete a category permanently with HATEOAS links in response.

    Performs a hard delete by permanently removing the category from the database.
    To deactivate a category instead, use PATCH to set is_active to false.

    This is a Level 3 REST API endpoint that returns hypermedia links.

    Args:
        category_id (int): The ID of the category to delete.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        MessageResponse: Success message confirming deletion with HATEOAS links to next actions.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if deletion fails.

    Note:
        Use PATCH with is_active=false to deactivate instead of permanently deleting.
    """
    try:
        service = CategoryService(db)
        if not service.hard_delete(category_id):
            raise HTTPException(status_code=404, detail="Category not found")

        return MessageResponse(
            message="Category deleted permanently",
            details={"method": "hard delete"},
            links=get_deletion_response_links(request, "categories")
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Failed to delete category",
            extra={
                "operation": "delete_category",
                "resource_type": "category",
                "resource_id": category_id,
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(status_code=500, detail="Error deleting category")


@router.options("/assign", response_model=OptionsResponse,
                description="Discover available methods on category assign endpoint")
async def assign_category_options(request: Request):
    """
    OPTIONS method for category assign endpoint discovery.

    Allows clients to discover what HTTP methods are available on the category assign endpoint.

    Returns:
        OptionsResponse: Available methods and HATEOAS links

    Note:
        Requires testing: TODO OPTIONS response format, HATEOAS compliance
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
             description="Assign category to one or many recipients.")
async def assign_category(
        assignment_request: AssignCategoryRequest = Body(description="Assign a category to one or many recipients."),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Assign a category to one or many recipients with HATEOAS links.

    Assigns a default category to multiple recipients. The category is created if it
    doesn't exist. Response includes HATEOAS links for available next actions.

    This is a Level 3 REST API endpoint that returns hypermedia links.

    Args:
        assignment_request (AssignCategoryRequest): Assignment request containing:
            - category_general (str): Category general name
            - category_detail (str): Category detail name
            - recipient_ids (int | list[int]): Recipient ID or list of recipient IDs
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        AssignCategoryResponse: Number of recipients updated with HATEOAS links to available actions.

    Raises:
        HTTPException: 400 error for invalid request data.
        HTTPException: 404 error if a recipient is not found.
        HTTPException: 500 error if assignment fails.

    Note:
        Requires testing: TODO bulk assignment, validation errors, HATEOAS links
    """
    try:
        service = CategoryService(db)
        category = service.create_or_get_category(assignment_request.category_general,
                                                  assignment_request.category_detail)
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
            "Failed to assign category",
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
        raise HTTPException(status_code=500, detail="Error assigning category")
