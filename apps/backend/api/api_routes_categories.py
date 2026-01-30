"""
API routes for category management.

Handles all category-related endpoints with Level 3 REST API (HATEOAS) support.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.params import Path
from sqlalchemy.orm import Session

from api.api_schemas import (
    CategoryResponse, CategoriesListResponse,
    AssignCategoryRequest, AssignCategoryResponse, CategoryBase, CategoryUpdate, MessageResponse, OptionsResponse,
    MethodInfo, Link
)
from api.hateoas_links import (
    get_resource_links, get_pagination_links, get_deletion_response_links
)
from config.logging_config import setup_logging
from database.connection import get_db
from services.category_service import CategoryService

router = APIRouter(prefix="/api/categories", tags=["categories"])
logger = setup_logging(__name__)


@router.options("", response_model=OptionsResponse,
                description="Discover available methods on categories collection endpoint")
async def categories_collection_options(request: Request):
    """
    OPTIONS method for categories collection endpoint discovery.

    Allows clients to discover what HTTP methods are available on the categories collection endpoint.

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
            )
        ],
        links=[
            Link(
                rel="self",
                href=f"{str(request.base_url).rstrip('/')}/api/categories",
                method="GET",
                title="List all categories"
            )
        ]
    )


@router.get("", response_model=CategoriesListResponse, status_code=200, description="Retrieves all categories.")
async def get_categories(
        limit: int = Query(50, ge=1, le=1000, description="Maximum number of categories to return"),
        offset: int = Query(0, ge=0, description="Number of categories to skip for pagination"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get categories with pagination and HATEOAS links.

    Retrieves a paginated list of categories with links to available actions.

    Args:
        limit (int): Maximum number of categories to return (1-1000). Defaults to 50.
        offset (int): Number of categories to skip before returning results. Defaults to 0.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        CategoriesListResponse: Paginated categories list with HATEOAS links.

    Raises:
        HTTPException: 500 error if retrieval fails.
    """
    try:
        service = CategoryService(db)
        categories = service.get_all_flat(limit=limit, offset=offset)
        total = service.get_total_count()

        logger.info(f"Retrieved {len(categories)} categories (offset={offset}, limit={limit})")

        return CategoriesListResponse(
            items=[CategoryResponse.model_validate(c) for c in categories],
            total=total,
            limit=limit,
            offset=offset,
            links=get_pagination_links(request, "/api/categories", limit, offset, total)
        )
    except Exception as e:
        logger.error(f"Error retrieving categories: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving categories")


@router.post("", response_model=CategoryResponse, status_code=201, description="Creates a new category.")
async def create_or_get_category(
        category: CategoryBase,
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Create a new category or return an existing one with HATEOAS links.

    Creates a new category with the specified general and detail names. If a category
    with the same general:detail combination already exists, returns the existing category.

    Args:
        category (CategoryBase): Category creation data including general, detail,
            description, and colour.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The created or existing category with HATEOAS links.

    Raises:
        HTTPException: 400 error for validation errors.
        HTTPException: 500 error if creation fails.
    """
    try:
        service = CategoryService(db)
        new_category = service.create_or_get_category(
            general=category.general,
            detail=category.detail,
            description=category.description,
            color=category.color
        )
        return CategoryResponse(
            **CategoryResponse.model_validate(new_category).model_dump(),
            links=get_resource_links(request, "categories", new_category.id)
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error creating category: {str(e)}")
        raise HTTPException(status_code=500, detail="Error creating category")


@router.options("/{category_id}", response_model=OptionsResponse,
                description="Discover available methods on individual category endpoint")
async def category_resource_options(
        category_id: int = Path(..., ge=1, description="The ID of the category"),
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
            )
        ],
        links=get_resource_links(request, "categories", category_id)
    )


@router.get("/{category_id}", response_model=CategoryResponse, status_code=200,
            description="Retrieves a specific category by ID.")
async def get_category(
        category_id: int = Path(..., ge=1, description="The ID of the category to retrieve"),
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
        return CategoryResponse(
            **CategoryResponse.model_validate(category).model_dump(),
            links=get_resource_links(request, "categories", category_id)
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving category {category_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving category")


@router.patch("/{category_id}", response_model=CategoryResponse, status_code=200, description="Updates a category.")
async def update_category(
        category_update: CategoryUpdate,
        category_id: int = Path(..., ge=1, description="The ID of the category to update"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Partially update an existing category with HATEOAS links.

    Updates the specified category with any provided values for general, detail,
    description, and/or colour.

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
    """
    try:
        service = CategoryService(db)
        category = service.update(
            category_id=category_id,
            general=category_update.general,
            detail=category_update.detail,
            description=category_update.description,
            color=category_update.color
        )
        if not category:
            raise HTTPException(status_code=404, detail="Category not found")
        return CategoryResponse(
            **CategoryResponse.model_validate(category).model_dump(),
            links=get_resource_links(request, "categories", category_id)
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating category {category_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error updating category")


@router.delete("/{category_id}", response_model=MessageResponse, status_code=200, description="Deletes a category.")
async def delete_category(
        category_id: int = Path(..., ge=1, description="The ID of the category to delete"),
        soft: bool = Query(True, description="Perform a soft delete or not"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Delete a category with HATEOAS links in response.

    Performs a soft delete by marking the category as inactive rather than removing
    it from the database. This is the default behaviour. Response includes HATEOAS
    links for available next actions.

    This is a Level 3 REST API endpoint that returns hypermedia links.

    Args:
        category_id (int): The ID of the category to delete.
        soft (bool): Whether to perform a soft delete (True) or hard delete (False).
            Defaults to True (soft delete).
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        MessageResponse: Success message confirming deletion with HATEOAS links to next actions.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if deletion fails.
    """
    try:
        service = CategoryService(db)
        if soft:
            if not service.soft_delete(category_id):
                raise HTTPException(status_code=404, detail="Category not found")
        else:
            if not service.hard_delete(category_id):
                raise HTTPException(status_code=404, detail="Category not found")

        return MessageResponse(
            message="Category deleted successfully",
            details={"method": "soft delete" if soft else "hard delete"},
            links=get_deletion_response_links(request, "categories")
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting category {category_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error deleting category")


@router.options("/assign", response_model=OptionsResponse,
                description="Discover available methods on category assign endpoint")
async def assign_category_options(request: Request):
    """
    OPTIONS method for category assign endpoint discovery.

    Allows clients to discover what HTTP methods are available on the category assign endpoint.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    base_url = str(request.base_url).rstrip('/')
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="POST",
                description="Assign a category to one or many recipients"
            )
        ],
        links=[
            Link(
                rel="self",
                href=f"{base_url}/api/categories/assign",
                method="POST",
                title="Assign category to recipients"
            ),
            Link(
                rel="categories",
                href=f"{base_url}/api/categories",
                method="GET",
                title="List all categories"
            )
        ]
    )


@router.post("/assign", response_model=AssignCategoryResponse, status_code=200,
             description="Assign category to one or many recipients.")
async def assign_category(
        assignment_request: AssignCategoryRequest,
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
                    href=f"{base_url}/api/categories/{category.id}",
                    method="GET",
                    title="Get the assigned category"
                ),
                Link(
                    rel="categories_list",
                    href=f"{base_url}/api/categories",
                    method="GET",
                    title="Get all categories"
                )
            ]
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error assigning category: {str(e)}")
        raise HTTPException(status_code=500, detail="Error assigning category")


@router.options("/path/{general}/{detail}", response_model=OptionsResponse,
                description="Discover available methods on category path endpoint")
async def category_path_options(
        general: str = Path(..., description="General name"),
        detail: str = Path(..., description="Detail name"),
        request: Request = None
):
    """
    OPTIONS method for category path endpoint discovery.

    Allows clients to discover what HTTP methods are available on a category accessed by path.

    Args:
        general (str): General name of the category.
        detail (str): Detail name of the category.
        request (Request): Request object for generating absolute URLs.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    base_url = str(request.base_url).rstrip('/')
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve a specific category by General:Detail path"
            )
        ],
        links=[
            Link(
                rel="self",
                href=f"{base_url}/api/categories/path/{general}/{detail}",
                method="GET",
                title="Get this category by path"
            ),
            Link(
                rel="categories",
                href=f"{base_url}/api/categories",
                method="GET",
                title="List all categories"
            )
        ]
    )


@router.get("/path/{general}/{detail}", response_model=CategoryResponse,
            description="Retrieves a specific category by General:Detail path.")
async def get_category_by_path(
        general: str = Path(..., description="General name"),
        detail: str = Path(..., description="Detail name"),
        request: Request = None,
        db: Session = Depends(get_db)
):
    """Get a category by General:Detail path with HATEOAS links.

    Retrieves a category based on its general and detail names. Response includes
    HATEOAS links for available actions.

    This is a Level 3 REST API endpoint that returns hypermedia links.

    Args:
        general (str): General name of the category.
        detail (str): Detail name of the category.
        request (Request): Request object for generating absolute URLs.
        db (Session): Database session dependency.

    Returns:
        CategoryResponse: The requested category details with HATEOAS links.

    Raises:
        HTTPException: 404 error if category not found.
        HTTPException: 500 error if retrieval fails.
    """
    try:
        service = CategoryService(db)
        category = service.get_by_general_detail(general, detail)
        if not category:
            raise HTTPException(status_code=404, detail="Category not found")
        return CategoryResponse(
            **CategoryResponse.model_validate(category).model_dump(),
            links=get_resource_links(request, "categories", category.id)
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error retrieving category {general}:{detail}: {str(e)}")
        raise HTTPException(status_code=500, detail="Error retrieving category")
